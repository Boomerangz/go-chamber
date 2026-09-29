package fsys

import "path/filepath"

// Resolver follows symlinks to a path's real location.
type Resolver struct{}

func (Resolver) Resolve(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}
