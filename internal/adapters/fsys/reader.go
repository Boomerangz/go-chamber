// Package fsys reads the local filesystem for the folder picker.
package fsys

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/igorzygin/go-chamber/internal/app"
)

// Reader lists subdirectories with os.ReadDir. Symlinks to directories count
// as directories; broken links and files are skipped.
type Reader struct{}

// FolderExists reports whether path is a directory (a link to one counts).
// Only a path that is not there is missing: a folder that can't be checked
// is an error.
func (Reader) FolderExists(path string) (bool, error) {
	info, err := os.Stat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return false, nil
	case err != nil:
		return false, err
	}
	return info.IsDir(), nil
}

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
