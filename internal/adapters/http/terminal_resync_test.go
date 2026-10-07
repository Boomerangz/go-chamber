package httpapi

import (
	"bytes"
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/coder/websocket"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// scriptedTerms serves real terminals but hands every client an attachment
// whose output the test sends, so a resync is deterministic.
type scriptedTerms struct {
	*app.Terminals
	output chan app.TerminalOutput
}

func (s scriptedTerms) Attach(domain.TerminalID) (*app.TerminalAttachment, error) {
	return &app.TerminalAttachment{Scrollback: []byte("old"), Output: s.output}, nil
}

func newScriptedTermEnv(t *testing.T) (termEnv, chan app.TerminalOutput) {
	t.Helper()
	base := newTermEnv(t)
	output := make(chan app.TerminalOutput)
	ts := httptest.NewServer(NewServer(Config{
		Token: testToken, Static: fstest.MapFS{"index.html": {Data: []byte("app")}},
		Terminals: scriptedTerms{Terminals: base.terms, output: output},
	}))
	t.Cleanup(ts.Close)
	return termEnv{terms: base.terms, factory: base.factory, ts: ts}, output
}

// A lagging client is resynced in place: the socket stays open, a "resync"
// marker tells it to clear the screen, the scrollback follows and "ready"
// ends its replay.
func TestTerminalPTYResyncsALaggingClientInPlace(t *testing.T) {
	e, output := newScriptedTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	c, err := e.dial(t, term.ID, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	want := []struct {
		typ  websocket.MessageType
		data string
	}{
		{websocket.MessageBinary, "old"},
		{websocket.MessageText, `{"type":"ready"}`},
		{websocket.MessageBinary, "live"},
		{websocket.MessageText, `{"type":"resync"}`},
		{websocket.MessageBinary, "whole scrollback"},
		{websocket.MessageText, `{"type":"ready"}`},
		{websocket.MessageBinary, "after"},
	}
	go func() {
		output <- app.TerminalOutput{Data: []byte("live")}
		output <- app.TerminalOutput{Data: []byte("whole scrollback"), Resync: true}
		output <- app.TerminalOutput{Data: []byte("after")}
	}()
	for i, w := range want {
		typ, got := readFrame(t, c)
		if typ != w.typ || strings.TrimSpace(got) != w.data {
			t.Fatalf("frame %d = %v %q, want %v %q", i, typ, got, w.typ, w.data)
		}
	}
}

func TestRTCTerminalResyncsALaggingClientInPlace(t *testing.T) {
	e, output := newScriptedTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{Cwd: "/tmp"})
	_, next := dialRTC(t, e, term.ID, 16)
	if msg := next(); msg.IsString || string(msg.Data) != "old" {
		t.Fatalf("scrollback: %+v", msg)
	}
	if msg := next(); !msg.IsString || !bytes.Contains(msg.Data, []byte(`"ready"`)) {
		t.Fatalf("ready: %+v", msg)
	}
	output <- app.TerminalOutput{Data: []byte("whole scrollback"), Resync: true}
	if msg := next(); !msg.IsString || string(msg.Data) != `{"type":"resync"}` {
		t.Fatalf("resync marker: %+v", msg)
	}
	if msg := next(); msg.IsString || string(msg.Data) != "whole scrollback" {
		t.Fatalf("resync data: %+v", msg)
	}
	if msg := next(); !msg.IsString || !bytes.Contains(msg.Data, []byte(`"ready"`)) {
		t.Fatalf("ready after resync: %+v", msg)
	}
	output <- app.TerminalOutput{Data: []byte("after")}
	if msg := next(); msg.IsString || string(msg.Data) != "after" {
		t.Fatalf("after: %+v", msg)
	}
}
