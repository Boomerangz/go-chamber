package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Worktrees creates worktree sessions and reports a session folder's changes.
type Worktrees interface {
	Create(ctx context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error)
	// Continue is Create on the branch that is already there.
	Continue(ctx context.Context, agent domain.AgentKind, dir, name string) (domain.SessionSnapshot, error)
	Remove(ctx context.Context, id domain.SessionID, force bool) (domain.SessionSnapshot, error)
	Changes(ctx context.Context, id domain.SessionID) (app.Changes, error)
	FileDiff(ctx context.Context, id domain.SessionID, path string) (string, error)
	// Delete removes the session, and with removeFolder its worktree folder.
	Delete(ctx context.Context, id domain.SessionID, removeFolder bool) error
	// Unmerged names the branch a fork left behind with commits to merge.
	Unmerged(ctx context.Context, id domain.SessionID) (*app.Unmerged, error)
}

func (s *server) worktreeRoutes() {
	if s.cfg.Worktrees == nil {
		return
	}
	s.mux.HandleFunc("POST /api/worktrees", s.createWorktree)
	s.mux.HandleFunc("DELETE /api/sessions/{id}/worktree", s.removeWorktree)
	s.mux.HandleFunc("GET /api/sessions/{id}/changes", s.sessionChanges)
	s.mux.HandleFunc("GET /api/sessions/{id}/changes/diff", s.fileDiff)
	s.mux.HandleFunc("GET /api/sessions/{id}/unmerged", s.unmerged)
}

func (s *server) unmerged(w http.ResponseWriter, r *http.Request) {
	branch, err := s.cfg.Worktrees.Unmerged(r.Context(), sessionID(r))
	if err != nil {
		s.failWorktree(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Unmerged *app.Unmerged `json:"unmerged"`
	}{branch})
}

func (s *server) createWorktree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Agent  domain.AgentKind `json:"agent"`
		Cwd    string           `json:"cwd"`
		Branch string           `json:"branch"`
		Model  string           `json:"model"`
		Effort string           `json:"effort"`
		Mode   string           `json:"permissionMode"`
		// Continue checks out the existing branch instead of making one.
		Continue bool `json:"continue"`
	}
	if !decode(w, r, &body) {
		return
	}
	create := s.cfg.Worktrees.Create
	if body.Continue {
		create = s.cfg.Worktrees.Continue
	}
	session, err := create(r.Context(), body.Agent, body.Cwd, body.Branch)
	if err != nil {
		s.failWorktree(w, err)
		return
	}
	if (body.Model != "" || body.Effort != "") && s.cfg.Sessions != nil {
		if session, err = s.cfg.Sessions.SetModel(r.Context(), session.ID, body.Model, body.Effort); err != nil {
			s.fail(w, err)
			return
		}
	}
	if body.Mode != "" && s.cfg.Sessions != nil {
		if session, err = s.cfg.Sessions.SetPermissionMode(r.Context(), session.ID, body.Mode); err != nil {
			s.fail(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, session)
}

func (s *server) removeWorktree(w http.ResponseWriter, r *http.Request) {
	session, err := s.cfg.Worktrees.Remove(r.Context(), sessionID(r), r.URL.Query().Get("force") == "1")
	if err != nil {
		s.failWorktree(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (s *server) sessionChanges(w http.ResponseWriter, r *http.Request) {
	changes, err := s.cfg.Worktrees.Changes(r.Context(), sessionID(r))
	if err != nil {
		s.failWorktree(w, err)
		return
	}
	writeJSON(w, http.StatusOK, changes)
}

func (s *server) fileDiff(w http.ResponseWriter, r *http.Request) {
	diff, err := s.cfg.Worktrees.FileDiff(r.Context(), sessionID(r), r.URL.Query().Get("path"))
	if err != nil {
		s.failWorktree(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		Diff string `json:"diff"`
	}{diff})
}

func (s *server) failWorktree(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, app.ErrNotRepository), errors.Is(err, app.ErrInvalidPath), errors.Is(err, app.ErrInvalidBranch):
		writeJSON(w, http.StatusBadRequest, errorBody{Error: err.Error()})
	case errors.Is(err, app.ErrBranchExists):
		// The form offers to continue on it.
		writeJSON(w, http.StatusConflict, errorBody{Error: err.Error(), Code: "branch_exists"})
	case errors.Is(err, app.ErrBranchCheckedOut):
		writeJSON(w, http.StatusConflict, errorBody{Error: err.Error(), Code: "branch_checked_out"})
	case errors.Is(err, app.ErrNoBranch):
		writeJSON(w, http.StatusConflict, errorBody{Error: err.Error(), Code: "no_branch"})
	case errors.Is(err, app.ErrWorktreeDirty), errors.Is(err, app.ErrNoWorktree), errors.Is(err, app.ErrWorktreeExists):
		writeJSON(w, http.StatusConflict, errorBody{Error: err.Error()})
	default:
		s.fail(w, err)
	}
}
