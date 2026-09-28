package domain

import "fmt"

// Worktree is a git worktree go-chamber created for a session: the session
// works in Path on its own Branch, which started at commit Base of Repo.
type Worktree struct {
	Repo   string `json:"repo"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
}

// Worktree returns a copy of the session's worktree, or nil.
func (s *Session) Worktree() *Worktree {
	if s.worktree == nil {
		return nil
	}
	wt := *s.worktree
	return &wt
}

// SetWorktree records the worktree the session works in; nil clears it
// (the worktree was removed). The worktree must be the session folder.
func (s *Session) SetWorktree(wt *Worktree) error {
	if wt == nil {
		s.worktree = nil
		return nil
	}
	switch {
	case wt.Repo == "" || wt.Path == "" || wt.Branch == "" || wt.Base == "":
		return fmt.Errorf("%w: incomplete worktree %+v", ErrInvalidSession, *wt)
	case wt.Path != s.cwd:
		return fmt.Errorf("%w: worktree %s is not the session folder %s", ErrInvalidSession, wt.Path, s.cwd)
	}
	copied := *wt
	s.worktree = &copied
	return nil
}
