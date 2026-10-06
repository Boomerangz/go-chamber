package claude

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Runtime is one `claude` process bound to a single session. It speaks
// stream-json over stdio and translates the protocol into domain events.
type Runtime struct {
	session domain.SessionID
	native  string
	mapper  *Mapper

	cmd   *exec.Cmd
	stdin io.WriteCloser

	events     chan domain.Event
	exit       chan struct{}
	readDone   chan struct{}
	stderrDone chan struct{}
	log        io.Writer

	writeMu    sync.Mutex
	reqCounter int

	controlMu sync.Mutex
	control   map[string]chan error

	modelMu sync.Mutex
	model   string
	effort  string
	// bypass is set when the process started in bypassPermissions, the only
	// way the CLI lets a session switch to it.
	bypass bool

	closeOnce sync.Once
}

// start launches the process. The CLI writes system/init only after the
// first user message, so the session id is not awaited: a resumed session
// keeps its id and a new one (or a fork) gets a fresh UUID via --session-id.
// That way the caller can persist the native id before the first turn.
func start(ctx context.Context, cfg *Factory, req app.StartRequest) (*Runtime, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	native := req.NativeID
	if native == "" || req.Fork {
		native = newSessionID()
	}
	cmd := exec.Command(cfg.binary(), cfg.argsFor(req, native)...)
	cmd.Dir = req.Cwd
	cmd.Env = append(os.Environ(), cfg.Env...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	rt := &Runtime{
		session:    req.SessionID,
		native:     native,
		mapper:     NewMapper(req.SessionID),
		cmd:        cmd,
		stdin:      stdin,
		events:     make(chan domain.Event, 256),
		exit:       make(chan struct{}),
		readDone:   make(chan struct{}),
		stderrDone: make(chan struct{}),
		log:        cfg.stderr(),
		control:    map[string]chan error{},
		model:      req.Model,
		bypass:     req.PermissionMode == "bypassPermissions",
		effort:     req.Effort,
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("claude: start %s: %w", cfg.binary(), err)
	}

	go rt.read(stdout)
	go rt.drainStderr(stderr, cfg.stderr())
	go rt.wait()
	return rt, nil
}

// newSessionID returns a random (version 4) UUID, the format --session-id
// requires.
func newSessionID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func (r *Runtime) NativeID() string            { return r.native }
func (r *Runtime) Events() <-chan domain.Event { return r.events }

// Send writes one stream-json user message and starts a turn.
func (r *Runtime) Send(_ context.Context, turn domain.TurnID, text string) error {
	r.mapper.SetTurn(turn)
	return r.sendUser(text)
}

// Steer appends a user message to the running turn; the CLI folds it in.
func (r *Runtime) Steer(_ context.Context, text string) error {
	return r.sendUser(text)
}

func (r *Runtime) sendUser(text string) error {
	return r.sendContent([]any{map[string]string{"type": "text", "text": text}})
}

func (r *Runtime) sendContent(content []any) error {
	line, err := json.Marshal(map[string]any{
		"type":    "user",
		"message": map[string]any{"role": "user", "content": content},
	})
	if err != nil {
		return err
	}
	return r.writeLine(append(line, '\n'))
}

// Respond answers a can_use_tool request with an allow or deny decision.
func (r *Runtime) Respond(_ context.Context, requestID domain.RequestID, answer app.RequestAnswer) error {
	req, ok := r.mapper.Pending(requestID)
	if !ok {
		return fmt.Errorf("claude: no pending request %s", requestID)
	}
	result := map[string]any{}
	if answer.Allow {
		result["behavior"] = "allow"
		if answer.AllowForSession && len(req.suggestions) > 0 {
			var suggestions any
			if err := json.Unmarshal(req.suggestions, &suggestions); err == nil {
				result["updatedPermissions"] = suggestions
			}
		}
		if len(answer.Answers) > 0 {
			input := map[string]any{}
			_ = json.Unmarshal(req.input, &input)
			answers := map[string]any{}
			for question, labels := range answer.Answers {
				switch len(labels) {
				case 0:
				case 1:
					answers[question] = labels[0]
				default:
					answers[question] = labels
				}
			}
			input["answers"] = answers
			result["updatedInput"] = input
		}
	} else {
		result["behavior"] = "deny"
		message := answer.Message
		if message == "" {
			message = "denied by the user"
		}
		result["message"] = message
	}
	line, err := json.Marshal(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype": "success", "request_id": string(requestID), "response": result,
		},
	})
	if err != nil {
		return err
	}
	if err := r.writeLine(append(line, '\n')); err != nil {
		return err
	}
	if answer.Allow {
		r.mapper.TakePending(requestID)
	} else {
		r.mapper.Deny(requestID)
	}
	return nil
}

