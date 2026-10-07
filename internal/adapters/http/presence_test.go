package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/app"
)

func dialEvents(ctx context.Context, t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, url+"/api/ws", &websocket.DialOptions{ //nolint:bodyclose // a successful upgrade has no body to close
		HTTPHeader: http.Header{"Cookie": {"gc_token=" + testToken}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

// readActive reads presence frames until one names want.
func readActive(ctx context.Context, t *testing.T, c *websocket.Conn, want string) {
	t.Helper()
	for {
		var msg presenceFrame
		if err := wsjson.Read(ctx, c, &msg); err != nil {
			t.Fatalf("waiting for active %q: %v", want, err)
		}
		if msg.Type == "presence" && msg.Active != nil && *msg.Active == want {
			return
		}
	}
}

func TestWebSocketCarriesPresence(t *testing.T) {
	presence := app.NewPresence()
	ts := httptest.NewServer(NewServer(Config{
		Token:    testToken,
		Static:   fstest.MapFS{"index.html": {Data: []byte("app")}},
		Sessions: &fakeSessions{},
		Events:   hub.New(),
		Presence: presence,
	}))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	laptop := dialEvents(ctx, t, ts.URL)
	phone := dialEvents(ctx, t, ts.URL)
	if err := wsjson.Write(ctx, laptop, map[string]any{"type": "presence", "client": "laptop", "session": "s1", "visible": true, "focused": true}); err != nil {
		t.Fatal(err)
	}
	// Every page hears where the owner is, the other device included.
	readActive(ctx, t, phone, "laptop")
	readActive(ctx, t, laptop, "laptop")
	if !presence.Watching("s1") {
		t.Fatal("the focused laptop watches s1")
	}
	// Frames the server doesn't know are ignored, not fatal.
	if err := laptop.Write(ctx, websocket.MessageText, []byte("nonsense")); err != nil {
		t.Fatal(err)
	}
	if err := wsjson.Write(ctx, phone, map[string]any{"type": "presence", "client": "phone", "visible": true, "focused": true}); err != nil {
		t.Fatal(err)
	}
	readActive(ctx, t, laptop, "phone")

	// A page that closes stops watching.
	_ = laptop.Close(websocket.StatusNormalClosure, "")
	deadline := time.Now().Add(2 * time.Second)
	for presence.Watching("s1") {
		if time.Now().After(deadline) {
			t.Fatal("a closed page still watches")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestWebSocketWithoutPresenceStillStreams(t *testing.T) {
	ts := httptest.NewServer(newSessionsServer(&fakeSessions{}, hub.New()))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := dialEvents(ctx, t, ts.URL)
	if err := wsjson.Write(ctx, c, map[string]any{"type": "presence", "client": "x"}); err != nil {
		t.Fatal(err)
	}
	// Still open: a ping round-trips.
	c.CloseRead(ctx)
	if err := c.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
}
