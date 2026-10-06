package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type archivingSessions struct {
	*fakeSessions
	archived map[domain.SessionID]bool
	deleted  map[domain.SessionID]bool
}

func (a archivingSessions) known(id domain.SessionID) error {
	switch id {
	case "s1", "busy":
		return nil
	case "nodb":
		return app.ErrDeleteUnsupported
	}
	return fmt.Errorf("%w: %s", app.ErrSessionNotFound, id)
}

func (a archivingSessions) ArchiveSession(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if err := a.known(id); err != nil {
		return domain.SessionSnapshot{}, err
	}
	a.archived[id] = true
	return domain.SessionSnapshot{ID: id, ArchivedAt: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)}, nil
}

func (a archivingSessions) UnarchiveSession(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if err := a.known(id); err != nil {
		return domain.SessionSnapshot{}, err
	}
	delete(a.archived, id)
	return domain.SessionSnapshot{ID: id}, nil
}

func (a archivingSessions) DeleteSession(_ context.Context, id domain.SessionID) error {
	if err := a.known(id); err != nil {
		return err
	}
	if id == "busy" {
		return fmt.Errorf("%s: %w", id, domain.ErrSessionBusy)
	}
	a.deleted[id] = true
	return nil
}

func TestArchiveEndpoints(t *testing.T) {
	s := archivingSessions{fakeSessions: &fakeSessions{}, archived: map[domain.SessionID]bool{}, deleted: map[domain.SessionID]bool{}}
	h := newSessionsServer(s, nil)
	rec := do(h, authed("POST", "/api/sessions/s1/archive", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"archivedAt":"2026-10-06T09:00:00Z"`) || !s.archived["s1"] {
		t.Fatalf("archive: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, authed("POST", "/api/sessions/s1/unarchive", ""))
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "archivedAt") || s.archived["s1"] {
		t.Fatalf("unarchive: %d %s", rec.Code, rec.Body.String())
	}
	for _, path := range []string{"/api/sessions/nope/archive", "/api/sessions/nope/unarchive"} {
		if rec := do(h, authed("POST", path, "")); rec.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", path, rec.Code)
		}
	}
}

func TestDeleteSessionEndpoint(t *testing.T) {
	s := archivingSessions{fakeSessions: &fakeSessions{}, archived: map[domain.SessionID]bool{}, deleted: map[domain.SessionID]bool{}}
	h := newSessionsServer(s, nil)
	if rec := do(h, authed("DELETE", "/api/sessions/s1", "")); rec.Code != http.StatusNoContent || !s.deleted["s1"] {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	rec := do(h, authed("DELETE", "/api/sessions/busy", ""))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "stop its turn") {
		t.Fatalf("busy: %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(h, authed("DELETE", "/api/sessions/nope", "")); rec.Code != http.StatusNotFound {
		t.Fatalf("missing: %d", rec.Code)
	}
	if rec := do(h, authed("DELETE", "/api/sessions/nodb", "")); rec.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported: %d", rec.Code)
	}
}

func TestArchiveRoutesNeedTheCapability(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, nil)
	if rec := do(h, authed("POST", "/api/sessions/s1/archive", "")); rec.Code != http.StatusNotFound {
		t.Fatalf("archive without support: %d", rec.Code)
	}
	if rec := do(h, authed("DELETE", "/api/sessions/s1", "")); rec.Code != http.StatusMethodNotAllowed && rec.Code != http.StatusNotFound {
		t.Fatalf("delete without support: %d", rec.Code)
	}
}