// SetModel switches the live session: set_model changes the model (no
// model means the configured default) and apply_flag_settings changes
// effortLevel (null means the model's default). After a model change the
// effort is sent again, since the CLI resets it for models without effort.
// Verified on claude 2.1.x through get_settings "applied".
func (r *Runtime) SetModel(_ context.Context, model, effort string) error {
	r.modelMu.Lock()
	defer r.modelMu.Unlock()
	modelChanged := model != r.model
	if modelChanged {
		req := map[string]any{"subtype": "set_model"}
		if model != "" {
			req["model"] = model
		}
		if err := r.controlRequest(req); err != nil {
			return err
		}
		r.model = model
	}
	if effort != r.effort || (modelChanged && effort != "") {
		var level any
		if effort != "" {
			level = effort
		}
		req := map[string]any{"subtype": "apply_flag_settings", "settings": map[string]any{"effortLevel": level}}
		if err := r.controlRequest(req); err != nil {
			return err
		}
		r.effort = effort
	}
	return nil
}

// Interrupt asks the CLI to stop the current turn.
func (r *Runtime) Interrupt(_ context.Context) error {
	return r.controlRequest(map[string]any{"subtype": "interrupt"})
}

// StopTask asks the CLI to stop one background subagent task.
func (r *Runtime) StopTask(_ context.Context, taskID string) error {
	return r.controlRequest(map[string]any{"subtype": "stop_task", "task_id": taskID})
}

// controlRequest sends a control_request and waits for its control_response.
func (r *Runtime) controlRequest(request map[string]any) error {
	r.writeMu.Lock()
	r.reqCounter++
	reqID := fmt.Sprintf("gc-%d", r.reqCounter)
	r.writeMu.Unlock()
	line, err := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": reqID,
		"request":    request,
	})
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	r.controlMu.Lock()
	r.control[reqID] = done
	r.controlMu.Unlock()
	defer func() {
		r.controlMu.Lock()
		delete(r.control, reqID)
		r.controlMu.Unlock()
	}()
	if err := r.writeLine(append(line, '\n')); err != nil {
		return err
	}
	select {
	case err := <-done:
		return err
	case <-r.readDone:
		return fmt.Errorf("claude: process exited before answering %v", request["subtype"])
	case <-time.After(controlTimeout):
		return fmt.Errorf("claude: no answer to %v in %s", request["subtype"], controlTimeout)
	}
}

// resolveControl hands a control_response to the request waiting for it.
func (r *Runtime) resolveControl(line []byte) bool {
	if !bytes.Contains(line, []byte(`"control_response"`)) {
		return false
	}
	var msg struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
			Error     string `json:"error"`
		} `json:"response"`
	}
	if json.Unmarshal(line, &msg) != nil || msg.Type != "control_response" {
		return false
	}
	r.controlMu.Lock()
	done := r.control[msg.Response.RequestID]
	r.controlMu.Unlock()
	if done != nil {
		var err error
		if msg.Response.Subtype == "error" {
			err = errors.New("claude: " + msg.Response.Error)
		}
		done <- err
	}
	return true
}

// Close terminates the process and closes Events.
func (r *Runtime) Close() error {
	r.closeOnce.Do(func() {
		_ = r.stdin.Close()
		r.kill()
	})
	<-r.exit
	return nil
}

func (r *Runtime) writeLine(line []byte) error {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	if _, err := r.stdin.Write(line); err != nil {
		return fmt.Errorf("claude: write: %w", err)
	}
	return nil
}

// read scans the process stdout, mapping every message to events.
func (r *Runtime) read(stdout io.Reader) {
	defer close(r.readDone)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if r.resolveControl(line) {
			continue
		}
		events, err := r.mapper.Map(line)
		if err != nil {
			continue
		}
		for _, ev := range events {
			r.events <- ev
		}
	}
	if err := scanner.Err(); err != nil {
		// Nothing reads stdout any more, so the CLI would block on it.
		_, _ = fmt.Fprintln(r.log, "claude: read stdout:", err)
		r.kill()
	}
}

func (r *Runtime) drainStderr(stderr io.Reader, dst io.Writer) {
	defer close(r.stderrDone)
	reader := bufio.NewReader(stderr)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			_, _ = fmt.Fprintln(dst, "claude:", strings.TrimRight(line, "\n"))
		}
		if err != nil {
			return
		}
	}
}

// wait reaps the process once stdout is drained: os/exec forbids calling
// Wait before reads from the pipe complete, and events must not be sent
// after they are closed.
func (r *Runtime) wait() {
	<-r.readDone
	// Let stderr carry the crash message before Wait closes the pipe; a
	// child that inherited stderr may keep it open, so the wait is bounded.
	select {
	case <-r.stderrDone:
	case <-time.After(time.Second):
	}
	_ = r.cmd.Wait()
	close(r.events)
	close(r.exit)
}

func (r *Runtime) kill() {
	if r.cmd.Process != nil {
		_ = r.cmd.Process.Kill()
	}
}

// controlTimeout bounds the wait for a control_response.
var controlTimeout = 10 * time.Second
