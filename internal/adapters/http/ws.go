package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// PresenceTracker learns from each open page where the owner is, and says
// which page they were at last.
type PresenceTracker interface {
	Report(l app.Look)
	Leave(client string)
	Active() string
	Subscribe() (updates <-chan string, stop func())
}

// presenceFrame travels both ways on the event socket. A page says what it
// shows and whether it is visible and focused; the server says which page
// the owner was at last (active).
type presenceFrame struct {
	Type    string           `json:"type"`
	Client  string           `json:"client,omitempty"`
	Session domain.SessionID `json:"session,omitempty"`
	Visible bool             `json:"visible,omitempty"`
	Focused bool             `json:"focused,omitempty"`
	Active  *string          `json:"active,omitempty"`
}

// websocket streams normalized events to a client until it disconnects. The
// connection is already authenticated by the token middleware. The page
// may report its presence on the same socket.
func (s *server) websocket(w http.ResponseWriter, r *http.Request) {
	c, err := acceptSameOrigin(w, r)
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	sub := s.cfg.Events.Subscribe()
	defer sub.Close()

	presence := s.cfg.Presence
	var active <-chan string
	looks := make(chan app.Look, 8)
	if presence != nil {
		updates, stop := presence.Subscribe()
		defer stop()
		active = updates
		now := presence.Active()
		if err := wsjson.Write(ctx, c, presenceFrame{Type: "presence", Active: &now}); err != nil {
			return
		}
	}
	// Reading notices close frames and a vanished peer, which cancels ctx,
	// and takes the page's presence reports.
	go func() {
		defer cancel()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			var f presenceFrame
			if json.Unmarshal(data, &f) != nil || f.Type != "presence" || f.Client == "" {
				continue
			}
			select {
			case looks <- app.Look{Client: f.Client, Session: f.Session, Visible: f.Visible, Focused: f.Focused}:
			case <-ctx.Done():
				return
			}
		}
	}()

	client := ""
	defer func() {
		if presence != nil && client != "" {
			presence.Leave(client)
		}
	}()
	for {
		select {
		case ev := <-sub.Events():
			if err := wsjson.Write(ctx, c, ev); err != nil {
				return
			}
		case l := <-looks:
			if presence == nil {
				continue
			}
			if client != "" && client != l.Client {
				presence.Leave(client)
			}
			client = l.Client
			presence.Report(l)
		case now, ok := <-active:
			if !ok {
				active = nil
				continue
			}
			if err := wsjson.Write(ctx, c, presenceFrame{Type: "presence", Active: &now}); err != nil {
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
	return acceptSameOriginCompression(w, r, websocket.CompressionDisabled)
}

func acceptSameOriginCompression(w http.ResponseWriter, r *http.Request, compression websocket.CompressionMode) (*websocket.Conn, error) {
	if !sameOrigin(r) {
		http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
		return nil, errCrossOrigin
	}
	return websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    compression,
	})
}

var errCrossOrigin = errors.New("cross-origin websocket")
