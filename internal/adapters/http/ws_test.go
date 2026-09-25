package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestWebSocketStreamsEvents(t *testing.T) {
	events := hub.New()
	ts := httptest.NewServer(newSessionsServer(&fakeSessions{}, events))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, ts.URL+"/api/ws", &websocket.DialOptions{ //nolint:bodyclose // a successful upgrade has no body to close
		HTTPHeader: http.Header{"Cookie": {"gc_token=" + testToken}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = c.CloseNow() }()

	// Publish until the subscriber is registered; the transport, like the
	// real client, fetches history separately for anything published earlier.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				events.Publish(domain.Event{SessionID: "a", Type: domain.EventTurnStarted})
			}
		}
	}()

	var got domain.Event
	if err := wsjson.Read(ctx, c, &got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.SessionID != "a" || got.Type != domain.EventTurnStarted {
		t.Fatalf("event = %+v", got)
	}
}

func TestWebSocketRequiresAuth(t *testing.T) {
	events := hub.New()
	ts := httptest.NewServer(newSessionsServer(&fakeSessions{}, events))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, ts.URL+"/api/ws", nil) //nolint:bodyclose // dial fails before a body exists
	if err == nil {
		_ = c.CloseNow()
		t.Fatal("want dial error without token")
	}
}

func TestWebSocketRejectsCrossOrigin(t *testing.T) {
	events := hub.New()
	ts := httptest.NewServer(newSessionsServer(&fakeSessions{}, events))
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, ts.URL+"/api/ws", &websocket.DialOptions{ //nolint:bodyclose // dial fails before a body exists
		HTTPHeader: http.Header{"Cookie": {"gc_token=" + testToken}, "Origin": {"http://127.0.0.1:1"}},
	})
	if err == nil {
		_ = c.CloseNow()
		t.Fatal("want cross-origin dial to fail")
	}
}
