package httpapi

import (
	"context"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// SessionRenamer names sessions.
type SessionRenamer interface {
	RenameSession(ctx context.Context, id domain.SessionID, title string) (domain.SessionSnapshot, error)
}

// TerminalRenamer names terminals.
type TerminalRenamer interface {
	Rename(id domain.TerminalID, title string) (domain.Terminal, error)
}

type titleBody struct {
	Title string `json:"title"`
}

func (s *server) renameRoutes() {
	if r, ok := s.cfg.Sessions.(SessionRenamer); ok {
		s.mux.HandleFunc("POST /api/sessions/{id}/title", func(w http.ResponseWriter, req *http.Request) {
			var body titleBody
			if !decode(w, req, &body) {
				return
			}
			snap, err := r.RenameSession(req.Context(), sessionID(req), body.Title)
			if err != nil {
				s.fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, snap)
		})
	}
	if r, ok := s.cfg.Terminals.(TerminalRenamer); ok {
		s.mux.HandleFunc("POST /api/terminals/{id}/title", func(w http.ResponseWriter, req *http.Request) {
			var body titleBody
			if !decode(w, req, &body) {
				return
			}
			term, err := r.Rename(domain.TerminalID(req.PathValue("id")), body.Title)
			if err != nil {
				s.fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, term)
		})
	}
}
