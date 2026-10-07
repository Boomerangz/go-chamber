package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeGit struct {
	top      string
	topErr   error
	addErr   error
	added    []string
	removed  []domain.Worktree
	forced   []bool
	removeEr error
	changes  []FileChange
	chErr    error
	gotDir   string
	gotBase  string
	gotPath  string

	commits    int
	commitsErr error
	gotCommits string

	ahead    int
	head     string
	aheadErr error
	gotAhead string
}

func (g *fakeGit) Ahead(_ context.Context, repo, branch string) (int, string, error) {
	g.gotAhead = repo + "|" + branch
	return g.ahead, g.head, g.aheadErr
}

func (g *fakeGit) Toplevel(_ context.Context, dir string) (string, error) {
	if g.topErr != nil {
		return "", g.topErr
	}
	if g.top != "" {
		return g.top, nil
	}
	return dir, nil
}

func (g *fakeGit) AddWorktree(_ context.Context, repo, path, branch string) (domain.Worktree, error) {
	if g.addErr != nil {
		return domain.Worktree{}, g.addErr
	}
	g.added = append(g.added, repo+"|"+path+"|"+branch)
	return domain.Worktree{Repo: repo, Path: path, Branch: branch, Base: "base1"}, nil
}

func (g *fakeGit) RemoveWorktree(_ context.Context, wt domain.Worktree, force bool) error {
	if g.removeEr != nil && !force {
		return g.removeEr
	}
	g.removed = append(g.removed, wt)
	g.forced = append(g.forced, force)
	return nil
}

func (g *fakeGit) Changes(_ context.Context, dir, base string) ([]FileChange, error) {
	g.gotDir, g.gotBase = dir, base
	return g.changes, g.chErr
}

func (g *fakeGit) Commits(_ context.Context, dir, base string) (int, error) {
	g.gotCommits = dir + "|" + base
	return g.commits, g.commitsErr
}

func (g *fakeGit) FileDiff(_ context.Context, dir, base, path string) (string, error) {
	g.gotDir, g.gotBase, g.gotPath = dir, base, path
	return "diff " + path, nil
}

func newTestWorktrees(t *testing.T) (*Worktrees, *Manager, *fakeGit, *fakeBus) {
	t.Helper()
	m, _, bus, _ := newArchiveManager(t)
	git := &fakeGit{top: "/src/app"}
	return NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees"}), m, git, bus
}

func TestCreateWorktreeSession(t *testing.T) {
	w, m, git, bus := newTestWorktrees(t)
	ctx := context.Background()
	snap, err := w.Create(ctx, domain.AgentClaude, "/src/app/sub", "Fix login bug!")
	if err != nil {
		t.Fatal(err)
	}
	if len(git.added) != 1 || git.added[0] != "/src/app|/data/worktrees/app/fix-login-bug|chamber/fix-login-bug" {
		t.Fatalf("added = %v", git.added)
	}
	if snap.Cwd != "/data/worktrees/app/fix-login-bug" || snap.Worktree == nil || snap.Worktree.Branch != "chamber/fix-login-bug" {
		t.Fatalf("snapshot = %+v", snap)
	}
	got, _ := m.GetSession(ctx, snap.ID)
	if got.Worktree == nil || got.Worktree.Base != "base1" {
		t.Fatalf("stored = %+v", got.Worktree)
	}
	evs := bus.snapshot()
	if last := evs[len(evs)-1]; last.Type != domain.EventSessionState || last.Session.Worktree == nil {
		t.Fatalf("last event = %+v", last)
	}
}

func TestCreateWorktreeRejectsEmptyName(t *testing.T) {
	w, _, git, _ := newTestWorktrees(t)
	if _, err := w.Create(context.Background(), domain.AgentClaude, "/src/app", " !! "); !errors.Is(err, ErrInvalidBranch) {
		t.Fatalf("err = %v", err)
	}
	if len(git.added) != 0 {
		t.Fatal("worktree added for an empty name")
	}
}

func TestCreateWorktreeOutsideARepository(t *testing.T) {
	w, _, git, _ := newTestWorktrees(t)
	git.topErr = ErrNotRepository
	if _, err := w.Create(context.Background(), domain.AgentClaude, "/tmp", "x"); !errors.Is(err, ErrNotRepository) {
		t.Fatalf("err = %v", err)
	}
	git.topErr, git.addErr = nil, errors.New("branch exists")
	if _, err := w.Create(context.Background(), domain.AgentClaude, "/src/app", "x"); err == nil {
		t.Fatal("add failure not reported")
	}
}

