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
	base, err := resolve(ctx, dir, base)
	if err != nil {
		return nil, err
	}
	tracked, err := run(ctx, dir, "diff", "--name-status", "--no-renames", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	var files []app.FileChange
	fields := strings.Split(strings.TrimSuffix(tracked, "\x00"), "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		files = append(files, app.FileChange{Status: fields[i], Path: fields[i+1]})
	}
	untracked, err := untracked(ctx, dir, "")
	if err != nil {
		return nil, err
	}
	for _, p := range untracked {
		files = append(files, app.FileChange{Status: "?", Path: p})
	}
	return files, nil
}

func (r Repo) FileDiff(ctx context.Context, dir, base, path string) (string, error) {
	root, err := r.Toplevel(ctx, dir)
	if err != nil {
		return "", err
	}
	dir = root
	base, err := resolve(ctx, dir, base)
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
