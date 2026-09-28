package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// lastMode records what the fake sessions were last asked to switch to.
var lastMode string

func (f *fakeSessions) SetPermissionMode(_ context.Context, id domain.SessionID, mode string) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	if mode == "robot" {
		return domain.SessionSnapshot{}, domain.ErrInvalidPermissionMode
	}
	lastMode = mode
	return domain.SessionSnapshot{ID: id, PermissionMode: mode}, nil
}

func TestPermissionModeEndpoint(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/permission-mode", `{"mode":"plan"}`))
	if rec.Code != http.StatusOK || lastMode != "plan" {
		t.Fatalf("code=%d mode=%q body=%s", rec.Code, lastMode, rec.Body.String())
	}
	if rec := do(h, authed("POST", "/api/sessions/a/permission-mode", `{"mode":"robot"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode code = %d", rec.Code)
	}
	if rec := do(h, authed("POST", "/api/sessions/a/permission-mode", `nope`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json code = %d", rec.Code)
	}
	f.err = app.ErrSessionNotFound
	if rec := do(h, authed("POST", "/api/sessions/a/permission-mode", `{"mode":"plan"}`)); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session code = %d", rec.Code)
	}
}

func TestCreateSessionAppliesThePermissionMode(t *testing.T) {
	lastMode = ""
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions", `{"agent":"claude","cwd":"/p","permissionMode":"acceptEdits"}`))
	if rec.Code != http.StatusCreated || lastMode != "acceptEdits" {
		t.Fatalf("code=%d mode=%q body=%s", rec.Code, lastMode, rec.Body.String())
	}
}