// A worktree asked for in a folder that isn't there says so, before git
// is asked anything.
func TestCreateWorktreeInAMissingFolder(t *testing.T) {
	m, _, _, _ := newArchiveManager(t)
	git := &fakeGit{top: "/src/app"}
	probe := &folderProbe{existing: map[string]bool{"/src/app": true}}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees", Folders: probe})
	_, err := w.Create(context.Background(), domain.AgentClaude, "/nonexistent/x", "fix")
	if !errors.Is(err, domain.ErrFolderGone) || err.Error() != "Folder /nonexistent/x doesn't exist" {
		t.Fatalf("err = %v", err)
	}
	if len(git.added) != 0 {
		t.Fatalf("added = %v", git.added)
	}
	probe.mu.Lock()
	probe.err = errors.New("stat: permission denied")
	probe.mu.Unlock()
	if _, err := w.Create(context.Background(), domain.AgentClaude, "/src/app", "fix"); err == nil || errors.Is(err, domain.ErrFolderGone) {
		t.Fatalf("err = %v", err)
	}
}

func TestCreateWorktreeCleansUpWhenTheSessionFails(t *testing.T) {
	w, _, git, _ := newTestWorktrees(t)
	if _, err := w.Create(context.Background(), domain.AgentKind("nope"), "/src/app", "x"); err == nil {
		t.Fatal("expected an error for an unknown agent")
	}
	if len(git.removed) != 1 || !git.forced[0] {
		t.Fatalf("removed = %v forced = %v", git.removed, git.forced)
	}
}

func TestRemoveWorktreeKeepsTheSession(t *testing.T) {
	w, m, git, bus := newTestWorktrees(t)
	ctx := context.Background()
	snap, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	git.removeEr = ErrWorktreeDirty
	if _, err := w.Remove(ctx, snap.ID, false); !errors.Is(err, ErrWorktreeDirty) {
		t.Fatalf("dirty: err = %v", err)
	}
	if got, _ := m.GetSession(ctx, snap.ID); got.Worktree.Removed {
		t.Fatal("a refused removal marked the worktree removed")
	}
	after, err := w.Remove(ctx, snap.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if after.Worktree == nil || !after.Worktree.Removed || after.Worktree.Branch != "chamber/x" || after.ID != snap.ID {
		t.Fatalf("after = %+v", after.Worktree)
	}
	if got, _ := m.GetSession(ctx, snap.ID); got.Worktree == nil || !got.Worktree.Removed {
		t.Fatalf("stored = %+v", got.Worktree)
	}
	evs := bus.snapshot()
	if last := evs[len(evs)-1]; last.Session == nil || last.Session.Worktree == nil || !last.Session.Worktree.Removed {
		t.Fatalf("last event = %+v", last)
	}
	if _, err := w.Remove(ctx, snap.ID, true); !errors.Is(err, ErrNoWorktree) {
		t.Fatalf("second remove: err = %v", err)
	}
	if len(git.removed) != 1 {
		t.Fatalf("git removed %d times", len(git.removed))
	}
	plain, _ := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	if _, err := w.Remove(ctx, plain.ID, true); !errors.Is(err, ErrNoWorktree) {
		t.Fatalf("plain: err = %v", err)
	}
	if _, err := w.Remove(ctx, "missing", true); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing: err = %v", err)
	}
}

func TestRemoveWorktreeRefusesARunningTurn(t *testing.T) {
	m, _, _, factory := newArchiveManager(t)
	git := &fakeGit{top: "/src/app"}
	w := NewWorktrees(WorktreesConfig{Sessions: m, Git: git, Root: "/data/worktrees"})
	ctx := context.Background()
	snap, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "go"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Remove(ctx, snap.ID, true); !errors.Is(err, domain.ErrSessionBusy) {
		t.Fatalf("err = %v", err)
	}
	if len(git.removed) != 0 {
		t.Fatal("git removed the folder under a running turn")
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool {
		got, _ := m.GetSession(ctx, snap.ID)
		return got.Status == domain.StatusIdle
	})
	if _, err := w.Remove(ctx, snap.ID, true); err != nil {
		t.Fatal(err)
	}
	eventually(t, "agent closed", func() bool {
		rt.mu.Lock()
		defer rt.mu.Unlock()
		return rt.closed
	})
}

