package httpapi

import (
	"errors"
	"net/http"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// websocket streams normalized events to a client until it disconnects. The
// connection is already authenticated by the token middleware.
func (s *server) websocket(w http.ResponseWriter, r *http.Request) {
	c, err := acceptSameOrigin(w, r)
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()

	// The client sends nothing; reading only notices close frames and a
	// vanished peer, which cancels ctx.
	ctx := c.CloseRead(r.Context())
	sub := s.cfg.Events.Subscribe()
	defer sub.Close()

	for {
		select {
		case ev := <-sub.Events():
			if err := wsjson.Write(ctx, c, ev); err != nil {
				return
			}
		case <-sub.Done():
			return
		case <-ctx.Done():
			return
		}
	}
}

// acceptSameOrigin upgrades only same-origin WebSockets. The origin check is
// ours (see sameOrigin) rather than the library's so proxies that rewrite
// Host keep working.
func acceptSameOrigin(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	if !sameOrigin(r) {
		http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
		return nil, errCrossOrigin
	}
	return websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
}

var errCrossOrigin = errors.New("cross-origin websocket")
