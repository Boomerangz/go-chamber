package httpapi

import (
	"context"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Completer suggests @file mentions and /commands for the composer.
type Completer interface {
	Files(ctx context.Context, id domain.SessionID, query string) ([]app.FileMatch, error)
	Commands(ctx context.Context, id domain.SessionID) ([]app.Command, error)
}

func (s *server) completeRoutes() {
	if s.cfg.Complete == nil {
		return
	}
	s.mux.HandleFunc("GET /api/sessions/{id}/complete/files", s.completeFiles)
	s.mux.HandleFunc("GET /api/sessions/{id}/commands", s.listCommands)
}

func (s *server) completeFiles(w http.ResponseWriter, r *http.Request) {
	files, err := s.cfg.Complete.Files(r.Context(), sessionID(r), r.URL.Query().Get("q"))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, files)
}

func (s *server) listCommands(w http.ResponseWriter, r *http.Request) {
	cmds, err := s.cfg.Complete.Commands(r.Context(), sessionID(r))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cmds)
}
