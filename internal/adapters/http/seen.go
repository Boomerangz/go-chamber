package httpapi

import (
	"context"
	"net/http"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// SessionWatcher records that the owner looked at a session.
type SessionWatcher interface {
	MarkSeen(ctx context.Context, id domain.SessionID, item domain.ItemID) (domain.SessionSnapshot, error)
}

type seenBody struct {
	Item domain.ItemID `json:"item"`
}

func (s *server) seenRoutes() {
	w, ok := s.cfg.Sessions.(SessionWatcher)
	if !ok {
		return
	}
	s.mux.HandleFunc("POST /api/sessions/{id}/seen", func(rw http.ResponseWriter, req *http.Request) {
		var body seenBody
		if !decode(rw, req, &body) {
			return
		}
		snap, err := w.MarkSeen(req.Context(), sessionID(req), body.Item)
		if err != nil {
			s.fail(rw, err)
			return
		}
		writeJSON(rw, http.StatusOK, snap)
	})
}
