package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Terminals is the subset of the terminal use cases the HTTP API needs.
type Terminals interface {
	Open(ctx context.Context, req app.OpenTerminal) (domain.Terminal, error)
	List() []domain.Terminal
	Get(id domain.TerminalID) (domain.Terminal, error)
	Attach(id domain.TerminalID) (*app.TerminalAttachment, error)
	Write(id domain.TerminalID, p []byte) error
	Resize(id domain.TerminalID, cols, rows uint16) error
	Close(id domain.TerminalID) error
}

// listTerminals names the server run in a header: shells don't outlive it,
// so a client that knew shells of another run knows they ended with it.
func (s *server) listTerminals(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("X-Go-Chamber-Run", strconv.FormatInt(s.started.UnixNano(), 36))
	writeJSON(w, http.StatusOK, s.cfg.Terminals.List())
}

func (s *server) openTerminal(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Cwd       string           `json:"cwd"`
		SessionID domain.SessionID `json:"sessionId"`
		Cols      uint16           `json:"cols"`
		Rows      uint16           `json:"rows"`
	}
	if !decode(w, r, &body) {
		return
	}
	term, err := s.cfg.Terminals.Open(r.Context(), app.OpenTerminal{
		Cwd: body.Cwd, SessionID: body.SessionID, Cols: body.Cols, Rows: body.Rows,
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, term)
}

func (s *server) closeTerminal(w http.ResponseWriter, r *http.Request) {
	if err := s.cfg.Terminals.Close(domain.TerminalID(r.PathValue("id"))); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// terminalControl is a text frame from the client; binary frames are raw
// keyboard input.
type terminalControl struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

type terminalExit struct {
	Type string `json:"type"`
	Code int    `json:"code"`
}

// terminalPTY attaches a WebSocket to a shell: binary frames carry output
// (scrollback first) and input; text frames carry resize requests and the
// final exit message. A "ready" text frame follows the scrollback so the
// client can ignore its own answers to terminal queries replayed from it.
func (s *server) terminalPTY(w http.ResponseWriter, r *http.Request) {
	id := domain.TerminalID(r.PathValue("id"))
	att, err := s.cfg.Terminals.Attach(id)
	if err != nil {
		s.fail(w, err)
		return
	}
	defer att.Detach()
	// Compress output of at least 512 bytes when supported by the client. Each
	// message uses its own dictionary; small echoes and controls stay plain.
	c, err := acceptSameOriginCompression(w, r, websocket.CompressionNoContextTakeover)
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(1 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go s.terminalInput(ctx, cancel, c, id)

	if len(att.Scrollback) > 0 {
		if err := c.Write(ctx, websocket.MessageBinary, att.Scrollback); err != nil {
			return
		}
	}
	if err := wsjson.Write(ctx, c, terminalControl{Type: "ready"}); err != nil {
		return
	}
	for {
		select {
		case chunk, ok := <-att.Output:
			if !ok {
				s.terminalEnded(ctx, c, id, att.Lagged())
				return
			}
			if err := c.Write(ctx, websocket.MessageBinary, chunk); err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// terminalEnded tells the client why output stopped: the shell exited, the
// terminal was closed, or the client lagged and should reconnect.
func (s *server) terminalEnded(ctx context.Context, c *websocket.Conn, id domain.TerminalID, lagged bool) {
	term, err := s.cfg.Terminals.Get(id)
	switch {
	case lagged:
		_ = c.Close(websocket.StatusTryAgainLater, "lagging")
	case errors.Is(err, app.ErrTerminalNotFound):
		_ = c.Close(websocket.StatusNormalClosure, "closed")
	case err == nil && term.Status == domain.TerminalExited:
		if wsjson.Write(ctx, c, terminalExit{Type: "exit", Code: term.ExitCode}) == nil {
			_ = c.Close(websocket.StatusNormalClosure, "exited")
		}
	default:
		_ = c.Close(websocket.StatusInternalError, "terminal state unknown")
	}
}

func (s *server) terminalInput(ctx context.Context, cancel context.CancelFunc, c *websocket.Conn, id domain.TerminalID) {
	defer cancel()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			_ = s.cfg.Terminals.Write(id, data)
			continue
		}
		var ctl terminalControl
		if json.Unmarshal(data, &ctl) == nil && ctl.Type == "resize" {
			_ = s.cfg.Terminals.Resize(id, ctl.Cols, ctl.Rows)
		}
	}
}
