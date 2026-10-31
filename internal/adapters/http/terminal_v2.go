package httpapi

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type terminalV2Service interface {
	AttachClient(domain.TerminalID, string) (*app.TerminalClientAttachment, error)
	WriteInput(domain.TerminalID, string, uint64, uint64, []byte) (app.TerminalClientState, error)
	ResizeClient(domain.TerminalID, string, uint64, uint16, uint16) error
	TakeControl(domain.TerminalID, string) (app.TerminalClientState, error)
}

type terminalV2Control struct {
	InputPipeline bool   `json:"inputPipeline,omitempty"`
	PromptID      uint64 `json:"promptId,omitempty"`
	CommandID     uint64 `json:"commandId,omitempty"`
	Prompt        bool   `json:"prompt,omitempty"`
	Type          string `json:"type"`
	app.TerminalClientState
	Run      string `json:"run,omitempty"`
	Position uint64 `json:"position,omitempty"`
	Bytes    uint64 `json:"bytes,omitempty"`
	Cols     uint16 `json:"cols,omitempty"`
	Rows     uint16 `json:"rows,omitempty"`
	Code     int    `json:"code,omitempty"`
	Problem  string `json:"problem,omitempty"`
	Token    string `json:"token,omitempty"`
}

func (s *server) terminalProtocol() int {
	if p, ok := s.cfg.Terminals.(interface{ TerminalProtocol() int }); ok {
		return p.TerminalProtocol()
	}
	return 1
}

// v2Link is shared by WebSocket and the reliable ordered RTC channels. Its
// credit counts bytes processed by xterm, not bytes accepted by a transport.
type v2Link struct {
	s           *server
	service     terminalV2Service
	id          domain.TerminalID
	client      string
	att         *app.TerminalClientAttachment
	ctx         context.Context
	cancel      context.CancelFunc
	control     func(terminalV2Control) error
	output      func([]byte) error
	mu          sync.Mutex
	sent, acked uint64
	wake        chan struct{}
}

func (s *server) newV2Link(ctx context.Context, id domain.TerminalID, client string, ctl func(terminalV2Control) error, out func([]byte) error) (*v2Link, error) {
	service, ok := s.cfg.Terminals.(terminalV2Service)
	if !ok || s.terminalProtocol() != 2 {
		return nil, errors.New("terminal protocol v2 is disabled")
	}
	att, err := service.AttachClient(id, client)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	return &v2Link{s: s, service: service, id: id, client: client, att: att, ctx: ctx, cancel: cancel, control: ctl, output: out, wake: make(chan struct{}, 1)}, nil
}

func (l *v2Link) receive(data []byte, text bool) {
	if len(data) > 16<<10 {
		l.cancel()
		return
	}
	if !text {
		if len(data) < 17 || data[0] != 3 {
			l.cancel()
			return
		}
		epoch, offset, payload := binary.BigEndian.Uint64(data[1:9]), binary.BigEndian.Uint64(data[9:17]), data[17:]
		for {
			state, err := l.service.WriteInput(l.id, l.client, epoch, offset, payload)
			problem := ""
			if err != nil {
				problem = err.Error()
			}
			if l.control(terminalV2Control{Type: "inputAck", TerminalClientState: state, Problem: problem}) != nil {
				l.cancel()
				return
			}
			if err != nil || !state.Owner || state.Uncertain || state.Written <= offset || state.Written-offset >= uint64(len(payload)) {
				return
			}
			// Finish a short write before reading a later pipelined frame.
			// ACK every actual prefix; uncertain writes are never retried here.
			payload = payload[state.Written-offset:]
			offset = state.Written
		}
	}
	var c terminalV2Control
	if json.Unmarshal(data, &c) != nil {
		l.cancel()
		return
	}
	switch c.Type {
	case "ack":
		l.mu.Lock()
		valid := c.Bytes >= l.acked && c.Bytes <= l.sent
		if valid {
			l.acked = c.Bytes
			l.reportWindow()
		}
		l.mu.Unlock()
		if !valid {
			l.cancel()
			return
		}
		select {
		case l.wake <- struct{}{}:
		default:
		}
	case "take":
		if _, err := l.service.TakeControl(l.id, l.client); err != nil {
			_ = l.control(terminalV2Control{Type: "problem", Problem: err.Error()})
		}
	case "resize":
		if err := l.service.ResizeClient(l.id, l.client, c.Epoch, c.Cols, c.Rows); err != nil {
			_ = l.control(terminalV2Control{Type: "problem", Problem: err.Error()})
		}
	case "ping":
		if len(c.Token) <= 64 && l.control(terminalV2Control{Type: "pong", Token: c.Token}) != nil {
			l.cancel()
		}
	}
}

