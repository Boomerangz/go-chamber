package fsys

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestResolverFollowsSymlinks(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	target := filepath.Join(dir, "real.txt")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if got, err := (Resolver{}).Resolve(link); err != nil || got != target {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := (Resolver{}).Resolve(filepath.Join(dir, "missing")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing err = %v", err)
	}
}
