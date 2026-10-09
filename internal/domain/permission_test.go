package domain

import (
	"errors"
	"testing"
)

func TestPermissionModeIsCheckedPerAgent(t *testing.T) {
	claude, _ := NewSession("c", AgentClaude, "/w")
	codex, _ := NewSession("x", AgentCodex, "/w")
	for _, tc := range []struct {
		s    *Session
		mode string
		ok   bool
	}{
		{claude, "plan", true},
		{claude, "acceptEdits", true},
		{claude, "bypassPermissions", true},
		{claude, "default", true},
		{claude, "", true},
		{claude, "full-access", false},
		{codex, "read-only", true},
		{codex, "auto", true},
		{codex, "full-access", true},
		{codex, "plan", false},
	} {
		err := tc.s.SetPermissionMode(tc.mode)
		if tc.ok != (err == nil) {
			t.Errorf("%s SetPermissionMode(%q) = %v", tc.s.Agent(), tc.mode, err)
		}
		if !tc.ok && !errors.Is(err, ErrInvalidPermissionMode) {
			t.Errorf("err = %v, want ErrInvalidPermissionMode", err)
		}
	}
	if got := codex.PermissionMode(); got != "full-access" {
		t.Fatalf("an invalid mode changed the mode to %q", got)
	}
}

func TestPermissionModeSurvivesRestoreAndFork(t *testing.T) {
	s, _ := NewSession("s", AgentClaude, "/w")
	_ = s.SetPermissionMode("plan")
	snap := s.Snapshot()
	if snap.PermissionMode != "plan" {
		t.Fatalf("snapshot mode = %q", snap.PermissionMode)
	}
	r, _ := RestoreSession(snap)
	if r.PermissionMode() != "plan" {
		t.Fatalf("restored mode = %q", r.PermissionMode())
	}
	_ = r.RuntimeAttached("native")
	f, err := NewForkSession("f", r)
	if err != nil {
		t.Fatal(err)
	}
	if f.PermissionMode() != "plan" {
		t.Fatalf("fork mode = %q", f.PermissionMode())
	}
}

func TestAcceptsPermissionModeMatchesTheSession(t *testing.T) {
	for _, tc := range []struct {
		agent AgentKind
		mode  string
		ok    bool
	}{
		{AgentClaude, "plan", true},
		{AgentClaude, "", true},
		{AgentCodex, "plan", false},
		{AgentOpenCode, "plan", false},
		{AgentOpenCode, "", true},
	} {
		if got := AcceptsPermissionMode(tc.agent, tc.mode); got != tc.ok {
			t.Errorf("AcceptsPermissionMode(%s, %q) = %v", tc.agent, tc.mode, got)
		}
	}
}

func TestOnlyModesWithoutAnyCheckAreUnbounded(t *testing.T) {
	for mode, want := range map[string]bool{
		"bypassPermissions": true, "full-access": true,
		"": false, "default": false, "plan": false, "acceptEdits": false, "read-only": false, "auto": false,
	} {
		if got := UnboundedPermissionMode(mode); got != want {
			t.Errorf("UnboundedPermissionMode(%q) = %v", mode, got)
		}
	}
}
