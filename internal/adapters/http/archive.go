package httpapi

import (
	"context"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// SessionArchiver puts sessions away from the list and back.
type SessionArchiver interface {
	ArchiveSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	UnarchiveSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
}

// SessionDeleter removes go-chamber's record of a session.
type SessionDeleter interface {
	DeleteSession(ctx context.Context, id domain.SessionID) error
}

func (s *server) archiveRoutes() {
	if a, ok := s.cfg.Sessions.(SessionArchiver); ok {
		archive := func(change func(context.Context, domain.SessionID) (domain.SessionSnapshot, error)) http.HandlerFunc {
			return func(w http.ResponseWriter, req *http.Request) {
				snap, err := change(req.Context(), sessionID(req))
				if err != nil {
					s.fail(w, err)
					return
				}
				writeJSON(w, http.StatusOK, snap)
			}
		}
		s.mux.HandleFunc("POST /api/sessions/{id}/archive", archive(a.ArchiveSession))
		s.mux.HandleFunc("POST /api/sessions/{id}/unarchive", archive(a.UnarchiveSession))
	}
	if d, ok := s.cfg.Sessions.(SessionDeleter); ok {
		s.mux.HandleFunc("DELETE /api/sessions/{id}", func(w http.ResponseWriter, req *http.Request) {
			if req.URL.Query().Get("worktree") == "remove" {
				s.deleteWithWorktree(w, req)
				return
			}
			if err := d.DeleteSession(req.Context(), sessionID(req)); err != nil {
				s.fail(w, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}
}

// deleteWithWorktree removes the session together with its worktree folder.
func (s *server) deleteWithWorktree(w http.ResponseWriter, req *http.Request) {
	if s.cfg.Worktrees == nil {
		writeJSON(w, http.StatusNotImplemented, errorBody{"removing worktrees is not supported"})
		return
	}
	if err := s.cfg.Worktrees.Delete(req.Context(), sessionID(req), true); err != nil {
		s.failWorktree(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
