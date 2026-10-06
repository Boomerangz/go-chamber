package fsys

import (
	"bytes"
	"context"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const (
	defaultFileLimit = 20000
	fileCacheTTL     = 10 * time.Second
)

// Files lists a folder's files for @-mention completion: `git ls-files`
// (tracked and untracked, gitignore applied) inside a repository, otherwise
// a bounded walk that skips .git and node_modules. Results are cached per
// folder for a few seconds so typing doesn't rescan on every key.
type Files struct {
	// Limit caps the number of files listed; 0 means 20000.
	Limit int

	mu    sync.Mutex
	cache map[string]cachedFiles
}

type cachedFiles struct {
	files []string
	at    time.Time
}

func (f *Files) ListFiles(ctx context.Context, root string) ([]string, error) {
	f.mu.Lock()
	if c, ok := f.cache[root]; ok && time.Since(c.at) < fileCacheTTL {
		f.mu.Unlock()
		return c.files, nil
	}
	f.mu.Unlock()

	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	limit := f.Limit
	if limit <= 0 {
		limit = defaultFileLimit
	}
	files, ok := gitFiles(ctx, root, limit)
	if !ok {
		var err error
		if files, err = walkFiles(root, limit); err != nil {
			return nil, err
		}
	}

	f.mu.Lock()
	if f.cache == nil {
		f.cache = map[string]cachedFiles{}
	}
	f.cache[root] = cachedFiles{files: files, at: time.Now()}
	f.mu.Unlock()
	return files, nil
}

func gitFiles(ctx context.Context, root string, limit int) ([]string, bool) {
	cmd := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "-co", "--exclude-standard", "-z")
	out, err := cmd.Output()
	if err != nil {
		return nil, false
	}
	var files []string
	for _, f := range bytes.Split(out, []byte{0}) {
		if len(f) == 0 {
			continue
		}
		if len(files) == limit {
			break
		}
		files = append(files, string(f))
	}
	return files, true
}

func walkFiles(root string, limit int) ([]string, error) {
	// WalkDir doesn't follow a symlinked root (macOS /tmp is one); walk its
	// target. Listed paths are relative, so they read the same either way.
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	var files []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == root {
				return err
			}
			return nil
		}
		if d.IsDir() {
			if p != root && (d.Name() == ".git" || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		if len(files) == limit {
			return fs.SkipAll
		}
		return nil
	})
	return files, err
}
