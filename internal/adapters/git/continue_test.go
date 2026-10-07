package git

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

// A branch a removed worktree kept can be checked out in a new worktree:
// its commits are there, and the base is where it left the repository's
// HEAD, so the diff shows the branch's own work.
func TestContinueWorktreeOnAKeptBranch(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	path := filepath.Join(filepath.Dir(repo), "wt", "app", "fix")
	first, err := (Repo{}).AddWorktree(ctx, repo, path, "chamber/fix")
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(path, "work.txt"), "done\n")
	sh(t, path, "add", ".")
	sh(t, path, "commit", "-q", "-m", "work")
	if err := (Repo{}).RemoveWorktree(ctx, first, false); err != nil {
		t.Fatal(err)
	}
	// The repository moves on meanwhile.
	write(t, filepath.Join(repo, "b.txt"), "later\n")
	sh(t, repo, "add", ".")
	sh(t, repo, "commit", "-q", "-m", "later")

	again, err := (Repo{}).AddWorktree(ctx, repo, path, "chamber/fix")
	if !errors.Is(err, app.ErrBranchExists) {
		t.Fatalf("new branch over a kept one: err = %v", err)
	}
	again, err = (Repo{}).ContinueWorktree(ctx, repo, path, "chamber/fix")
	if err != nil {
		t.Fatal(err)
	}
	if again.Path != path || again.Branch != "chamber/fix" || again.Repo != repo || again.Base != first.Base {
		t.Fatalf("worktree = %+v, want base %s", again, first.Base)
	}
	if _, err := os.Stat(filepath.Join(path, "work.txt")); err != nil {
		t.Fatalf("branch work not checked out: %v", err)
	}
	changes, err := (Repo{}).Changes(ctx, path, again.Base)
	if err != nil || len(changes) != 1 || changes[0].Path != "work.txt" {
		t.Fatalf("changes = %+v, %v", changes, err)
	}
}

// A branch checked out in another worktree can't be checked out again:
// the refusal says where it is, whether a new branch or the existing one
// was asked for.
func TestBranchCheckedOutElsewhere(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	path := filepath.Join(filepath.Dir(repo), "wt", "app", "fix")
	if _, err := (Repo{}).AddWorktree(ctx, repo, path, "chamber/fix"); err != nil {
		t.Fatal(err)
	}
	other := path + "-again"
	for name, add := range map[string]func(context.Context, string, string, string) (any, error){
		"add":      func(c context.Context, r, p, b string) (any, error) { return (Repo{}).AddWorktree(c, r, p, b) },
		"continue": func(c context.Context, r, p, b string) (any, error) { return (Repo{}).ContinueWorktree(c, r, p, b) },
	} {
		_, err := add(ctx, repo, other, "chamber/fix")
		var used *app.BranchInUseError
		if !errors.Is(err, app.ErrBranchCheckedOut) || !errors.As(err, &used) || used.Path != path || used.Branch != "chamber/fix" {
			t.Fatalf("%s: err = %v", name, err)
		}
		if !strings.Contains(err.Error(), path) {
			t.Fatalf("%s: %q doesn't say where", name, err)
		}
	}
	// The repository's own checkout counts too.
	sh(t, repo, "branch", "chamber/main-like")
	sh(t, repo, "checkout", "-q", "chamber/main-like")
	_, err := (Repo{}).ContinueWorktree(ctx, repo, other, "chamber/main-like")
	var used *app.BranchInUseError
	if !errors.As(err, &used) || used.Path != repo {
		t.Fatalf("checked out in the repository: err = %v", err)
	}
	if _, err := os.Stat(other); !os.IsNotExist(err) {
		t.Fatalf("a refused worktree left its folder: %v", err)
	}
}

func TestContinueWorktreeFailures(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	path := filepath.Join(filepath.Dir(repo), "wt", "x")
	if _, err := (Repo{}).ContinueWorktree(ctx, repo, path, "chamber/none"); !errors.Is(err, app.ErrNoBranch) || !strings.Contains(err.Error(), "chamber/none") {
		t.Fatalf("missing branch: err = %v", err)
	}
	sh(t, repo, "branch", "chamber/x")
	write(t, filepath.Join(path, "f"), "x")
	if _, err := (Repo{}).ContinueWorktree(ctx, repo, path, "chamber/x"); !errors.Is(err, app.ErrWorktreeExists) {
		t.Fatalf("existing folder: err = %v", err)
	}
}

func TestParseWorktreeList(t *testing.T) {
	out := "worktree /src/app\nHEAD 1111\nbranch refs/heads/main\n\nworktree /wt/fix\nHEAD 2222\nbranch refs/heads/chamber/fix\n\nworktree /wt/detached\nHEAD 3333\ndetached\n\n"
	got := checkedOut(out)
	if len(got) != 2 || got["main"] != "/src/app" || got["chamber/fix"] != "/wt/fix" {
		t.Fatalf("checked out = %v", got)
	}
	if len(checkedOut("")) != 0 {
		t.Fatal("empty list has branches")
	}
}
