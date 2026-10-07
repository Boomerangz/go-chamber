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
	if _, err := run(ctx, repo, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		return domain.Worktree{}, fmt.Errorf("%w: %s", app.ErrBranchExists, branch)
	}
	if _, err := os.Lstat(path); err == nil {
		return domain.Worktree{}, fmt.Errorf("%w: %s", app.ErrWorktreeExists, path)
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
	tracked, err := nameStatus(ctx, dir, base)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, dir, "diff", "--numstat", "--find-renames", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	counts := parseNumstat(numstat)
	files := make([]app.FileChange, 0, len(tracked))
	for _, t := range tracked {
		f := counts[t.Path]
		f.Status, f.Path, f.From = t.Status, t.Path, t.From
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

// nameStatus lists the tracked changes against base, renames found: a
// renamed file is one change with the path it had before.
func nameStatus(ctx context.Context, dir, base string) ([]app.FileChange, error) {
	out, err := run(ctx, dir, "diff", "--name-status", "--find-renames", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	return parseNameStatus(out), nil
}

// parseNameStatus reads `git diff --name-status -z`: "M\0path\0", and for
// a rename or copy "R097\0old\0new\0" (the score is dropped).
func parseNameStatus(out string) []app.FileChange {
	var files []app.FileChange
	fields := strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		status := fields[i]
		if (strings.HasPrefix(status, "R") || strings.HasPrefix(status, "C")) && i+2 < len(fields) {
			files = append(files, app.FileChange{Status: status[:1], From: fields[i+1], Path: fields[i+2]})
			i++
			continue
		}
		files = append(files, app.FileChange{Status: status, Path: fields[i+1]})
	}
	return files
}

// parseNumstat reads `git diff --numstat -z`: "added\tremoved\tpath\0",
// or for a rename "added\tremoved\t\0old\0new\0", with "-" counts for a
// binary file. Counts are keyed by the (new) path.
func parseNumstat(out string) map[string]app.FileChange {
	counts := map[string]app.FileChange{}
	recs := strings.Split(out, "\x00")
	for i := 0; i < len(recs); i++ {
		parts := strings.SplitN(recs[i], "\t", 3)
		if len(parts) != 3 {
			continue
		}
		path := parts[2]
		if path == "" && i+2 < len(recs) {
			path = recs[i+2]
			i += 2
		}
		if parts[0] == "-" {
			counts[path] = app.FileChange{Binary: true}
			continue
		}
		added, _ := strconv.Atoi(parts[0])
		removed, _ := strconv.Atoi(parts[1])
		counts[path] = app.FileChange{Added: added, Removed: removed}
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
	// A renamed file diffs against the path it had, so only its edits show.
	tracked, err := nameStatus(ctx, dir, base)
	if err != nil {
		return "", err
	}
	for _, t := range tracked {
		if t.Path == path && t.From != "" {
			return run(ctx, dir, "diff", "--find-renames", base, "--", t.From, path)
		}
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

// Ahead counts the commits on branch that repo's HEAD doesn't have, and
// names the branch HEAD is on ("HEAD" when detached). A branch that no
// longer exists has nothing to merge.
func (r Repo) Ahead(ctx context.Context, repo, branch string) (int, string, error) {
	head, err := run(ctx, repo, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return 0, "", err
	}
	head = strings.TrimSpace(head)
	ref := "refs/heads/" + branch
	if _, err := run(ctx, repo, "rev-parse", "--verify", "-q", ref); err != nil {
		return 0, head, nil
	}
	out, err := run(ctx, repo, "rev-list", "--count", "HEAD.."+ref, "--")
	if err != nil {
		return 0, head, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return 0, head, fmt.Errorf("git rev-list: %q: %w", out, err)
	}
	return n, head, nil
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
