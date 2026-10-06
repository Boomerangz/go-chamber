package git

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

func TestCommitsCountsTheBranchSinceBase(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	out, err := exec.Command("git", "-C", repo, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	base := strings.TrimSpace(string(out))
	r := Repo{}
	if n, err := r.Commits(ctx, repo, base); err != nil || n != 0 {
		t.Fatalf("Commits = %d, %v; want 0", n, err)
	}
	for _, msg := range []string{"one", "two"} {
		write(t, filepath.Join(repo, msg+".txt"), msg)
		sh(t, repo, "add", ".")
		sh(t, repo, "commit", "-q", "-m", msg)
	}
	if n, err := r.Commits(ctx, repo, base); err != nil || n != 2 {
		t.Fatalf("Commits = %d, %v; want 2", n, err)
	}
	if _, err := r.Commits(ctx, repo, "nope"); err == nil {
		t.Fatal("an unknown base is an error")
	}
	if _, err := r.Commits(ctx, t.TempDir(), base); !errors.Is(err, app.ErrNotRepository) {
		t.Fatalf("not a repository: %v", err)
	}
}
