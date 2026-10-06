package domain

import (
	"errors"
	"fmt"
)

// Worktree is a git worktree go-chamber created for a session: the session
// works in Path on its own Branch, which started at commit Base of Repo.
type Worktree struct {
	Repo   string `json:"repo"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Base   string `json:"base"`
	// Removed is set once the worktree folder is gone; the branch stays in
	// Repo, so the session still belongs to the repository.
	Removed bool `json:"removed,omitempty"`
}

// ErrWorktreeRemoved refuses work in a session whose worktree folder is gone.
var ErrWorktreeRemoved = errors.New("the session's worktree was removed")

// WorktreeRemoved reports whether the session's worktree folder is gone.
func (s *Session) WorktreeRemoved() bool { return s.worktree != nil && s.worktree.Removed }

// WorktreeRemovable checks the worktree can be removed now: the session has
// one that is still there and no turn is writing into it.
func (s *Session) WorktreeRemovable() error {
	switch {
	case s.worktree == nil || s.worktree.Removed:
		return fmt.Errorf("%w: no worktree to remove", ErrInvalidTransition)
	case s.status == StatusRunning:
		return ErrSessionBusy
	}
	return nil
}

// RemoveWorktree records that the worktree folder is gone. The session
// remembers the repository and branch it worked on.
func (s *Session) RemoveWorktree() error {
	if err := s.WorktreeRemovable(); err != nil {
		return err
	}
	s.worktree.Removed = true
	return nil
}

// Workable refuses a turn in a folder that no longer exists.
func (s *Session) Workable() error {
	if s.WorktreeRemoved() {
		return ErrWorktreeRemoved
	}
	return nil
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
