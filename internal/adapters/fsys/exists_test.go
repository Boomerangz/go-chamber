package fsys

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

var _ app.FolderProbe = Reader{}

func TestFolderExists(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "file.txt"), "x")
	cases := map[string]bool{root: true, filepath.Join(root, "gone"): false, filepath.Join(root, "file.txt"): false}
	for path, want := range cases {
		if got, err := (Reader{}).FolderExists(path); err != nil || got != want {
			t.Errorf("FolderExists(%s) = %v, %v; want %v", path, got, err, want)
		}
	}
	locked := filepath.Join(root, "locked")
	mustMkdir(t, root, "locked", "inner")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
	if _, err := (Reader{}).FolderExists(filepath.Join(locked, "inner")); err == nil && os.Geteuid() != 0 {
		t.Error("an unreadable parent must be reported, not taken for a missing folder")
	}
}
