package httpapi

import "net/http"

func (s *server) setPermissionMode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if !decode(w, r, &body) {
		return
	}
	snap, err := s.cfg.Sessions.SetPermissionMode(r.Context(), sessionID(r), body.Mode)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}
