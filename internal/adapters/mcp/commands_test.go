package mcpapi_test

import (
	"context"
	"slices"
	"testing"

	"github.com/igorzygin/go-chamber/internal/adapters/command"
	mcpapi "github.com/igorzygin/go-chamber/internal/adapters/mcp"
)

func TestCommandToolRequiresExplicitOptIn(t *testing.T) {
	f := newFixture(t, mcpapi.Config{Commands: command.Runner{}}, nil)
	tools, err := f.client.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "run_command" {
			t.Fatal("remote shell exposed without opt-in")
		}
	}
}

func TestRunCommandExecutesInRequestedDirectory(t *testing.T) {
	f := newFixture(t, mcpapi.Config{Commands: command.Runner{}, AllowCommands: true}, nil)
	tools, err := f.client.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	if !slices.Contains(names, "run_command") {
		t.Fatal("run_command missing")
	}
	cwd := t.TempDir()
	out := f.mustCall(t, "run_command", map[string]any{"program": "/bin/pwd", "cwd": cwd})
	if out["stdout"] != cwd+"\n" || out["exit_code"] != float64(0) {
		t.Fatalf("command result = %v", out)
	}
}

func TestRunCommandRejectsRelativeDirectory(t *testing.T) {
	f := newFixture(t, mcpapi.Config{Commands: command.Runner{}, AllowCommands: true}, nil)
	res, _ := f.call(t, "run_command", map[string]any{"program": "/bin/pwd", "cwd": "relative"})
	if !res.IsError {
		t.Fatal("relative cwd accepted")
	}
}
