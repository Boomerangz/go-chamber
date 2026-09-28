package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type renamingSessions struct {
	*fakeSessions
	renamed map[domain.SessionID]string
}

func (r renamingSessions) RenameSession(_ context.Context, id domain.SessionID, title string) (domain.SessionSnapshot, error) {
	if id != "s1" {
		return domain.SessionSnapshot{}, app.ErrSessionNotFound
	}
	if len(title) > 5 {
		return domain.SessionSnapshot{}, app.ErrTitleTooLong
	}
	r.renamed[id] = title
	return domain.SessionSnapshot{ID: id, Title: title}, nil
}

func TestRenameSessionEndpoint(t *testing.T) {
	s := renamingSessions{fakeSessions: &fakeSessions{}, renamed: map[domain.SessionID]string{}}
	h := newSessionsServer(s, nil)
	rec := do(h, authed("POST", "/api/sessions/s1/title", `{"title":"Notes"}`))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"title":"Notes"`) || s.renamed["s1"] != "Notes" {
		t.Fatalf("rename: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(h, authed("POST", "/api/sessions/s1/title", `{"title":"too long"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("long title: %d", rec.Code)
	}
	if rec := do(h, authed("POST", "/api/sessions/nope/title", `{"title":"x"}`)); rec.Code != http.StatusNotFound {
		t.Fatalf("missing session: %d", rec.Code)
	}
}

func TestRenameTerminalEndpoint(t *testing.T) {
	e := newTermEnv(t)
	term, err := e.terms.Open(context.Background(), app.OpenTerminal{Cwd: "/srv/app"})
	if err != nil {
		t.Fatal(err)
	}
	code, body := e.call(t, "POST", "/api/terminals/"+string(term.ID)+"/title", `{"title":"logs"}`)
	if code != http.StatusOK || !strings.Contains(body, `"title":"logs"`) {
		t.Fatalf("rename: %d %s", code, body)
	}
	if code, _ := e.call(t, "POST", "/api/terminals/nope/title", `{"title":"x"}`); code != http.StatusNotFound {
		t.Fatalf("missing terminal: %d", code)
	}
}
