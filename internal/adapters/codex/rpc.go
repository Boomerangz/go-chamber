// Package codex implements the app.AgentRuntime port over `codex app-server`,
// a JSON-RPC 2.0 (NDJSON over stdio) protocol. Protocol types are a
// hand-written subset of the generated schema (scripts/codex-schema-check).
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
)

var ErrClientClosed = errors.New("codex: client closed")

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("codex rpc error %d: %s", e.Code, e.Message)
}

type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Handler receives a server-initiated request. The owner answers it later
// with Respond/RespondError, or immediately for stateless methods.
type Handler func(id json.RawMessage, method string, params json.RawMessage)

// Client is a JSON-RPC 2.0 client over a stream. It correlates responses by
// id, dispatches notifications and answers server requests.
type Client struct {
	r  io.Reader
	w  io.Writer
	on Handler
	nt func(method string, params json.RawMessage)

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	pending map[string]chan rpcMessage
	closed  bool

	done chan struct{}
	err  error
}

// NewClient starts reading messages from r. onNotify may be nil.
func NewClient(r io.Reader, w io.Writer, on Handler, onNotify func(method string, params json.RawMessage)) *Client {
	c := &Client{
		r: r, w: w, on: on, nt: onNotify,
		pending: map[string]chan rpcMessage{},
		done:    make(chan struct{}),
	}
	go c.read()
	return c
}

// Done is closed when the read loop stops (EOF or error).
func (c *Client) Done() <-chan struct{} { return c.done }

// Err returns the terminal read error, if any.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Client) read() {
	defer close(c.done)
	scanner := bufio.NewScanner(c.r)
	scanner.Buffer(make([]byte, 0, 64*1024), 32*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}
		switch {
		case msg.Method != "" && len(msg.ID) > 0:
			go c.handleRequest(msg)
		case msg.Method != "":
			if c.nt != nil {
				c.nt(msg.Method, msg.Params)
			}
		default:
			c.deliver(msg)
		}
	}
	c.mu.Lock()
	c.err = scanner.Err()
	for _, ch := range c.pending {
		close(ch)
	}
	c.pending = map[string]chan rpcMessage{}
	c.closed = true
	c.mu.Unlock()
}

func (c *Client) deliver(msg rpcMessage) {
	key := idKey(msg.ID)
	c.mu.Lock()
	ch := c.pending[key]
	delete(c.pending, key)
	c.mu.Unlock()
	if ch != nil {
		ch <- msg
	}
}

func (c *Client) handleRequest(msg rpcMessage) {
	if c.on != nil {
		c.on(msg.ID, msg.Method, msg.Params)
	}
}

// Respond sends the success result for a server request.
func (c *Client) Respond(id json.RawMessage, result any) error { return c.respond(id, result) }

// RespondError sends an error response for a server request.
func (c *Client) RespondError(id json.RawMessage, code int, message string) error {
	return c.respondError(id, code, message)
}

// Call sends a request and waits for its response.
func (c *Client) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	ch, id, err := c.send(method, params)
	if err != nil {
		return nil, err
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return nil, c.terminalErr()
		}
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	case <-c.done:
		if msg, ok := <-ch; ok {
			if msg.Error != nil {
				return nil, msg.Error
			}
			return msg.Result, nil
		}
		return nil, c.terminalErr()
	}
}

// Notify sends a notification (no response expected).
func (c *Client) Notify(method string, params any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(rpcMessage{JSONRPC: "2.0", Method: method, Params: body})
}

func (c *Client) send(method string, params any) (chan rpcMessage, string, error) {
	body, err := json.Marshal(params)
	if err != nil {
		return nil, "", err
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, "", c.terminalErr()
	}
	c.nextID++
	id := strconv.Itoa(c.nextID)
	ch := make(chan rpcMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	rawID := json.RawMessage(id)
	if err := c.write(rpcMessage{JSONRPC: "2.0", ID: rawID, Method: method, Params: body}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, id, err
	}
	return ch, id, nil
}

func (c *Client) respond(id json.RawMessage, result any) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return c.write(rpcMessage{JSONRPC: "2.0", ID: id, Result: body})
}

func (c *Client) respondError(id json.RawMessage, code int, message string) error {
	return c.write(rpcMessage{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: message}})
}

func (c *Client) write(msg rpcMessage) error {
	line, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		return err
	}
	return nil
}

func (c *Client) terminalErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	return ErrClientClosed
}

func idKey(id json.RawMessage) string {
	if len(id) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(id, &s); err == nil {
		return s
	}
	return string(id)
}
