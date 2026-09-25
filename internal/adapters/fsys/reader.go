// Package fsys reads the local filesystem for the folder picker.
package fsys

import (
	"os"
	"path/filepath"

	"github.com/igorzygin/go-chamber/internal/app"
)

// Reader lists subdirectories with os.ReadDir. Symlinks to directories count
// as directories; broken links and files are skipped.
type Reader struct{}

func (Reader) ReadFolder(dir string) ([]app.FolderEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]app.FolderEntry, 0, len(entries))
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		if !e.IsDir() {
			if e.Type()&os.ModeSymlink == 0 {
				continue
			}
			if info, err := os.Stat(full); err != nil || !info.IsDir() {
				continue
			}
		}
		_, err := os.Lstat(filepath.Join(full, ".git"))
		out = append(out, app.FolderEntry{Name: e.Name(), Repo: err == nil})
	}
	return out, nil
}
