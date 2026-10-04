package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestDiagnosticsEndpoint(t *testing.T) {
	events := hub.New()
	events.Publish(domain.Event{SessionID: "s1", Type: domain.EventTurnStarted})
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Events: events})
	if rec := do(h, authed("GET", "/api/diagnostics", "")); rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	} else {
		var body struct {
			Goroutines int    `json:"goroutines"`
			HeapBytes  uint64 `json:"heapBytes"`
			Events     struct {
				Published uint64 `json:"published"`
			} `json:"events"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Goroutines <= 0 || body.HeapBytes == 0 || body.Events.Published != 1 {
			t.Fatalf("diagnostics: %+v", body)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("diagnostics can be cached")
		}
	}
	if rec := do(h, httptest.NewRequest("GET", "/api/diagnostics", nil)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: %d", rec.Code)
	}
}

func TestDiagnosticsWebSocketEcho(t *testing.T) {
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}})
	srv := httptest.NewServer(h)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	headers := authed("GET", "/api/diagnostics/ws", "").Header
	c, response, err := websocket.Dial(ctx, srv.URL+"/api/diagnostics/ws", &websocket.DialOptions{HTTPHeader: headers})
	if response != nil && response.Body != nil {
		defer func() { _ = response.Body.Close() }()
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if err := c.Write(ctx, websocket.MessageText, []byte("42")); err != nil {
		t.Fatal(err)
	}
	kind, data, err := c.Read(ctx)
	if err != nil || kind != websocket.MessageText || string(data) != "42" {
		t.Fatalf("echo: %v %s %v", kind, data, err)
	}
	headers.Set("Origin", "http://elsewhere.invalid")
	other, rejected, err := websocket.Dial(ctx, srv.URL+"/api/diagnostics/ws", &websocket.DialOptions{HTTPHeader: headers})
	if rejected != nil && rejected.Body != nil {
		defer func() { _ = rejected.Body.Close() }()
	}
	if err == nil {
		_ = other.CloseNow()
		t.Fatal("accepted cross-origin diagnostics")
	}
	if err := c.Write(ctx, websocket.MessageBinary, []byte("input")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusUnsupportedData {
		t.Fatalf("binary data: %v", err)
	}
}
