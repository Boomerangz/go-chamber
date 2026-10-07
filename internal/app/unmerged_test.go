package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// forkOfRemovedWorktree makes a worktree session, removes its worktree and
// forks it into the repository.
func forkOfRemovedWorktree(t *testing.T) (*Worktrees, *Manager, *fakeGit, domain.SessionSnapshot, domain.SessionSnapshot) {
	t.Helper()
	m, _, _, factory := newArchiveManager(t)
	git := &fakeGit{top: "/src/app"}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees"})
	ctx := context.Background()
	parent, err := w.Create(ctx, domain.AgentClaude, "/src/app", "fix")
	if err != nil {
		t.Fatal(err)
	}
	rt := newFakeRuntime("native-1")
	startWith(t, m, factory, parent.ID, rt)
	endTurn(t, m, rt, parent.ID)
	if parent, err = w.Remove(ctx, parent.ID, false); err != nil {
		t.Fatal(err)
	}
	factory.next = newFakeRuntime("native-2")
	fork, err := m.Fork(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	return w, m, git, parent, fork
}

func TestUnmergedNamesTheBranchAForkLeftBehind(t *testing.T) {
	w, _, git, parent, fork := forkOfRemovedWorktree(t)
	git.ahead, git.head = 2, "main"
	got, err := w.Unmerged(context.Background(), fork.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := Unmerged{Branch: "chamber/fix", Into: "main", Ahead: 2, Merge: "git -C /src/app merge chamber/fix"}
	if got == nil || *got != want {
		t.Fatalf("unmerged = %+v, want %+v", got, want)
	}
	if git.gotAhead != "/src/app|chamber/fix" {
		t.Fatalf("asked git about %q", git.gotAhead)
	}
	// The parent itself shows its branch in Changes, not here.
	if got, err := w.Unmerged(context.Background(), parent.ID); err != nil || got != nil {
		t.Fatalf("parent: %+v, %v", got, err)
	}
}

func TestUnmergedIsNothingOnceTheBranchIsMerged(t *testing.T) {
	w, _, git, _, fork := forkOfRemovedWorktree(t)
	git.ahead, git.head = 0, "main"
	if got, err := w.Unmerged(context.Background(), fork.ID); err != nil || got != nil {
		t.Fatalf("unmerged = %+v, %v", got, err)
	}
}

func TestUnmergedReportsGitFailures(t *testing.T) {
	w, _, git, _, fork := forkOfRemovedWorktree(t)
	git.aheadErr = errors.New("boom")
	if _, err := w.Unmerged(context.Background(), fork.ID); !errors.Is(err, git.aheadErr) {
		t.Fatalf("err = %v", err)
	}
}

func TestUnmergedQuotesAFolderAShellWouldSplit(t *testing.T) {
	if got := mergeCommand("/src/my app", "chamber/x"); got != "git -C '/src/my app' merge chamber/x" {
		t.Fatalf("command = %q", got)
	}
	if got := mergeCommand("/src/it's", "chamber/x"); got != `git -C '/src/it'\''s' merge chamber/x` {
		t.Fatalf("command = %q", got)
	}
}

func TestUnmergedIsNothingForOtherSessions(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	git.ahead = 3
	plain, err := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	if err != nil {
		t.Fatal(err)
	}
	live, err := w.Create(ctx, domain.AgentClaude, "/src/app", "live")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []domain.SessionID{plain.ID, live.ID} {
		if got, err := w.Unmerged(ctx, id); err != nil || got != nil {
			t.Fatalf("%s: %+v, %v", id, got, err)
		}
	}
	if _, err := w.Unmerged(ctx, "missing"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if git.gotAhead != "" {
		t.Fatal("git asked for a session with no branch left behind")
	}
}

func TestUnmergedForAForkOfALiveWorktreeOrAGoneParent(t *testing.T) {
	m, repo, _, factory := newArchiveManager(t)
	git := &fakeGit{top: "/src/app", ahead: 1}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees"})
	ctx := context.Background()
	parent, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "fix")
	rt := newFakeRuntime("native-1")
	startWith(t, m, factory, parent.ID, rt)
	endTurn(t, m, rt, parent.ID)
	factory.next = newFakeRuntime("native-2")
	fork, err := m.Fork(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	// A fork of a live worktree works in that worktree, on the branch.
	if got, err := w.Unmerged(ctx, fork.ID); err != nil || got != nil {
		t.Fatalf("fork of a live worktree: %+v, %v", got, err)
	}
	// A plain fork whose parent was deleted has no branch to name.
	snap, _ := repo.Get(ctx, fork.ID)
	snap.Worktree, snap.Cwd, snap.ForkOf = nil, "/src/app", "deleted"
	if err := repo.Save(ctx, snap); err != nil {
		t.Fatal(err)
	}
	other := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: newFakeBus()})
	t.Cleanup(other.Close)
	w2 := NewWorktrees(WorktreesConfig{Sessions: other, Git: git, Root: "/data/worktrees"})
	if got, err := w2.Unmerged(ctx, fork.ID); err != nil || got != nil {
		t.Fatalf("gone parent: %+v, %v", got, err)
	}
}
