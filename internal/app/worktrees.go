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
	// ErrInvalidBranch means a branch name has nothing a branch can be made of.
	ErrInvalidBranch = errors.New("invalid branch name")
	// ErrBranchExists means the repository already has the branch.
	ErrBranchExists = errors.New("branch already exists")
	// ErrWorktreeExists means the worktree folder is already there.
	ErrWorktreeExists = errors.New("worktree folder already exists")
)

// FileChange is one changed file; Status is git's letter (A, M, D, T) or
// "?" for an untracked file. Added and Removed count changed lines (an
// untracked file's lines are all added); a binary file counts none.
type FileChange struct {
	Path string `json:"path"`
	// From is the path a renamed file (Status "R") had before.
	From    string `json:"from,omitempty"`
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
	Binary  bool   `json:"binary,omitempty"`
}

// Changes is what the session's folder changed against Base.
type Changes struct {
	// Repository is false when the folder is not in a git repository.
	Repository bool `json:"repository"`
	// Root is the repository's top folder; file paths are relative to it.
	Root  string       `json:"root,omitempty"`
	Base  string       `json:"base,omitempty"`
	Files []FileChange `json:"files"`
	// Commits counts a worktree branch's commits since Base: until there is
	// one, the branch has nothing to merge.
	Commits int `json:"commits"`
	// Removed is set when the session's worktree folder is gone; Branch is
	// the branch it kept.
	Removed bool   `json:"removed,omitempty"`
	Branch  string `json:"branch,omitempty"`
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
	// Commits counts the commits on dir's HEAD since base.
	Commits(ctx context.Context, dir, base string) (int, error)
	// Ahead counts the commits on branch that repo's HEAD doesn't have and
	// names the branch HEAD is on; a branch that is gone counts none.
	Ahead(ctx context.Context, repo, branch string) (ahead int, head string, err error)
}

// WorktreeSessions is the session manager subset worktrees need.
type WorktreeSessions interface {
	CreateSession(ctx context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error)
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	SetWorktree(ctx context.Context, id domain.SessionID, wt *domain.Worktree) (domain.SessionSnapshot, error)
	// RemoveWorktree runs remove on the session's worktree when it may go
	// and records that it is gone.
	RemoveWorktree(ctx context.Context, id domain.SessionID, remove func(domain.Worktree) error) (domain.SessionSnapshot, error)
	DeleteSession(ctx context.Context, id domain.SessionID) error
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
		return domain.SessionSnapshot{}, fmt.Errorf("%w: use latin letters or digits", ErrInvalidBranch)
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

// Remove deletes the session's worktree folder; its branch stays for
// merging and the session remembers both.
func (w *Worktrees) Remove(ctx context.Context, id domain.SessionID, force bool) (domain.SessionSnapshot, error) {
	return w.cfg.Sessions.RemoveWorktree(ctx, id, func(wt domain.Worktree) error {
		return w.cfg.Git.RemoveWorktree(ctx, wt, force)
	})
}

// Delete removes the session; with removeFolder its worktree folder goes
// first (the branch stays), and a folder that can't go keeps the session.
func (w *Worktrees) Delete(ctx context.Context, id domain.SessionID, removeFolder bool) error {
	if removeFolder {
		snap, err := w.cfg.Sessions.GetSession(ctx, id)
		if err != nil {
			return err
		}
		if snap.Worktree != nil && !snap.Worktree.Removed {
			if _, err := w.Remove(ctx, id, false); err != nil {
				return err
			}
		}
	}
	return w.cfg.Sessions.DeleteSession(ctx, id)
}

// Changes lists what the session folder changed: a worktree against the
// commit it branched from, any other folder against HEAD.
func (w *Worktrees) Changes(ctx context.Context, id domain.SessionID) (Changes, error) {
	snap, base, err := w.base(ctx, id)
	if err != nil {
		return Changes{}, err
	}
	if wt := snap.Worktree; wt != nil && wt.Removed {
		return Changes{Base: base, Files: []FileChange{}, Removed: true, Branch: wt.Branch}, nil
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
	root, err := w.cfg.Git.Toplevel(ctx, snap.Cwd)
	if err != nil {
		return Changes{}, err
	}
	commits := 0
	if snap.Worktree != nil {
		if commits, err = w.cfg.Git.Commits(ctx, snap.Cwd, base); err != nil {
			return Changes{}, err
		}
	}
	return Changes{Repository: true, Root: root, Base: base, Files: files, Commits: commits}, nil
}

// Unmerged is a worktree branch that a fork's repository hasn't taken in:
// the fork was made after its parent's worktree was removed, so it works in
// the repository while the branch may still hold the parent's commits.
type Unmerged struct {
	Branch string `json:"branch"`
	// Into is the branch the repository is on ("HEAD" when detached).
	Into  string `json:"into"`
	Ahead int    `json:"ahead"`
	// Merge is the command that merges Branch into Into.
	Merge string `json:"merge"`
}

// Unmerged names the branch a fork left behind while it has commits the
// repository doesn't; nil when there is none or it is merged.
func (w *Worktrees) Unmerged(ctx context.Context, id domain.SessionID) (*Unmerged, error) {
	snap, err := w.cfg.Sessions.GetSession(ctx, id)
	if err != nil || snap.ForkOf == "" || snap.Worktree != nil {
		return nil, err
	}
	parent, err := w.cfg.Sessions.GetSession(ctx, snap.ForkOf)
	if errors.Is(err, ErrSessionNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	wt := parent.Worktree
	if wt == nil || !wt.Removed || wt.Repo != snap.Cwd {
		return nil, nil
	}
	ahead, head, err := w.cfg.Git.Ahead(ctx, wt.Repo, wt.Branch)
	if err != nil || ahead == 0 {
		return nil, err
	}
	return &Unmerged{Branch: wt.Branch, Into: head, Ahead: ahead, Merge: mergeCommand(wt.Repo, wt.Branch)}, nil
}

// mergeCommand merges branch in repo from any folder; a repo path a shell
// would split is single-quoted. Branch names go-chamber makes need no quotes.
func mergeCommand(repo, branch string) string {
	if strings.ContainsAny(repo, " \t\n'\"$`\\!*?[]{}()<>|&;#~") {
		repo = "'" + strings.ReplaceAll(repo, "'", `'\''`) + "'"
	}
	return "git -C " + repo + " merge " + branch
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
	if snap.Worktree != nil && snap.Worktree.Removed {
		return "", domain.ErrWorktreeRemoved
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

// RemoveWorktree records that the session's worktree is gone once remove
// has taken the folder. The agent process working there is closed.
func (m *Manager) RemoveWorktree(ctx context.Context, id domain.SessionID, remove func(domain.Worktree) error) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.WorktreeRemovable()
	wt := s.Worktree()
	m.mu.Unlock()
	if errors.Is(err, domain.ErrInvalidTransition) {
		return domain.SessionSnapshot{}, ErrNoWorktree
	}
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := remove(*wt); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.RemoveWorktree()
	if err == nil {
		m.retire(s)
	}
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
