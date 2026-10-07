package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// A shell is not started where its folder is gone: the refusal names the
// folder, so the client can say so instead of a raw fork/exec error.
func TestOpenTerminalRefusesAMissingFolder(t *testing.T) {
	probe := &folderProbe{existing: map[string]bool{"/home/me": true}}
	f := newTermFixture(t, func(c *TerminalsConfig) { c.Folders = probe })
	ctx := context.Background()
	_ = f.repo.Save(ctx, domain.SessionSnapshot{ID: "s1", Agent: domain.AgentClaude, Cwd: "/work/doomed"})
	_, err := f.terms.Open(ctx, OpenTerminal{SessionID: "s1"})
	if !errors.Is(err, domain.ErrFolderGone) || err.Error() != "Folder /work/doomed no longer exists" {
		t.Fatalf("session: err = %v", err)
	}
	_, err = f.terms.Open(ctx, OpenTerminal{Cwd: "/nope"})
	if !errors.Is(err, domain.ErrFolderGone) || err.Error() != "Folder /nope doesn't exist" {
		t.Fatalf("cwd: err = %v", err)
	}
	if len(f.factory.specs) != 0 {
		t.Fatal("a shell was started in a missing folder")
	}
	if _, err := f.terms.Open(ctx, OpenTerminal{}); err != nil {
		t.Fatalf("home: %v", err)
	}
	probe.mu.Lock()
	probe.err = errors.New("stat: permission denied")
	probe.mu.Unlock()
	if _, err := f.terms.Open(ctx, OpenTerminal{}); err == nil || errors.Is(err, domain.ErrFolderGone) {
		t.Fatalf("unreadable: err = %v", err)
	}
}

// Changes of a session whose folder is gone say so with the folder named,
// not with git's own error.
func TestChangesOfAMissingFolderSayItIsGone(t *testing.T) {
	m, _, _, _ := newArchiveManager(t)
	git := &fakeGit{top: "/src/app", chErr: errors.New("git rev-parse: chdir: no such file or directory")}
	probe := &folderProbe{existing: map[string]bool{"/src/app": true}}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees", Folders: probe})
	ctx := context.Background()
	s, err := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	if err != nil {
		t.Fatal(err)
	}
	probe.remove("/src/app")
	if _, err := w.Changes(ctx, s.ID); !errors.Is(err, domain.ErrFolderGone) || err.Error() != "Folder /src/app no longer exists" {
		t.Fatalf("changes: err = %v", err)
	}
	if _, err := w.FileDiff(ctx, s.ID, "a.go"); !errors.Is(err, domain.ErrFolderGone) {
		t.Fatalf("diff: err = %v", err)
	}
	if git.gotDir != "" {
		t.Fatal("asked git about a folder that is gone")
	}
	probe.mu.Lock()
	probe.err = errors.New("stat: permission denied")
	probe.mu.Unlock()
	if _, err := w.Changes(ctx, s.ID); err == nil || errors.Is(err, domain.ErrFolderGone) {
		t.Fatalf("unreadable: err = %v", err)
	}
}