func (l *v2Link) send(kind byte, position uint64, data []byte, discardable bool) error {
	for len(data) > 0 {
		n := min(len(data), (16<<10)-9)
		for {
			l.mu.Lock()
			room := l.sent-l.acked+uint64(n) <= 64<<10
			if room {
				l.sent += uint64(n)
				l.reportWindow()
			}
			l.mu.Unlock()
			if room {
				break
			}
			select {
			case <-l.ctx.Done():
				return l.ctx.Err()
			case <-l.wake:
			}
		}
		if discardable && l.att.ResyncPending != nil && l.att.ResyncPending() {
			l.mu.Lock()
			l.sent -= uint64(n)
			l.reportWindow()
			l.mu.Unlock()
			return nil
		}
		b := make([]byte, 9+n)
		b[0] = kind
		binary.BigEndian.PutUint64(b[1:9], position-uint64(len(data)-n))
		if kind == 2 {
			binary.BigEndian.PutUint64(b[1:9], position)
		}
		copy(b[9:], data[:n])
		if err := l.output(b); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

func (l *v2Link) snapshot(s app.TerminalScreenSnapshot) error {
	if err := l.control(terminalV2Control{Type: "snapshot", Position: s.Position, Cols: s.Cols, Rows: s.Rows, Bytes: uint64(len(s.Data)), PromptID: s.PromptID, CommandID: s.CommandID, Prompt: s.Prompt}); err != nil {
		return err
	}
	if err := l.send(2, s.Position, s.Data, false); err != nil {
		return err
	}
	return l.control(terminalV2Control{Type: "ready", Position: s.Position})
}

// Caller holds l.mu; the app callback never calls back into the link.
func (l *v2Link) reportWindow() {
	if l.att.ReportOutstanding != nil {
		l.att.ReportOutstanding(int(l.sent - l.acked))
	}
}

func (l *v2Link) run() {
	defer l.cancel()
	defer l.att.Detach()
	if l.control(terminalV2Control{Type: "hello", Run: strconv.FormatInt(l.s.started.UnixNano(), 36), TerminalClientState: l.att.State, InputPipeline: true}) != nil {
		return
	}
	go func() {
		for {
			select {
			case <-l.ctx.Done():
				return
			case state, ok := <-l.att.Updates:
				if !ok {
					return
				}
				if l.control(terminalV2Control{Type: "control", TerminalClientState: state}) != nil {
					l.cancel()
					return
				}
			}
		}
	}()
	a := l.att.Screen
	if l.snapshot(a) != nil {
		return
	}
	for {
		select {
		case <-l.ctx.Done():
			return
		case out, ok := <-l.att.Output:
			if !ok {
				term, err := l.s.cfg.Terminals.Get(l.id)
				if err == nil && term.Status == domain.TerminalExited {
					_ = l.control(terminalV2Control{Type: "exit", Code: term.ExitCode})
				} else {
					_ = l.control(terminalV2Control{Type: "closed"})
				}
				return
			}
			if out.Resync {
				if l.snapshot(app.TerminalScreenSnapshot{Data: out.Data, Position: out.Position, Cols: out.Cols, Rows: out.Rows, PromptID: out.PromptID, CommandID: out.CommandID, Prompt: out.Prompt}) != nil {
					return
				}
			} else if l.send(1, out.Position, out.Data, true) != nil {
				return
			}
			if out.PromptID > 0 && l.control(terminalV2Control{Type: "prompt", PromptID: out.PromptID, CommandID: out.CommandID, Prompt: out.Prompt}) != nil {
				return
			}
		}
	}
}

func (s *server) terminalPTYV2(w http.ResponseWriter, r *http.Request) {
	if s.terminalProtocol() != 2 {
		http.Error(w, "terminal protocol v2 is disabled", http.StatusNotFound)
		return
	}
	id := domain.TerminalID(r.PathValue("id"))
	if _, err := s.cfg.Terminals.Get(id); err != nil {
		s.fail(w, err)
		return
	}
	c, err := acceptSameOriginCompression(w, r, websocket.CompressionNoContextTakeover)
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(16 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	l, err := s.newV2Link(ctx, id, r.URL.Query().Get("client"), func(v terminalV2Control) error { return wsjson.Write(ctx, c, v) }, func(b []byte) error { return c.Write(ctx, websocket.MessageBinary, b) })
	if err != nil {
		_ = c.Close(websocket.StatusPolicyViolation, "invalid terminal client")
		return
	}
	go func() {
		defer l.cancel()
		for {
			typ, data, err := c.Read(l.ctx)
			if err != nil {
				return
			}
			l.receive(data, typ == websocket.MessageText)
		}
	}()
	l.run()
}
