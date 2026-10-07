package git

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

func TestAheadCountsTheBranchCommitsNotInHead(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	r := Repo{}
	sh(t, repo, "branch", "chamber/x")
	if n, head, err := r.Ahead(ctx, repo, "chamber/x"); err != nil || n != 0 || head != "main" {
		t.Fatalf("Ahead = %d, %q, %v; want 0 on main", n, head, err)
	}
	sh(t, repo, "checkout", "-q", "chamber/x")
	for _, msg := range []string{"one", "two"} {
		write(t, filepath.Join(repo, msg+".txt"), msg)
		sh(t, repo, "add", ".")
		sh(t, repo, "commit", "-q", "-m", msg)
	}
	sh(t, repo, "checkout", "-q", "main")
	if n, head, err := r.Ahead(ctx, repo, "chamber/x"); err != nil || n != 2 || head != "main" {
		t.Fatalf("Ahead = %d, %q, %v; want 2 on main", n, head, err)
	}
	sh(t, repo, "merge", "-q", "chamber/x")
	if n, _, err := r.Ahead(ctx, repo, "chamber/x"); err != nil || n != 0 {
		t.Fatalf("after the merge: %d, %v", n, err)
	}
	// A branch deleted since has nothing left to merge.
	sh(t, repo, "branch", "-q", "-D", "chamber/x")
	if n, _, err := r.Ahead(ctx, repo, "chamber/x"); err != nil || n != 0 {
		t.Fatalf("deleted branch: %d, %v", n, err)
	}
	if _, _, err := r.Ahead(ctx, t.TempDir(), "chamber/x"); !errors.Is(err, app.ErrNotRepository) {
		t.Fatalf("not a repository: %v", err)
	}
}

func TestAheadOnADetachedHead(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	sh(t, repo, "branch", "chamber/y")
	sh(t, repo, "checkout", "-q", "--detach")
	if _, head, err := (Repo{}).Ahead(ctx, repo, "chamber/y"); err != nil || head != "HEAD" {
		t.Fatalf("head = %q, %v", head, err)
	}
}
