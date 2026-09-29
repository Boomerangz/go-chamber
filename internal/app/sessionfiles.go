package app

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var (
	ErrFileNotFound       = errors.New("file not found")
	ErrFileOutsideSession = errors.New("file is outside the session folder")
)

// PathResolver returns where a path really points, following symlinks.
type PathResolver interface {
	Resolve(path string) (string, error)
}

// SessionFiles lets the UI open files an agent mentions, but only those
// inside the session's folder: a path is resolved (symlinks included) and
// must land under the resolved folder.
type SessionFiles struct {
	sessions SessionTitles
	paths    PathResolver
}

func NewSessionFiles(sessions SessionTitles, paths PathResolver) *SessionFiles {
	return &SessionFiles{sessions: sessions, paths: paths}
}

// Resolve returns the real path of p, relative paths being taken from the
// session folder.
func (f *SessionFiles) Resolve(ctx context.Context, id domain.SessionID, p string) (string, error) {
	snap, err := f.sessions.Get(ctx, id)
	if err != nil {
		return "", err
	}
	if p == "" {
		return "", ErrFileNotFound
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(snap.Cwd, p)
	}
	root, err := f.paths.Resolve(snap.Cwd)
	if err != nil {
		return "", ErrFileNotFound
	}
	// Refuse before touching the disk when the path is plainly elsewhere.
	if !inside(root, filepath.Clean(p)) && !inside(snap.Cwd, filepath.Clean(p)) {
		return "", ErrFileOutsideSession
	}
	real, err := f.paths.Resolve(p)
	if errors.Is(err, fs.ErrNotExist) {
		return "", ErrFileNotFound
	}
	if err != nil {
		return "", err
	}
	if !inside(root, real) {
		return "", ErrFileOutsideSession
	}
	return real, nil
}

func inside(root, p string) bool {
	return p == root || strings.HasPrefix(p, strings.TrimSuffix(root, string(filepath.Separator))+string(filepath.Separator))
}
