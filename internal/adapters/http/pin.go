package httpapi

import (
	"context"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type SessionPinner interface {
	SetPinned(ctx context.Context, id domain.SessionID, on bool) (domain.SessionSnapshot, error)
}

func (s *server) pinRoutes() {
	if p, ok := s.cfg.Sessions.(SessionPinner); ok {
		s.mux.HandleFunc("POST /api/sessions/{id}/pin", func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Pinned *bool `json:"pinned"`
			}
			if !decode(w, r, &body) {
				return
			}
			if body.Pinned == nil {
				writeJSON(w, http.StatusBadRequest, errorBody{Error: "pinned is required"})
				return
			}
			snap, err := p.SetPinned(r.Context(), sessionID(r), *body.Pinned)
			if err != nil {
				s.fail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, snap)
		})
	}
}
