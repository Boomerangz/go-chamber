package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type stubWorktrees struct {
	agent     domain.AgentKind
	dir, name string
	force     bool
	path      string
	err       error
}

func (s *stubWorktrees) Create(_ context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error) {
	s.agent, s.dir, s.name = agent, dir, name
	return domain.SessionSnapshot{ID: "wt1", Cwd: "/wt/app/" + name}, s.err
}

func (s *stubWorktrees) Remove(_ context.Context, id domain.SessionID, force bool) (domain.SessionSnapshot, error) {
	s.force = force
	return domain.SessionSnapshot{ID: id}, s.err
}

func (s *stubWorktrees) Changes(_ context.Context, id domain.SessionID) (app.Changes, error) {
	return app.Changes{Repository: true, Base: "HEAD", Files: []app.FileChange{{Path: "a.go", Status: "M"}}}, s.err
}

func (s *stubWorktrees) FileDiff(_ context.Context, id domain.SessionID, path string) (string, error) {
	s.path = path
	return "+x", s.err
}

func newWorktreeServer(w Worktrees, sessions Sessions) http.Handler {
	return NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Worktrees: w, Sessions: sessions})
}

func TestCreateWorktreeEndpoint(t *testing.T) {
	stub, sessions := &stubWorktrees{}, &fakeSessions{}
	h := newWorktreeServer(stub, sessions)
	rec := do(h, authed("POST", "/api/worktrees", `{"agent":"claude","cwd":"/src/app","branch":"fix","model":"haiku"}`))
	if rec.Code != http.StatusCreated || stub.agent != domain.AgentClaude || stub.dir != "/src/app" || stub.name != "fix" {
		t.Fatalf("code %d body %s stub %+v", rec.Code, rec.Body.String(), stub)
	}
	if sessions.model != [2]string{"haiku", ""} {
		t.Fatalf("model not applied to the new session: %+v", sessions)
	}
	if rec := do(h, authed("POST", "/api/worktrees", `{`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body: %d", rec.Code)
	}
	sessions.err = domain.ErrInvalidModel
	if rec := do(h, authed("POST", "/api/worktrees", `{"agent":"claude","cwd":"/x","branch":"b","effort":"x"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad model: %d", rec.Code)
	}
}

func TestWorktreeEndpoints(t *testing.T) {
	stub := &stubWorktrees{}
	h := newWorktreeServer(stub, nil)
	rec := do(h, authed("GET", "/api/sessions/s1/changes", ""))
	var changes app.Changes
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &changes) != nil || changes.Files[0].Path != "a.go" {
		t.Fatalf("changes: %d %s", rec.Code, rec.Body.String())
	}
	rec = do(h, authed("GET", "/api/sessions/s1/changes/diff?path=src/a.go", ""))
	if rec.Code != http.StatusOK || stub.path != "src/a.go" || rec.Body.String() != "{\"diff\":\"+x\"}\n" {
		t.Fatalf("diff: %d %q", rec.Code, rec.Body.String())
	}
	rec = do(h, authed("DELETE", "/api/sessions/s1/worktree?force=1", ""))
	if rec.Code != http.StatusOK || !stub.force {
		t.Fatalf("remove: %d force=%v", rec.Code, stub.force)
	}
}

func TestWorktreeErrors(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code int
	}{
		{app.ErrNotRepository, http.StatusBadRequest},
		{app.ErrInvalidPath, http.StatusBadRequest},
		{app.ErrWorktreeDirty, http.StatusConflict},
		{app.ErrNoWorktree, http.StatusConflict},
		{app.ErrSessionNotFound, http.StatusNotFound},
		{errors.New("boom"), http.StatusInternalServerError},
	} {
		h := newWorktreeServer(&stubWorktrees{err: tc.err}, nil)
		for _, r := range []*http.Request{
			authed("POST", "/api/worktrees", `{"agent":"claude","cwd":"/x","branch":"b"}`),
			authed("DELETE", "/api/sessions/s1/worktree", ""),
			authed("GET", "/api/sessions/s1/changes", ""),
			authed("GET", "/api/sessions/s1/changes/diff?path=a", ""),
		} {
			if rec := do(h, r); rec.Code != tc.code {
				t.Errorf("%v %s %s: code %d, want %d", tc.err, r.Method, r.URL.Path, rec.Code, tc.code)
			}
		}
	}
}

func TestWorktreeRoutesNeedAWorktreeService(t *testing.T) {
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}})
	if rec := do(h, authed("GET", "/api/sessions/s1/changes", "")); rec.Code == http.StatusOK {
		t.Fatalf("route served without a service: %d", rec.Code)
	}
}
