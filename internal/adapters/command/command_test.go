package command_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/adapters/command"
)

func TestRunnerBoundsOutputAndReturnsExitCode(t *testing.T) {
	r := command.Runner{}
	out, err := r.Run(context.Background(), "/bin/sh", []string{"-c", "printf '%070000d' 1; printf 'oops' >&2; exit 7"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if out.ExitCode != 7 || !out.StdoutTruncated || len(out.Stdout) > 65536 || out.Stderr != "oops" {
		t.Fatalf("result: exit=%d stdout_length=%d truncated=%v stderr=%q", out.ExitCode, len(out.Stdout), out.StdoutTruncated, out.Stderr)
	}
}

func TestRunnerCancelsDescendants(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "orphan-wrote")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := (command.Runner{}).Run(ctx, "/bin/sh", []string{"-c", `(sleep 0.4; printf leaked > "$1") & wait`, "sh", marker}, t.TempDir())
	if err == nil {
		t.Fatal("expected timeout")
	}
	time.Sleep(600 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a descendant survived the timeout")
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestRunnerCancelsLongRunningCommand(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := (command.Runner{}).Run(ctx, "/bin/sleep", []string{"5"}, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("cancellation: %v", err)
	}
}
