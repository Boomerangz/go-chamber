package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// HistoryService lists and imports conversations recorded outside go-chamber.
type HistoryService interface {
	List(ctx context.Context) ([]app.ExternalSession, error)
	Import(ctx context.Context, agent domain.AgentKind, nativeID string) (domain.SessionSnapshot, error)
}

func (s *server) historyRoutes() {
	if s.cfg.History == nil {
		return
	}
	s.mux.HandleFunc("GET /api/history", s.listHistory)
	s.mux.HandleFunc("POST /api/history/import", s.importHistory)
}

func (s *server) listHistory(w http.ResponseWriter, r *http.Request) {
	list, err := s.cfg.History.List(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *server) importHistory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Agent    domain.AgentKind `json:"agent"`
		NativeID string           `json:"nativeId"`
	}
	if !decode(w, r, &body) {
		return
	}
	snap, err := s.cfg.History.Import(r.Context(), body.Agent, body.NativeID)
	if errors.Is(err, app.ErrHistoryNotFound) {
		writeJSON(w, http.StatusNotFound, errorBody{Error: err.Error()})
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, snap)
}
