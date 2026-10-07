package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type seeingSessions struct {
	*fakeSessions
	seen map[domain.SessionID]domain.ItemID
}

func (r seeingSessions) MarkSeen(_ context.Context, id domain.SessionID, item domain.ItemID) (domain.SessionSnapshot, error) {
	if id != "s1" {
		return domain.SessionSnapshot{}, app.ErrSessionNotFound
	}
	r.seen[id] = item
	return domain.SessionSnapshot{ID: id, Seen: domain.Seen{Item: item}}, nil
}

func TestMarkSeenEndpoint(t *testing.T) {
	s := seeingSessions{fakeSessions: &fakeSessions{}, seen: map[domain.SessionID]domain.ItemID{}}
	h := newSessionsServer(s, nil)
	rec := do(h, authed("POST", "/api/sessions/s1/seen", `{"item":"i4"}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"item":"i4"`) || s.seen["s1"] != "i4" {
		t.Fatalf("seen: %d %s", rec.Code, rec.Body.String())
	}
	// A look without reaching the end names no item.
	if rec := do(h, authed("POST", "/api/sessions/s1/seen", `{}`)); rec.Code != http.StatusOK || s.seen["s1"] != "" {
		t.Fatalf("no item: %d %q", rec.Code, s.seen["s1"])
	}
	if rec := do(h, authed("POST", "/api/sessions/nope/seen", `{}`)); rec.Code != http.StatusNotFound {
		t.Fatalf("missing session: %d", rec.Code)
	}
	if rec := do(h, authed("POST", "/api/sessions/s1/seen", `not json`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body: %d", rec.Code)
	}
}
