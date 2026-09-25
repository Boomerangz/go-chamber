package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type pipePTY struct {
	out   *io.PipeReader
	outW  *io.PipeWriter
	exitc chan int
	once  sync.Once

	mu    sync.Mutex
	input []byte
	sizes [][2]uint16
}

func (p *pipePTY) Read(b []byte) (int, error) { return p.out.Read(b) }
func (p *pipePTY) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.input = append(p.input, b...)
	return len(b), nil
}
func (p *pipePTY) Resize(cols, rows uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sizes = append(p.sizes, [2]uint16{cols, rows})
	return nil
}
func (p *pipePTY) Wait() (int, error) { return <-p.exitc, nil }
func (p *pipePTY) Close() error       { p.exit(-1); return nil }
func (p *pipePTY) exit(code int) {
	p.once.Do(func() { _ = p.outW.Close(); p.exitc <- code })
}

type pipeFactory struct {
	mu   sync.Mutex
	ptys []*pipePTY
}

func (f *pipeFactory) Start(app.PTYSpec) (app.PTY, error) {
	r, w := io.Pipe()
	p := &pipePTY{out: r, outW: w, exitc: make(chan int, 1)}
	f.mu.Lock()
	f.ptys = append(f.ptys, p)
	f.mu.Unlock()
	return p, nil
}

type sessionsByID map[domain.SessionID]domain.SessionSnapshot

func (s sessionsByID) Get(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if snap, ok := s[id]; ok {
		return snap, nil
	}
	return domain.SessionSnapshot{}, app.ErrSessionNotFound
}

type termEnv struct {
	terms   *app.Terminals
	factory *pipeFactory
	ts      *httptest.Server
}

func newTermEnv(t *testing.T) termEnv {
	t.Helper()
	factory := &pipeFactory{}
	terms := app.NewTerminals(app.TerminalsConfig{
		PTYs: factory, Home: "/home/me", Shell: "/bin/sh",
		Sessions: sessionsByID{"s1": {ID: "s1", Cwd: "/work"}},
	})
	t.Cleanup(terms.CloseAll)
	ts := httptest.NewServer(NewServer(Config{
		Token: testToken, Static: fstest.MapFS{"index.html": {Data: []byte("app")}},
		Terminals: terms,
	}))
	t.Cleanup(ts.Close)
	return termEnv{terms: terms, factory: factory, ts: ts}
}

func (e termEnv) call(t *testing.T, method, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, e.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func (e termEnv) dial(t *testing.T, id domain.TerminalID, origin string) (*websocket.Conn, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h := http.Header{"Cookie": {CookieName + "=" + testToken}}
	if origin != "" {
		h.Set("Origin", origin)
	}
	c, _, err := websocket.Dial(ctx, e.ts.URL+"/api/terminals/"+string(id)+"/pty", &websocket.DialOptions{HTTPHeader: h}) //nolint:bodyclose // a successful upgrade has no body to close
	if err == nil {
		t.Cleanup(func() { _ = c.CloseNow() })
	}
	return c, err
}

func readFrame(t *testing.T, c *websocket.Conn) (websocket.MessageType, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return typ, string(b)
}

func TestTerminalsRESTLifecycle(t *testing.T) {
	e := newTermEnv(t)
	code, body := e.call(t, "POST", "/api/terminals", `{"cwd":"/srv","cols":100,"rows":30}`)
	if code != http.StatusCreated {
		t.Fatalf("create = %d %s", code, body)
	}
	var term domain.Terminal
	if err := json.Unmarshal([]byte(body), &term); err != nil || term.Cwd != "/srv" || term.Status != domain.TerminalRunning {
		t.Fatalf("terminal = %+v, %v", term, err)
	}

	code, body = e.call(t, "POST", "/api/terminals", `{"sessionId":"s1"}`)
	if code != http.StatusCreated || !strings.Contains(body, `"cwd":"/work"`) || !strings.Contains(body, `"sessionId":"s1"`) {
		t.Fatalf("create in session = %d %s", code, body)
	}

	code, body = e.call(t, "GET", "/api/terminals", "")
	var list []domain.Terminal
	if code != http.StatusOK || json.Unmarshal([]byte(body), &list) != nil || len(list) != 2 {
		t.Fatalf("list = %d %s", code, body)
	}

	if code, body = e.call(t, "DELETE", "/api/terminals/"+string(term.ID), ""); code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", code, body)
	}
	if code, _ = e.call(t, "DELETE", "/api/terminals/"+string(term.ID), ""); code != http.StatusNotFound {
		t.Fatalf("second delete = %d", code)
	}
}

func TestTerminalsListEmptyIsArray(t *testing.T) {
	e := newTermEnv(t)
	if code, body := e.call(t, "GET", "/api/terminals", ""); code != http.StatusOK || strings.TrimSpace(body) != "[]" {
		t.Fatalf("list = %d %q", code, body)
	}
}

