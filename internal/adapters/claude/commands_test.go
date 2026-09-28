package claude

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestCommandsComeFromTheCLIInitialize(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr}
	got, err := f.Commands(context.Background(), domain.AgentClaude, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	want := []app.Command{
		{Name: "compact", Description: "Clear history but keep a summary", ArgumentHint: "<instructions>", Insert: "/compact"},
		{Name: "review-mr", Description: "Review a merge request (user)", Insert: "/review-mr"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestCommandsAreCachedPerFolder(t *testing.T) {
	counter := filepath.Join(t.TempDir(), "count")
	// A script that counts its launches and then behaves like the fake.
	script := filepath.Join(t.TempDir(), "claude")
	body := "#!/bin/sh\necho x >> " + counter + "\nexec " + fakeBin + " \"$@\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	f := &Factory{Binary: script, Stderr: os.Stderr}
	dir := t.TempDir()
	for range 3 {
		if _, err := f.Commands(context.Background(), domain.AgentClaude, dir); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(counter)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "x\n" {
		t.Fatalf("launched %q", b)
	}
}

func TestCommandsFailWhenTheCLIDoesNotAnswer(t *testing.T) {
	f := &Factory{Binary: fakeBin, Env: []string{"FAKECLAUDE_MODE=nocontrol"}, Stderr: os.Stderr}
	ctx, cancel := context.WithTimeout(context.Background(), 300_000_000)
	defer cancel()
	if _, err := f.Commands(ctx, domain.AgentClaude, t.TempDir()); err == nil {
		t.Fatal("expected an error")
	}
}

func TestCommandsWithoutTheCLI(t *testing.T) {
	f := &Factory{Binary: filepath.Join(t.TempDir(), "missing"), Stderr: os.Stderr}
	if _, err := f.Commands(context.Background(), domain.AgentClaude, t.TempDir()); err == nil {
		t.Fatal("expected an error")
	}
}
