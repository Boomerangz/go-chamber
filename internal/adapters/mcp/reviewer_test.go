package mcpapi_test

import (
	"slices"
	"strings"
	"testing"

	mcpapi "github.com/igorzygin/go-chamber/internal/adapters/mcp"
)

func TestStartSessionAutoReviewerRequiresExplicitOptIn(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	res, _ := f.call(t, "start_session", map[string]any{
		"agent": "codex", "cwd": "/repo", "permission_mode": "auto", "approval_reviewer": "auto_review", "message": "go",
	})
	if !res.IsError || !strings.Contains(text(res), "mcp-allow-auto-review") || len(f.sessions.recorded()) != 0 {
		t.Fatalf("result=%s calls=%q", text(res), f.sessions.recorded())
	}
}

func TestStartSessionAutoReviewerIsAppliedBeforeFirstTurn(t *testing.T) {
	f := newFixture(t, mcpapi.Config{AllowAutoReviewer: true}, nil)
	out := f.mustCall(t, "start_session", map[string]any{
		"agent": "codex", "cwd": "/repo", "permission_mode": "auto", "approval_reviewer": "auto_review", "message": "go",
	})
	if out["session"].(map[string]any)["approval_reviewer"] != "auto_review" {
		t.Fatalf("session=%v", out["session"])
	}
	want := []string{"create codex /repo origin=mcp", "mode new1 auto origin=mcp", "reviewer new1 auto_review origin=mcp", "steer new1 go origin=mcp"}
	if got := f.sessions.recorded(); !slices.Equal(got, want) {
		t.Fatalf("calls=%q want=%q", got, want)
	}
}

func TestStartSessionRejectsInvalidReviewerBeforeCreating(t *testing.T) {
	f := newFixture(t, mcpapi.Config{AllowAutoReviewer: true}, nil)
	res, _ := f.call(t, "start_session", map[string]any{"agent": "codex", "cwd": "/repo", "approval_reviewer": "robot"})
	if !res.IsError || len(f.sessions.recorded()) != 0 {
		t.Fatalf("result=%s calls=%q", text(res), f.sessions.recorded())
	}
}

func TestStartSessionUserReviewerDoesNotNeedAutoOptIn(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	out := f.mustCall(t, "start_session", map[string]any{"agent": "codex", "cwd": "/repo", "approval_reviewer": "user"})
	if out["session"].(map[string]any)["approval_reviewer"] != "user" {
		t.Fatalf("session=%v", out["session"])
	}
}

func TestStartSessionOmittedReviewerUsesAgentDefault(t *testing.T) {
	f := newFixture(t, mcpapi.Config{}, nil)
	out := f.mustCall(t, "start_session", map[string]any{"agent": "codex", "cwd": "/repo"})
	if _, ok := out["session"].(map[string]any)["approval_reviewer"]; ok {
		t.Fatalf("session=%v", out["session"])
	}
	if got := f.sessions.recorded(); !slices.Equal(got, []string{"create codex /repo origin=mcp"}) {
		t.Fatalf("calls=%q", got)
	}
}

func TestStartSessionWorktreeGetsReviewerBeforeMessage(t *testing.T) {
	f := newFixture(t, mcpapi.Config{AllowAutoReviewer: true}, nil)
	out := f.mustCall(t, "start_session", map[string]any{"agent": "codex", "cwd": "/repo", "branch": "reviewer-check", "approval_reviewer": "auto_review", "message": "go"})
	if out["session"].(map[string]any)["approval_reviewer"] != "auto_review" {
		t.Fatalf("session=%v", out["session"])
	}
	got := f.sessions.recorded()
	if len(got) < 3 || got[len(got)-2] != "reviewer new1 auto_review origin=mcp" || got[len(got)-1] != "steer new1 go origin=mcp" {
		t.Fatalf("calls=%q", got)
	}
}

func TestStartSessionRejectsAutoReviewerForClaudeBeforeCreating(t *testing.T) {
	f := newFixture(t, mcpapi.Config{AllowAutoReviewer: true}, nil)
	res, _ := f.call(t, "start_session", map[string]any{"agent": "claude", "cwd": "/repo", "approval_reviewer": "auto_review"})
	if !res.IsError || len(f.sessions.recorded()) != 0 {
		t.Fatalf("result=%s calls=%q", text(res), f.sessions.recorded())
	}
}
