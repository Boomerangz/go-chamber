// Package git runs the git CLI for worktree sessions and the diff panel.
package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// emptyTree is git's well-known empty tree, the base of a repository
// without commits.
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// Repo implements app.GitRepo with the git binary on PATH.
type Repo struct{}

func (Repo) Toplevel(ctx context.Context, dir string) (string, error) {
	out, err := run(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

func (r Repo) AddWorktree(ctx context.Context, repo, path, branch string) (domain.Worktree, error) {
	base, err := run(ctx, repo, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return domain.Worktree{}, fmt.Errorf("worktree needs a commit to branch from: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return domain.Worktree{}, err
	}
	if _, err := run(ctx, repo, "worktree", "add", "-b", branch, path, "HEAD"); err != nil {
		return domain.Worktree{}, err
	}
	return domain.Worktree{Repo: repo, Path: path, Branch: branch, Base: strings.TrimSpace(base)}, nil
}

func (Repo) RemoveWorktree(ctx context.Context, wt domain.Worktree, force bool) error {
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	_, err := run(ctx, wt.Repo, append(args, wt.Path)...)
	if err != nil && strings.Contains(err.Error(), "--force") {
		return fmt.Errorf("%w: %w", app.ErrWorktreeDirty, err)
	}
	return err
}

func (r Repo) Changes(ctx context.Context, dir, base string) ([]app.FileChange, error) {
	root, err := r.Toplevel(ctx, dir)
	if err != nil {
		return nil, err
	}
	dir = root
	base, err = resolve(ctx, dir, base)
	if err != nil {
		return nil, err
	}
	tracked, err := run(ctx, dir, "diff", "--name-status", "--no-renames", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, dir, "diff", "--numstat", "--no-renames", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	counts := parseNumstat(numstat)
	var files []app.FileChange
	fields := strings.Split(strings.TrimSuffix(tracked, "\x00"), "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		f := counts[fields[i+1]]
		f.Status, f.Path = fields[i], fields[i+1]
		files = append(files, f)
	}
	untracked, err := untracked(ctx, dir, "")
	if err != nil {
		return nil, err
	}
	for _, p := range untracked {
		f := countFile(filepath.Join(dir, p))
		f.Status, f.Path = "?", p
		files = append(files, f)
	}
	return files, nil
}

// parseNumstat reads `git diff --numstat -z`: "added\tremoved\tpath\0",
// with "-" counts for a binary file.
func parseNumstat(out string) map[string]app.FileChange {
	counts := map[string]app.FileChange{}
	for _, rec := range strings.Split(out, "\x00") {
		parts := strings.SplitN(rec, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		if parts[0] == "-" {
			counts[parts[2]] = app.FileChange{Binary: true}
			continue
		}
		added, _ := strconv.Atoi(parts[0])
		removed, _ := strconv.Atoi(parts[1])
		counts[parts[2]] = app.FileChange{Added: added, Removed: removed}
	}
	return counts
}

// countLimit bounds how much of an untracked file is read to count its
// lines; a bigger one is listed without counts.
const countLimit = 4 << 20

// countFile counts an untracked file's lines as added, the way git's
// numstat would: a NUL byte makes it binary, a last line without a newline
// still counts.
func countFile(path string) app.FileChange {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > countLimit {
		return app.FileChange{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return app.FileChange{}
	}
	if bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
		return app.FileChange{Binary: true}
	}
	lines := bytes.Count(data, []byte("\n"))
	if len(data) > 0 && data[len(data)-1] != '\n' {
		lines++
	}
	return app.FileChange{Added: lines}
}

func (r Repo) FileDiff(ctx context.Context, dir, base, path string) (string, error) {
	root, err := r.Toplevel(ctx, dir)
	if err != nil {
		return "", err
	}
	dir = root
	base, err = resolve(ctx, dir, base)
	if err != nil {
		return "", err
	}
	out, err := run(ctx, dir, "diff", "--no-renames", base, "--", path)
	if err != nil || out != "" {
		return out, err
	}
	// Only a file git lists as untracked is diffed against /dev/null, so a
	// crafted path can't read anything outside the repository.
	if files, err := untracked(ctx, dir, path); err != nil || len(files) != 1 || files[0] != path {
		return "", err
	}
	out, err = run(ctx, dir, "diff", "--no-index", "--", os.DevNull, path)
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		// --no-index exits 1 when the files differ.
		return out, nil
	}
	return out, err
}

// resolve maps base to a commit, or to the empty tree when HEAD is asked
// for in a repository without commits.
// Commits counts the commits on dir's HEAD since base.
func (r Repo) Commits(ctx context.Context, dir, base string) (int, error) {
	out, err := run(ctx, dir, "rev-list", "--count", base+"..HEAD", "--")
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, fmt.Errorf("git rev-list: %q: %w", out, err)
	}
	return n, nil
}

func resolve(ctx context.Context, dir, base string) (string, error) {
	if _, err := run(ctx, dir, "rev-parse", "--verify", "-q", base+"^{commit}"); err == nil {
		return base, nil
	} else if errors.Is(err, app.ErrNotRepository) {
		return "", err
	}
	if base == "HEAD" {
		return emptyTree, nil
	}
	return "", fmt.Errorf("unknown base %q", base)
}

func untracked(ctx context.Context, dir, path string) ([]string, error) {
	args := []string{"ls-files", "--others", "--exclude-standard", "-z"}
	if path != "" {
		args = append(args, "--", path)
	}
	out, err := run(ctx, dir, args...)
	if err != nil || out == "" {
		return nil, err
	}
	return strings.Split(strings.TrimSuffix(out, "\x00"), "\x00"), nil
}

func run(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "core.quotepath=off"}, args...)...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if strings.Contains(msg, "not a git repository") {
			return "", fmt.Errorf("%w: %s", app.ErrNotRepository, dir)
		}
		return stdout.String(), fmt.Errorf("git %s: %s: %w", args[0], msg, err)
	}
	return stdout.String(), nil
}
