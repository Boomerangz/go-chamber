package nativetools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestDiscoveryAndWorkspaceInstructions(t *testing.T) {
	root := t.TempDir()
	for name, text := range map[string]string{"AGENTS.md": "Use Go tests.", "main.go": "package main\n// needle\n", ".agents/skills/check/SKILL.md": "---\nname: check\ndescription: Run checks\n---\nCheck carefully."} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0644); err != nil {
			t.Fatal(err)
		}
	}
	instructions, err := Instructions(root)
	if err != nil || !strings.Contains(instructions, "Use Go tests.") || !strings.Contains(instructions, "check/SKILL.md") {
		t.Fatalf("%s %v", instructions, err)
	}
	tools := &Tools{Cwd: root}
	for _, tc := range []struct{ name, args, want string }{{"ls", `{"path":"."}`, "main.go"}, {"find", `{"pattern":"*.go"}`, "main.go"}, {"grep", `{"pattern":"needle"}`, "main.go:2:"}} {
		out, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: tc.name, Arguments: json.RawMessage(tc.args)})
		if err != nil || !strings.Contains(out, tc.want) {
			t.Fatalf("%s: %s %v", tc.name, out, err)
		}
		if tools.NeedsApproval(domain.ModelToolCall{Name: tc.name}) {
			t.Fatal("read-only tool asked permission")
		}
	}
}