func TestTerminalsCreateErrors(t *testing.T) {
	e := newTermEnv(t)
	cases := []struct {
		body string
		want int
	}{
		{`{"cwd":"relative"}`, http.StatusBadRequest},
		{`{"sessionId":"nope"}`, http.StatusNotFound},
		{`not json`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		if code, body := e.call(t, "POST", "/api/terminals", tc.body); code != tc.want {
			t.Fatalf("create %s = %d %s, want %d", tc.body, code, body, tc.want)
		}
	}
}

func TestTerminalErrorStatuses(t *testing.T) {
	cases := map[error]int{
		app.ErrTerminalNotFound:      http.StatusNotFound,
		domain.ErrInvalidTerminal:    http.StatusBadRequest,
		app.ErrInvalidTerminalSize:   http.StatusBadRequest,
		domain.ErrTerminalExited:     http.StatusConflict,
		errors.New("something else"): http.StatusInternalServerError,
	}
	for err, want := range cases {
		rec := httptest.NewRecorder()
		(&server{}).fail(rec, err)
		if rec.Code != want {
			t.Fatalf("fail(%v) = %d, want %d", err, rec.Code, want)
		}
	}
}

func TestTerminalPTYStreamsBothWays(t *testing.T) {
	e := newTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	p := e.factory.ptys[0]
	watch, _ := e.terms.Attach(term.ID)
	_, _ = p.outW.Write([]byte("$ "))
	<-watch.Output
	watch.Detach()

	c, err := e.dial(t, term.ID, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if typ, got := readFrame(t, c); typ != websocket.MessageBinary || got != "$ " {
		t.Fatalf("scrollback frame = %v %q", typ, got)
	}
	if typ, got := readFrame(t, c); typ != websocket.MessageText || strings.TrimSpace(got) != `{"type":"ready"}` {
		t.Fatalf("ready frame = %v %q", typ, got)
	}
	go func() { _, _ = p.outW.Write([]byte("hello")) }()
	if typ, got := readFrame(t, c); typ != websocket.MessageBinary || got != "hello" {
		t.Fatalf("output frame = %v %q", typ, got)
	}

	ctx := context.Background()
	if err := c.Write(ctx, websocket.MessageBinary, []byte("ls\r")); err != nil {
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":120,"rows":40}`)); err != nil {
		t.Fatal(err)
	}
	// Ignored: malformed control messages and zero sizes don't break the stream.
	_ = c.Write(ctx, websocket.MessageText, []byte(`garbage`))
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":0,"rows":0}`))
	deadline := time.Now().Add(2 * time.Second)
	for {
		p.mu.Lock()
		input, sizes := string(p.input), append([][2]uint16(nil), p.sizes...)
		p.mu.Unlock()
		if input == "ls\r" && len(sizes) == 1 && sizes[0] == [2]uint16{120, 40} {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("input = %q, sizes = %v", input, sizes)
		}
		time.Sleep(5 * time.Millisecond)
	}

	p.exit(7)
	var msg struct {
		Type string `json:"type"`
		Code int    `json:"code"`
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := wsjson.Read(rctx, c, &msg); err != nil || msg.Type != "exit" || msg.Code != 7 {
		t.Fatalf("exit message = %+v, %v", msg, err)
	}
	if _, _, err := c.Read(rctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("close = %v, want normal closure", err)
	}
}

func TestTerminalPTYClosedByUser(t *testing.T) {
	e := newTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	c, err := e.dial(t, term.ID, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	readFrame(t, c) // ready
	// Wait until the socket is attached: input reaches the pty.
	_ = c.Write(context.Background(), websocket.MessageBinary, []byte("x"))
	for deadline := time.Now().Add(2 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		p := e.factory.ptys[0]
		p.mu.Lock()
		n := len(p.input)
		p.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("input not delivered")
		}
	}
	if err := e.terms.Close(term.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("close = %v, want normal closure", err)
	}
}

func TestTerminalPTYUnknownTerminal(t *testing.T) {
	e := newTermEnv(t)
	if _, err := e.dial(t, "nope", ""); err == nil {
		t.Fatal("want dial error for unknown terminal")
	}
}

func TestTerminalPTYRejectsCrossOrigin(t *testing.T) {
	e := newTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	if _, err := e.dial(t, term.ID, "https://evil.example"); err == nil {
		t.Fatal("want cross-origin dial to fail")
	}
}

func TestTerminalRoutesAbsentWithoutTerminals(t *testing.T) {
	rec := do(newTestServer(), withCookie(httptest.NewRequest("GET", "/api/terminals", nil), testToken))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestTerminalPTYReadyWithoutScrollback(t *testing.T) {
	e := newTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	c, err := e.dial(t, term.ID, "")
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if typ, got := readFrame(t, c); typ != websocket.MessageText || strings.TrimSpace(got) != `{"type":"ready"}` {
		t.Fatalf("first frame = %v %q", typ, got)
	}
}

func TestStateChangingRequestsRequireSameOrigin(t *testing.T) {
	e := newTermEnv(t)
	u := strings.TrimPrefix(e.ts.URL, "http://")
	cases := []struct {
		name    string
		method  string
		headers map[string]string
		want    int
	}{
		{"other localhost port", "POST", map[string]string{"Origin": "http://127.0.0.1:1"}, http.StatusForbidden},
		{"null origin", "POST", map[string]string{"Origin": "null"}, http.StatusForbidden},
		{"same-site fetch without origin", "POST", map[string]string{"Sec-Fetch-Site": "same-site"}, http.StatusForbidden},
		{"cross-site fetch without origin", "DELETE", map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{"same origin", "POST", map[string]string{"Origin": "http://" + u, "Sec-Fetch-Site": "same-origin"}, http.StatusCreated},
		{"non-browser client", "POST", nil, http.StatusCreated},
		{"reads are not checked", "GET", map[string]string{"Origin": "http://127.0.0.1:1"}, http.StatusOK},
	}
	for _, tc := range cases {
		req, _ := http.NewRequest(tc.method, e.ts.URL+"/api/terminals", strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+testToken)
		for k, v := range tc.headers {
			req.Header.Set(k, v)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		want := tc.want
		if tc.method == "DELETE" {
			want = http.StatusForbidden
		}
		if res.StatusCode != want {
			t.Fatalf("%s: status = %d, want %d", tc.name, res.StatusCode, want)
		}
	}
}
