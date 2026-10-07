package domain

import (
	"strings"
	"testing"
)

func TestOpenCodeSessionAndQualifiedModel(t *testing.T) {
	s, err := NewSession("oc", AgentKind("opencode"), "/project")
	if err != nil {
		t.Fatal(err)
	}
	model := "openrouter/vendor/" + strings.Repeat("model", 35)
	if err := s.SetModel(model, "high"); err != nil {
		t.Fatal(err)
	}
	if _, err := RestoreSession(s.Snapshot()); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPermissionMode("full-access"); err == nil {
		t.Fatal("OpenCode must keep native permission rules")
	}
	if !strings.Contains(CLIMissing(AgentKind("opencode")).Error(), "OpenCode") || InstallHint(AgentKind("opencode")) == "" {
		t.Fatal("missing installation guidance")
	}
}
