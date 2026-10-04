package httpapi

import (
	"net/http"
	"testing"
)

func TestWorktreePermissionMode(t *testing.T) {
	lastMode = ""
	h := newWorktreeServer(&stubWorktrees{}, &fakeSessions{})
	rec := do(h, authed("POST", "/api/worktrees", `{"agent":"claude","cwd":"/p","branch":"x","permissionMode":"plan"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if lastMode != "plan" {
		t.Fatalf("worktree creation ignored mode, got %q", lastMode)
	}
}
