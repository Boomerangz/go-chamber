package httpapi

import (
	"net/http"

	"github.com/igorzygin/go-chamber/internal/adapters/webpush"
)

// PushSubscriptions registers browsers for Web Push notifications.
type PushSubscriptions interface {
	PublicKey() string
	Subscribe(sub webpush.Subscription) error
	Unsubscribe(endpoint string) error
}

func (s *server) pushRoutes() {
	if s.cfg.Push == nil {
		return
	}
	s.mux.HandleFunc("GET /api/push/key", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"key": s.cfg.Push.PublicKey()})
	})
	s.mux.HandleFunc("POST /api/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		var sub webpush.Subscription
		if !decode(w, r, &sub) {
			return
		}
		if err := s.cfg.Push.Subscribe(sub); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	s.mux.HandleFunc("DELETE /api/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if !decode(w, r, &body) {
			return
		}
		if err := s.cfg.Push.Unsubscribe(body.Endpoint); err != nil {
			s.fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// publicFiles are served without a login: browsers fetch the manifest and
// its icons without cookies, and they hold no data.
var publicFiles = map[string]bool{
	"/manifest.webmanifest": true,
	"/sw.js":                true,
	"/icon.svg":             true,
	"/icon-192.png":         true,
	"/icon-512.png":         true,
	"/favicon.svg":          true,
}
