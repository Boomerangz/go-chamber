package git

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

func sh(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newRepo is a repository with one commit holding a.txt and a .gitignore.
func newRepo(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(dir, "app")
	sh(t, dir, "init", "-q", "-b", "main", repo)
	write(t, filepath.Join(repo, "a.txt"), "one\n")
	write(t, filepath.Join(repo, ".gitignore"), "ignored.txt\n")
	sh(t, repo, "add", ".")
	sh(t, repo, "commit", "-q", "-m", "init")
	return repo
}

var _ app.GitRepo = Repo{}

func TestWorktreeLifecycle(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	top, err := Repo{}.Toplevel(ctx, repo)
	if err != nil || top != repo {
		t.Fatalf("toplevel = %q, %v", top, err)
	}
	path := filepath.Join(filepath.Dir(repo), "wt", "app", "fix")
	wt, err := Repo{}.AddWorktree(ctx, repo, path, "chamber/fix")
	if err != nil {
		t.Fatal(err)
	}
	if wt.Path != path || wt.Branch != "chamber/fix" || wt.Repo != repo || len(wt.Base) != 40 {
		t.Fatalf("worktree = %+v", wt)
	}
	if _, err := os.Stat(filepath.Join(path, "a.txt")); err != nil {
		t.Fatalf("worktree not checked out: %v", err)
	}

	write(t, filepath.Join(path, "a.txt"), "two\n")
	write(t, filepath.Join(path, "new.txt"), "fresh\n")
	write(t, filepath.Join(path, "ignored.txt"), "x\n")
	changes, err := Repo{}.Changes(ctx, path, wt.Base)
	if err != nil {
		t.Fatal(err)
	}
	want := []app.FileChange{{Path: "a.txt", Status: "M", Added: 1, Removed: 1}, {Path: "new.txt", Status: "?", Added: 1}}
	if len(changes) != 2 || changes[0] != want[0] || changes[1] != want[1] {
		t.Fatalf("changes = %+v", changes)
	}

	// Committed work on the branch still counts against the base.
	sh(t, path, "add", "a.txt")
	sh(t, path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "wip")
	if changes, _ = (Repo{}).Changes(ctx, path, wt.Base); len(changes) != 2 {
		t.Fatalf("after commit = %+v", changes)
	}

	if err := (Repo{}).RemoveWorktree(ctx, wt, false); !errors.Is(err, app.ErrWorktreeDirty) {
		t.Fatalf("dirty remove: err = %v", err)
	}
	if err := (Repo{}).RemoveWorktree(ctx, wt, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("worktree folder still there: %v", err)
	}
	sh(t, repo, "rev-parse", "--verify", "chamber/fix")
}

func TestChangesCountLines(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	write(t, filepath.Join(repo, "a.txt"), "uno\ndos\ntres\n")
	write(t, filepath.Join(repo, "b.bin"), "\x00\x01\x02")
	write(t, filepath.Join(repo, "notes.md"), "one\ntwo\nno newline at the end")
	write(t, filepath.Join(repo, "empty.txt"), "")
	sh(t, repo, "rm", "-q", ".gitignore")
	changes, err := Repo{}.Changes(ctx, repo, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]app.FileChange{}
	for _, c := range changes {
		got[c.Path] = c
	}
	want := map[string]app.FileChange{
		".gitignore": {Path: ".gitignore", Status: "D", Removed: 1},
		"a.txt":      {Path: "a.txt", Status: "M", Added: 3, Removed: 1},
		"b.bin":      {Path: "b.bin", Status: "?", Binary: true},
		"notes.md":   {Path: "notes.md", Status: "?", Added: 3},
		"empty.txt":  {Path: "empty.txt", Status: "?"},
	}
	if len(got) != len(want) {
		t.Fatalf("changes = %+v", changes)
	}
	for path, w := range want {
		if got[path] != w {
			t.Errorf("%s = %+v, want %+v", path, got[path], w)
		}
	}
}

func TestChangesCountsBinaryTracked(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	write(t, filepath.Join(repo, "img.bin"), "\x00a")
	sh(t, repo, "add", "img.bin")
	sh(t, repo, "commit", "-q", "-m", "bin")
	write(t, filepath.Join(repo, "img.bin"), "\x00b")
	changes, err := Repo{}.Changes(ctx, repo, "HEAD")
	if err != nil || len(changes) != 1 || changes[0] != (app.FileChange{Path: "img.bin", Status: "M", Binary: true}) {
		t.Fatalf("changes = %+v, %v", changes, err)
	}
}

func TestFileDiff(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	write(t, filepath.Join(repo, "a.txt"), "two\n")
	write(t, filepath.Join(repo, "dir", "new.txt"), "fresh\n")
	outside := filepath.Join(filepath.Dir(repo), "secret.txt")
	write(t, outside, "secret\n")

	diff, err := Repo{}.FileDiff(ctx, repo, "HEAD", "a.txt")
	if err != nil || !strings.Contains(diff, "-one") || !strings.Contains(diff, "+two") {
		t.Fatalf("tracked diff = %q, %v", diff, err)
	}
	diff, err = Repo{}.FileDiff(ctx, repo, "HEAD", "dir/new.txt")
	if err != nil || !strings.Contains(diff, "+fresh") {
		t.Fatalf("untracked diff = %q, %v", diff, err)
	}
	diff, err = Repo{}.FileDiff(ctx, repo, "HEAD", "../secret.txt")
	if strings.Contains(diff, "secret") {
		t.Fatalf("read a file outside the repository: %q %v", diff, err)
	}
	if diff, err = (Repo{}).FileDiff(ctx, repo, "HEAD", "unchanged.txt"); err != nil || diff != "" {
		t.Fatalf("unknown file = %q, %v", diff, err)
	}
}

func TestRepositoryWithoutCommits(t *testing.T) {
	ctx := context.Background()
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	sh(t, dir, "init", "-q")
	write(t, filepath.Join(dir, "a.txt"), "x\n")
	changes, err := Repo{}.Changes(ctx, dir, "HEAD")
	if err != nil || len(changes) != 1 || changes[0].Status != "?" {
		t.Fatalf("changes = %+v, %v", changes, err)
	}
	if _, err := (Repo{}).AddWorktree(ctx, dir, filepath.Join(dir, "..", "wt"), "chamber/x"); err == nil {
		t.Fatal("worktree without a commit to branch from")
	}
	if _, err := (Repo{}).Changes(ctx, dir, "nope"); err == nil {
		t.Fatal("unknown base accepted")
	}
}

func TestNotARepository(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))
	if _, err := (Repo{}).Toplevel(ctx, dir); !errors.Is(err, app.ErrNotRepository) {
		t.Fatalf("toplevel: err = %v", err)
	}
	if _, err := (Repo{}).Changes(ctx, dir, "HEAD"); !errors.Is(err, app.ErrNotRepository) {
		t.Fatalf("changes: err = %v", err)
	}
	if _, err := (Repo{}).FileDiff(ctx, dir, "HEAD", "a"); !errors.Is(err, app.ErrNotRepository) {
		t.Fatalf("diff: err = %v", err)
	}
}

func TestAddWorktreeFailures(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	path := filepath.Join(filepath.Dir(repo), "wt", "x")
	if _, err := (Repo{}).AddWorktree(ctx, repo, path, "chamber/x"); err != nil {
		t.Fatal(err)
	}
	if _, err := (Repo{}).AddWorktree(ctx, repo, path+"2", "chamber/x"); err == nil {
		t.Fatal("existing branch accepted")
	}
	blocker := filepath.Join(filepath.Dir(repo), "file")
	write(t, blocker, "x")
	if _, err := (Repo{}).AddWorktree(ctx, repo, filepath.Join(blocker, "wt"), "chamber/y"); err == nil {
		t.Fatal("folder under a file accepted")
	}
}