func TestRemovedWorktreeSessionRefusesWork(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	snap, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	if _, err := w.Remove(ctx, snap.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(ctx, snap.ID, "hi"); !errors.Is(err, domain.ErrWorktreeRemoved) {
		t.Fatalf("send: err = %v", err)
	}
	git.gotDir = ""
	ch, err := w.Changes(ctx, snap.ID)
	if err != nil || !ch.Removed || ch.Branch != "chamber/x" || ch.Files == nil || len(ch.Files) != 0 {
		t.Fatalf("changes = %+v err = %v", ch, err)
	}
	if git.gotDir != "" {
		t.Fatal("asked git about a folder that is gone")
	}
	if _, err := w.FileDiff(ctx, snap.ID, "a.go"); !errors.Is(err, domain.ErrWorktreeRemoved) {
		t.Fatalf("diff: err = %v", err)
	}
}

func TestDeleteWorktreeSessionCanTakeTheFolder(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	keep, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "keep")
	if err := w.Delete(ctx, keep.ID, false); err != nil {
		t.Fatal(err)
	}
	if len(git.removed) != 0 {
		t.Fatal("the folder went without being asked")
	}
	if _, err := m.GetSession(ctx, keep.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("kept session: err = %v", err)
	}

	dirty, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "dirty")
	git.removeEr = ErrWorktreeDirty
	if err := w.Delete(ctx, dirty.ID, true); !errors.Is(err, ErrWorktreeDirty) {
		t.Fatalf("dirty: err = %v", err)
	}
	if _, err := m.GetSession(ctx, dirty.ID); err != nil {
		t.Fatalf("dirty session was deleted: %v", err)
	}
	git.removeEr = nil
	if err := w.Delete(ctx, dirty.ID, true); err != nil {
		t.Fatal(err)
	}
	if len(git.removed) != 1 || git.forced[0] {
		t.Fatalf("removed = %v forced = %v", git.removed, git.forced)
	}
	if _, err := m.GetSession(ctx, dirty.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("err = %v", err)
	}

	gone, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "gone")
	_, _ = w.Remove(ctx, gone.ID, true)
	plain, _ := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	for _, id := range []domain.SessionID{gone.ID, plain.ID} {
		if err := w.Delete(ctx, id, true); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if len(git.removed) != 2 {
		t.Fatalf("removed = %v", git.removed)
	}
	if err := w.Delete(ctx, "missing", true); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing: err = %v", err)
	}
}

func TestCreateWorktreeExplainsTheBranchName(t *testing.T) {
	w, _, _, _ := newTestWorktrees(t)
	_, err := w.Create(context.Background(), domain.AgentClaude, "/src/app", "Фича тест")
	if !errors.Is(err, ErrInvalidBranch) || !strings.Contains(err.Error(), "latin letters or digits") {
		t.Fatalf("err = %v", err)
	}
}

func TestChangesUseTheWorktreeBaseOrHEAD(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	wtSnap, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	git.changes = []FileChange{{Path: "a.go", Status: "M"}}
	ch, err := w.Changes(ctx, wtSnap.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !ch.Repository || ch.Base != "base1" || git.gotDir != wtSnap.Cwd || len(ch.Files) != 1 || ch.Root != "/src/app" {
		t.Fatalf("changes = %+v dir = %s", ch, git.gotDir)
	}
	plain, _ := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	git.changes = nil
	ch, _ = w.Changes(ctx, plain.ID)
	if ch.Base != "HEAD" || ch.Files == nil {
		t.Fatalf("plain = %+v", ch)
	}
	git.chErr = ErrNotRepository
	ch, err = w.Changes(ctx, plain.ID)
	if err != nil || ch.Repository {
		t.Fatalf("not a repo: %+v %v", ch, err)
	}
	git.chErr = errors.New("boom")
	if _, err := w.Changes(ctx, plain.ID); err == nil {
		t.Fatal("git failure not reported")
	}
	git.chErr, git.topErr = nil, errors.New("top")
	if _, err := w.Changes(ctx, plain.ID); err == nil {
		t.Fatal("toplevel failure not reported")
	}
	git.topErr = nil
	if _, err := w.Changes(ctx, "missing"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing: err = %v", err)
	}
}

func TestFileDiffRejectsPathsOutsideTheFolder(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	s, _ := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	for _, p := range []string{"", "/etc/passwd", "../x", "a/../../x", ".."} {
		if _, err := w.FileDiff(ctx, s.ID, p); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("%q: err = %v", p, err)
		}
	}
	diff, err := w.FileDiff(ctx, s.ID, "./src/a.go")
	if err != nil || diff != "diff src/a.go" || git.gotBase != "HEAD" {
		t.Fatalf("diff = %q err = %v base = %s", diff, err, git.gotBase)
	}
	if _, err := w.FileDiff(ctx, "missing", "a"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing: err = %v", err)
	}
}

func TestSlugify(t *testing.T) {
	for in, want := range map[string]string{
		"Fix login bug!":    "fix-login-bug",
		"chamber/feature.x": "feature.x",
		"...a..b":           "a.b",
		"  ":                "",
		"Привет world":      "world",
		"a_b-c":             "a_b-c",
		"x0123456789012345678901234567890123456789012345678901234": "x0123456789012345678901234567890123456789012345678",
	} {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSetWorktreeRejectsAnotherFolder(t *testing.T) {
	_, m, _, _ := newTestWorktrees(t)
	ctx := context.Background()
	s, _ := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	if _, err := m.SetWorktree(ctx, s.ID, &domain.Worktree{Repo: "r", Path: "/elsewhere", Branch: "b", Base: "c"}); !errors.Is(err, domain.ErrInvalidSession) {
		t.Fatalf("err = %v", err)
	}
	if _, err := m.SetWorktree(ctx, "missing", nil); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing: err = %v", err)
	}
}
