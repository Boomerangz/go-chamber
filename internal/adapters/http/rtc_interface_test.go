package httpapi

import (
	"context"
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
)

func TestRTCUnavailableInterfaceLeavesSignalingRetryable(t *testing.T) {
	e := newTermEnv(t)
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Terminals: e.terms, RTCInterface: "go-chamber-nonexistent"})
	for range 2 {
		r := do(h, authed("POST", "/api/terminals/"+string(term.ID)+"/rtc", `{"type":"offer","sdp":"v=0\r\n"}`))
		if r.Code != http.StatusServiceUnavailable {
			t.Fatalf("interface unavailable: %d %s", r.Code, r.Body.String())
		}
	}
}
