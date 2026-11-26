package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type pinningSessions struct{ *fakeSessions }

func (pinningSessions) SetPinned(_ context.Context, id domain.SessionID, on bool) (domain.SessionSnapshot, error) {
	if id != "s1" {
		return domain.SessionSnapshot{}, app.ErrSessionNotFound
	}
	return domain.SessionSnapshot{ID: id, Pinned: on}, nil
}
func TestPinSessionEndpoint(t *testing.T) {
	h := newSessionsServer(pinningSessions{&fakeSessions{}}, nil)
	for _, on := range []string{"true", "false"} {
		rec := do(h, authed("POST", "/api/sessions/s1/pin", `{"pinned":`+on+`}`))
		if rec.Code != http.StatusOK || (on == "true" && !strings.Contains(rec.Body.String(), `"pinned":true`)) {
			t.Fatalf("pin: %d %s", rec.Code, rec.Body.String())
		}
	}
	for _, body := range []string{`{`, `{}`, `{"pinned":null}`, `{"pinned":"yes"}`} {
		if rec := do(h, authed("POST", "/api/sessions/s1/pin", body)); rec.Code != http.StatusBadRequest {
			t.Fatalf("bad body %s: %d", body, rec.Code)
		}
	}
	if rec := do(h, authed("POST", "/api/sessions/missing/pin", `{"pinned":true}`)); rec.Code != http.StatusNotFound {
		t.Fatalf("missing: %d", rec.Code)
	}
}
