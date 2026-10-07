package fsys

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestPathCLIsFindsOnlyInstalledCLIs(t *testing.T) {
	dir := t.TempDir()
	codex := filepath.Join(dir, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Not executable: a CLI that can't run is not installed.
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	var clis PathCLIs
	if path, ok := clis.FindCLI(domain.AgentCodex); !ok || path != codex {
		t.Fatalf("codex = %q, %v", path, ok)
	}
	if path, ok := clis.FindCLI(domain.AgentClaude); ok || path != "" {
		t.Fatalf("claude = %q, %v", path, ok)
	}
}

func TestPathCLIsUsesTheConfiguredBinary(t *testing.T) {
	dir := t.TempDir()
	custom := filepath.Join(dir, "my-claude")
	if err := os.WriteFile(custom, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	clis := PathCLIs{Binaries: map[domain.AgentKind]string{domain.AgentClaude: "my-claude"}}
	if path, ok := clis.FindCLI(domain.AgentClaude); !ok || path != custom {
		t.Fatalf("claude = %q, %v", path, ok)
	}
}
