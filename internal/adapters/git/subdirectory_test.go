package git

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiffFromSubdirectory(t *testing.T) {
	repo := newRepo(t)
	sub := filepath.Join(repo, "sub")
	write(t, filepath.Join(sub, "a.txt"), "before\n")
	sh(t, repo, "add", ".")
	sh(t, repo, "commit", "-q", "-m", "sub")
	write(t, filepath.Join(sub, "a.txt"), "after\n")
	write(t, filepath.Join(sub, "new.txt"), "after\n")
	changes, err := (Repo{}).Changes(context.Background(), sub, "HEAD")
	if err != nil || len(changes) == 0 {
		t.Fatalf("changes: %v %v", changes, err)
	}
	for _, change := range changes {
		diff, err := (Repo{}).FileDiff(context.Background(), sub, "HEAD", change.Path)
		if err != nil || !strings.Contains(diff, "+after") {
			t.Fatalf("listed path %q gives empty/wrong diff: %q %v", change.Path, diff, err)
		}
	}
}
