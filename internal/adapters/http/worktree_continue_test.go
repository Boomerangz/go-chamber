package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func (s *stubWorktrees) Continue(_ context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error) {
	s.agent, s.dir, s.name, s.continued = agent, dir, name, true
	return domain.SessionSnapshot{ID: "wt2", Cwd: "/wt/app/" + name}, s.err
}

// "continue" starts the worktree on the branch that is already there.
func TestCreateWorktreeOnTheExistingBranch(t *testing.T) {
	stub := &stubWorktrees{}
	h := newWorktreeServer(stub, &fakeSessions{})
	rec := do(h, authed("POST", "/api/worktrees", `{"agent":"codex","cwd":"/src/app","branch":"fix","continue":true}`))
	if rec.Code != http.StatusCreated || !stub.continued || stub.agent != domain.AgentCodex || stub.name != "fix" {
		t.Fatalf("code %d body %s stub %+v", rec.Code, rec.Body.String(), stub)
	}
	stub.continued = false
	if rec := do(h, authed("POST", "/api/worktrees", `{"agent":"claude","cwd":"/src/app","branch":"fix"}`)); rec.Code != http.StatusCreated || stub.continued {
		t.Fatalf("a new branch continued: %d", rec.Code)
	}
}

// Branch refusals carry a code: one that can be continued on, one checked
// out elsewhere (the message says where), one that isn't there.
func TestBranchRefusalCodes(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{app.ErrBranchExists, http.StatusConflict, "branch_exists"},
		{&app.BranchInUseError{Branch: "chamber/x", Path: "/wt/x"}, http.StatusConflict, "branch_checked_out"},
		{app.ErrNoBranch, http.StatusConflict, "no_branch"},
	} {
		h := newWorktreeServer(&stubWorktrees{err: tc.err}, &fakeSessions{})
		rec := do(h, authed("POST", "/api/worktrees", `{"agent":"claude","cwd":"/x","branch":"b"}`))
		var body errorBody
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != tc.status || body.Code != tc.code || body.Error != tc.err.Error() {
			t.Errorf("%v: %d %+v", tc.err, rec.Code, body)
		}
	}
}
