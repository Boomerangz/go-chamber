package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

type testPeer struct {
	t *testing.T
	r *bufio.Reader
	w *os.File
}

func newPair(t *testing.T, on Handler) (*Client, *testPeer) {
	t.Helper()
	toClientR, toClientW := osPipe(t)
	toPeerR, toPeerW := osPipe(t)

	client := NewClient(toClientR, toPeerW, on, nil)
	peer := &testPeer{t: t, r: bufio.NewReader(toPeerR), w: toClientW}
	return client, peer
}

func osPipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = r.Close()
		_ = w.Close()
	})
	return r, w
}

func (p *testPeer) read() rpcMessage {
	p.t.Helper()
	line, err := p.r.ReadBytes('\n')
	if err != nil {
		p.t.Fatalf("peer read: %v", err)
	}
	var msg rpcMessage
	if err := json.Unmarshal(line, &msg); err != nil {
		p.t.Fatalf("peer unmarshal %q: %v", line, err)
	}
	return msg
}

func (p *testPeer) send(v any) {
	p.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		p.t.Fatal(err)
	}
	if _, err := p.w.Write(append(b, '\n')); err != nil {
		p.t.Fatalf("peer write: %v", err)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestClientCallCorrelates(t *testing.T) {
	client, peer := newPair(t, nil)
	type result struct {
		data json.RawMessage
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := client.Call(context.Background(), "thread/start", map[string]any{"cwd": "/tmp"})
		done <- result{data, err}
	}()
	req := peer.read()
	if req.Method != "thread/start" || len(req.ID) == 0 {
		t.Fatalf("request = %+v", req)
	}
	var params map[string]string
	if err := json.Unmarshal(req.Params, &params); err != nil || params["cwd"] != "/tmp" {
		t.Fatalf("params = %s (%v)", req.Params, err)
	}
	peer.send(rpcMessage{JSONRPC: "2.0", ID: req.ID, Result: json.RawMessage(`{"ok":true}`)})

	got := <-done
	if got.err != nil || string(got.data) != `{"ok":true}` {
		t.Fatalf("call = %s, %v", got.data, got.err)
	}
}

func TestClientCallError(t *testing.T) {
	client, peer := newPair(t, nil)
	errc := make(chan error, 1)
	go func() {
		_, err := client.Call(context.Background(), "thread/list", nil)
		errc <- err
	}()
	req := peer.read()
	peer.send(rpcMessage{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32600, Message: "bad"}})
	if err := <-errc; err == nil || err.Error() != "codex rpc error -32600: bad" {
		t.Fatalf("err = %v", err)
	}
}

func TestClientNotificationDispatch(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	toClientR, toClientW := osPipe(t)
	_, toPeerW := osPipe(t)
	_ = NewClient(toClientR, toPeerW, nil, func(method string, _ json.RawMessage) {
		mu.Lock()
		seen = append(seen, method)
		mu.Unlock()
	})
	peer := &testPeer{t: t, w: toClientW}
	peer.send(rpcMessage{JSONRPC: "2.0", Method: "turn/started", Params: json.RawMessage(`{}`)})
	waitFor(t, "notification", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(seen) == 1 && seen[0] == "turn/started"
	})
}

func TestClientAnswersServerRequest(t *testing.T) {
	var client *Client
	client, peer := newPair(t, func(id json.RawMessage, _ string, _ json.RawMessage) {
		_ = client.Respond(id, map[string]any{"decision": "accept"})
	})
	peer.send(rpcMessage{JSONRPC: "2.0", ID: json.RawMessage(`"srv-1"`), Method: "item/commandExecution/requestApproval", Params: json.RawMessage(`{"itemId":"i1"}`)})
	resp := peer.read()
	if string(resp.ID) != `"srv-1"` || resp.Error != nil {
		t.Fatalf("response = %+v", resp)
	}
	var result map[string]string
	if err := json.Unmarshal(resp.Result, &result); err != nil || result["decision"] != "accept" {
		t.Fatalf("result = %s (%v)", resp.Result, err)
	}
}

func TestClientServerRequestError(t *testing.T) {
	var client *Client
	client, peer := newPair(t, func(id json.RawMessage, _ string, _ json.RawMessage) {
		_ = client.RespondError(id, -32603, "nope")
	})
	peer.send(rpcMessage{JSONRPC: "2.0", ID: json.RawMessage(`7`), Method: "x", Params: json.RawMessage(`{}`)})
	resp := peer.read()
	if resp.Error == nil || resp.Error.Message != "nope" {
		t.Fatalf("response = %+v", resp)
	}
}

func TestClientNotify(t *testing.T) {
	client, peer := newPair(t, nil)
	if err := client.Notify("initialized", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	msg := peer.read()
	if msg.Method != "initialized" || len(msg.ID) != 0 {
		t.Fatalf("msg = %+v", msg)
	}
}

func TestClientContextCancel(t *testing.T) {
	client, _ := newPair(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Call(ctx, "thread/list", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

func TestClientClosesOnEOF(t *testing.T) {
	toClientR, toClientW := osPipe(t)
	_, toPeerW := osPipe(t)
	client := NewClient(toClientR, toPeerW, nil, nil)
	errc := make(chan error, 1)
	go func() {
		_, err := client.Call(context.Background(), "thread/list", nil)
		errc <- err
	}()
	_ = toClientW.Close()
	select {
	case err := <-errc:
		if !errors.Is(err, ErrClientClosed) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call did not unblock on EOF")
	}
}

func TestClientIgnoresMalformedLines(t *testing.T) {
	client, peer := newPair(t, nil)
	_ = client
	if _, err := peer.w.Write([]byte("not json\n")); err != nil {
		t.Fatal(err)
	}
	peer.send(rpcMessage{JSONRPC: "2.0", ID: json.RawMessage(`99`), Result: json.RawMessage(`{}`)})
	// The malformed line must not break the read loop; a following notification
	// is still delivered.
	peer.send(rpcMessage{JSONRPC: "2.0", Method: "ping"})
}

func TestClientErrIsNilWhileOpen(t *testing.T) {
	client, _ := newPair(t, nil)
	if client.Err() != nil {
		t.Fatalf("err = %v", client.Err())
	}
	select {
	case <-client.Done():
		t.Fatal("client should not be done")
	default:
	}
}
