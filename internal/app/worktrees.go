package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var (
	// ErrNotRepository means the folder is not inside a git repository.
	ErrNotRepository = errors.New("not a git repository")
	// ErrWorktreeDirty means the worktree has changes and removal wasn't forced.
	ErrWorktreeDirty = errors.New("worktree has uncommitted changes")
	// ErrNoWorktree means the session does not work in a worktree it owns.
	ErrNoWorktree = errors.New("session has no worktree")
	// ErrInvalidPath means a diff was asked for a path outside the folder.
	ErrInvalidPath = errors.New("invalid path")
)

// FileChange is one changed file; Status is git's letter (A, M, D, T) or
// "?" for an untracked file.
type FileChange struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// Changes is what the session's folder changed against Base.
type Changes struct {
	// Repository is false when the folder is not in a git repository.
	Repository bool         `json:"repository"`
	Base       string       `json:"base,omitempty"`
	Files      []FileChange `json:"files"`
}

// GitRepo is the git operations worktree sessions and the diff panel need.
type GitRepo interface {
	// Toplevel returns the root of the repository containing dir.
	Toplevel(ctx context.Context, dir string) (string, error)
	// AddWorktree adds path on a new branch starting at the repository's HEAD.
	AddWorktree(ctx context.Context, repo, path, branch string) (domain.Worktree, error)
	// RemoveWorktree removes the worktree; the branch is kept.
	RemoveWorktree(ctx context.Context, wt domain.Worktree, force bool) error
	// Changes lists files in dir that differ from base (a commit-ish).
	Changes(ctx context.Context, dir, base string) ([]FileChange, error)
	// FileDiff is the unified diff of one file in dir against base.
	FileDiff(ctx context.Context, dir, base, path string) (string, error)
}

// WorktreeSessions is the session manager subset worktrees need.
type WorktreeSessions interface {
	CreateSession(ctx context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error)
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	SetWorktree(ctx context.Context, id domain.SessionID, wt *domain.Worktree) (domain.SessionSnapshot, error)
}

type WorktreesConfig struct {
	Sessions WorktreeSessions
	Git      GitRepo
	// Root holds created worktrees as <Root>/<repo name>/<slug>.
	Root string
}

// Worktrees creates sessions in their own git worktree and reports what a
// session's folder changed.
type Worktrees struct {
	cfg WorktreesConfig
}

func NewWorktrees(cfg WorktreesConfig) *Worktrees { return &Worktrees{cfg: cfg} }

// BranchPrefix namespaces the branches go-chamber creates.
const BranchPrefix = "chamber/"

// Create adds a worktree of the repository containing dir on branch
// chamber/<slug> and starts a session in it.
func (w *Worktrees) Create(ctx context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error) {
	slug := slugify(name)
	if slug == "" {
		return domain.SessionSnapshot{}, fmt.Errorf("%w: empty branch name", domain.ErrInvalidSession)
	}
	repo, err := w.cfg.Git.Toplevel(ctx, dir)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	path := filepath.Join(w.cfg.Root, filepath.Base(repo), slug)
	wt, err := w.cfg.Git.AddWorktree(ctx, repo, path, BranchPrefix+slug)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	snap, err := w.cfg.Sessions.CreateSession(ctx, agent, wt.Path)
	if err == nil {
		snap, err = w.cfg.Sessions.SetWorktree(ctx, snap.ID, &wt)
	}
	if err != nil {
		_ = w.cfg.Git.RemoveWorktree(context.WithoutCancel(ctx), wt, true)
		return domain.SessionSnapshot{}, err
	}
	return snap, nil
}

// Remove deletes the session's worktree folder; its branch stays for merging.
func (w *Worktrees) Remove(ctx context.Context, id domain.SessionID, force bool) (domain.SessionSnapshot, error) {
	snap, err := w.cfg.Sessions.GetSession(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if snap.Worktree == nil {
		return domain.SessionSnapshot{}, ErrNoWorktree
	}
	if err := w.cfg.Git.RemoveWorktree(ctx, *snap.Worktree, force); err != nil {
		return domain.SessionSnapshot{}, err
	}
	return w.cfg.Sessions.SetWorktree(ctx, id, nil)
}

// Changes lists what the session folder changed: a worktree against the
// commit it branched from, any other folder against HEAD.
func (w *Worktrees) Changes(ctx context.Context, id domain.SessionID) (Changes, error) {
	snap, base, err := w.base(ctx, id)
	if err != nil {
		return Changes{}, err
	}
	files, err := w.cfg.Git.Changes(ctx, snap.Cwd, base)
	if errors.Is(err, ErrNotRepository) {
		return Changes{Files: []FileChange{}}, nil
	}
	if err != nil {
		return Changes{}, err
	}
	if files == nil {
		files = []FileChange{}
	}
	return Changes{Repository: true, Base: base, Files: files}, nil
}

// FileDiff is the unified diff of one changed file of the session folder.
func (w *Worktrees) FileDiff(ctx context.Context, id domain.SessionID, path string) (string, error) {
	clean := filepath.ToSlash(filepath.Clean(path))
	if path == "" || filepath.IsAbs(path) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("%w: %q", ErrInvalidPath, path)
	}
	snap, base, err := w.base(ctx, id)
	if err != nil {
		return "", err
	}
	return w.cfg.Git.FileDiff(ctx, snap.Cwd, base, clean)
}

func (w *Worktrees) base(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, string, error) {
	snap, err := w.cfg.Sessions.GetSession(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, "", err
	}
	if snap.Worktree != nil {
		return snap, snap.Worktree.Base, nil
	}
	return snap, "HEAD", nil
}

// slugify turns a user-typed name into a branch- and folder-safe slug.
func slugify(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), BranchPrefix)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '.' && b.Len() > 0:
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.Trim(b.String(), "-.")
	if len(s) > 50 {
		s = strings.Trim(s[:50], "-.")
	}
	return strings.ReplaceAll(s, "..", ".")
}

// SetWorktree records (or clears, with nil) the worktree a session works in.
func (m *Manager) SetWorktree(ctx context.Context, id domain.SessionID, wt *domain.Worktree) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.SetWorktree(wt)
	snap := s.Snapshot()
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}
