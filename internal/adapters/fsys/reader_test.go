package fsys

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

var _ app.FolderReader = Reader{}

func TestReadFolderListsDirectoriesAndRepos(t *testing.T) {
	root := t.TempDir()
	mustMkdir(t, root, "plain")
	mustMkdir(t, root, "repo", ".git")
	mustMkdir(t, root, "worktree")
	mustWrite(t, filepath.Join(root, "worktree", ".git"), "gitdir: elsewhere")
	mustWrite(t, filepath.Join(root, "file.txt"), "x")
	if err := os.Symlink(filepath.Join(root, "plain"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "nowhere"), filepath.Join(root, "broken")); err != nil {
		t.Fatal(err)
	}

	got, err := Reader{}.ReadFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"plain": false, "repo": true, "worktree": true, "link": false}
	have := map[string]bool{}
	for _, e := range got {
		have[e.Name] = e.Repo
	}
	if !reflect.DeepEqual(have, want) {
		t.Fatalf("entries = %v, want %v", have, want)
	}
}

func TestReadFolderErrors(t *testing.T) {
	root := t.TempDir()
	if _, err := (Reader{}).ReadFolder(filepath.Join(root, "missing")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	locked := filepath.Join(root, "locked")
	mustMkdir(t, root, "locked")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	if os.Geteuid() != 0 {
		if _, err := (Reader{}).ReadFolder(locked); !errors.Is(err, fs.ErrPermission) {
			t.Fatalf("locked: %v", err)
		}
	}
}

func mustMkdir(t *testing.T, parts ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(parts...), 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}
