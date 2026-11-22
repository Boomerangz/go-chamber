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

func TestSkillCommandsMatchInstructionsAndDeduplicate(t *testing.T) {
	root, global := t.TempDir(), t.TempDir()
	for name, body := range map[string]string{
		".agents/skills/chart/SKILL.md":  "---\nname: chart\ndescription: Plot metrics\n---\nprimary",
		".claude/skills/chart/SKILL.md":  "---\ndescription: Other chart\n---\nsecondary",
		".codex/skills/compact/SKILL.md": "reserved",
	} {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	p := filepath.Join(global, "review", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("---\ndescription: Review changes\n---\nreview"), 0644); err != nil {
		t.Fatal(err)
	}
	commands, err := SkillCommands(root, []string{global})
	if err != nil || len(commands) != 2 {
		t.Fatalf("commands=%+v err=%v", commands, err)
	}
	if commands[0].Name != "chart" || commands[0].Insert != "/chart" || commands[0].Description != "Plot metrics" || commands[1].Insert != "/review" {
		t.Fatalf("%+v", commands)
	}
	instructions, err := InstructionsWithSkills(root, []string{global})
	if err != nil || !strings.Contains(instructions, "/chart") || strings.Contains(instructions, "Other chart") || !strings.Contains(instructions, p) {
		t.Fatalf("instructions=%s err=%v", instructions, err)
	}
}

func TestUnreadableSkillDoesNotHideOthers(t *testing.T) {
	cwd := t.TempDir()
	good := filepath.Join(cwd, ".claude/skills/good")
	broken := filepath.Join(cwd, ".claude/skills/broken")
	for _, dir := range []string{good, broken} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(good, "SKILL.md"), []byte("description: works\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(cwd, "missing"), filepath.Join(broken, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	commands, err := SkillCommands(cwd, nil)
	if err != nil || len(commands) != 1 || commands[0].Name != "good" {
		t.Fatalf("commands = %+v, err = %v", commands, err)
	}
}
