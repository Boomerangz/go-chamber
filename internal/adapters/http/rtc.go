package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

// ICEServer is shared with the authenticated browser for direct connection
// discovery and optional TURN relay. Credentials never enter diagnostics.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func ParseICEServers(raw string) ([]ICEServer, error) {
	var servers []ICEServer
	if err := json.Unmarshal([]byte(raw), &servers); err != nil {
		return nil, fmt.Errorf("invalid ICE servers JSON")
	}
	for _, server := range servers {
		if len(server.URLs) == 0 {
			return nil, fmt.Errorf("ICE server has no URLs")
		}
		for _, url := range server.URLs {
			uri, err := stun.ParseURI(url)
			if err != nil {
				return nil, fmt.Errorf("invalid ICE server URL")
			}
			if (uri.Scheme == stun.SchemeTypeTURN || uri.Scheme == stun.SchemeTypeTURNS) && (server.Username == "" || server.Credential == "") {
				return nil, fmt.Errorf("TURN server requires username and credential")
			}
		}
	}
	return servers, nil
}

func (s *server) rtcRoutes() {
	s.mux.HandleFunc("GET /api/rtc/config", func(w http.ResponseWriter, _ *http.Request) {
		servers := s.cfg.ICEServers
		if servers == nil {
			servers = []ICEServer{}
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, struct {
			ICEServers []ICEServer `json:"iceServers"`
		}{servers})
	})
	if s.cfg.Terminals != nil {
		s.mux.HandleFunc("POST /api/terminals/{id}/rtc", s.terminalRTC)
	}
}

func (s *server) terminalRTC(w http.ResponseWriter, r *http.Request) {
	id := domain.TerminalID(r.PathValue("id"))
	if _, err := s.cfg.Terminals.Get(id); err != nil {
		s.fail(w, err)
		return
	}
	var offer webrtc.SessionDescription
	if !decode(w, r, &offer) {
		return
	}
	if offer.Type != webrtc.SDPTypeOffer || len(offer.SDP) > 128<<10 {
		writeJSON(w, http.StatusBadRequest, errorBody{"invalid RTC offer"})
		return
	}
	select {
	case s.rtcSlots <- struct{}{}:
	default:
		writeJSON(w, http.StatusTooManyRequests, errorBody{"too many RTC connections"})
		return
	}
	parent := s.cfg.Lifecycle
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithCancel(parent)
	config := webrtc.Configuration{}
	for _, server := range s.cfg.ICEServers {
		config.ICEServers = append(config.ICEServers, webrtc.ICEServer{URLs: server.URLs, Username: server.Username, Credential: server.Credential})
	}
	settings := webrtc.SettingEngine{}
	settings.SetSTUNGatherTimeout(3 * time.Second)
	settings.SetICETimeouts(3*time.Second, 6*time.Second, time.Second)
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(config)
	if err != nil {
		cancel()
		<-s.rtcSlots
		writeJSON(w, http.StatusInternalServerError, errorBody{"RTC configuration failed"})
		return
	}
	opened := make(chan struct{})
	var claimed atomic.Bool
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			cancel()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "terminal" || !dc.Ordered() || dc.MaxPacketLifeTime() != nil || dc.MaxRetransmits() != nil || claimed.Swap(true) {
			cancel()
			return
		}
		dc.OnClose(cancel)
		dc.OnError(func(error) { cancel() })
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if len(msg.Data) > 1<<20 {
				cancel()
				return
			}
			if !msg.IsString {
				if err := s.cfg.Terminals.Write(id, msg.Data); err != nil {
					cancel()
				}
				return
			}
			var ctl struct {
				Type  string `json:"type"`
				Cols  uint16 `json:"cols"`
				Rows  uint16 `json:"rows"`
				Token string `json:"token"`
			}
			if json.Unmarshal(msg.Data, &ctl) != nil {
				return
			}
			switch ctl.Type {
			case "resize":
				if err := s.cfg.Terminals.Resize(id, ctl.Cols, ctl.Rows); err != nil {
					cancel()
				}
			case "ping":
				if len(ctl.Token) <= 64 {
					data, _ := json.Marshal(struct {
						Type  string `json:"type"`
						Token string `json:"token"`
					}{"pong", ctl.Token})
					if err := dc.SendText(string(data)); err != nil {
						cancel()
					}
				}
			}
		})
		dc.OnOpen(func() { close(opened); go func() { defer cancel(); s.rtcOutput(ctx, dc, id) }() })
	})
	// Peers outlive the signaling request, but never an unopened handshake or
	// application shutdown. Close outside Pion callbacks to avoid deadlocks.
	go func() {
		defer func() { _ = pc.Close(); <-s.rtcSlots }()
		timer := time.NewTimer(15 * time.Second)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cancel()
			return
		case <-opened:
		}
		<-ctx.Done()
	}()
	succeeded := false
	defer func() {
		if !succeeded {
			cancel()
		}
	}()
	if err := pc.SetRemoteDescription(offer); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"invalid RTC offer"})
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"RTC answer failed"})
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorBody{"RTC gathering failed"})
		return
	}
	select {
	case <-gathered:
	case <-r.Context().Done():
		return
	case <-ctx.Done():
		writeJSON(w, http.StatusServiceUnavailable, errorBody{"RTC connection expired"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, pc.LocalDescription())
	succeeded = true
}

func (s *server) rtcOutput(ctx context.Context, dc *webrtc.DataChannel, id domain.TerminalID) {
	att, err := s.cfg.Terminals.Attach(id)
	if err != nil {
		_ = dc.SendText(`{"type":"closed"}`)
		return
	}
	defer att.Detach()
	send := func(data []byte) bool {
		for len(data) > 0 {
			// Keep the SCTP queue bounded rather than hiding a slow connection behind
			// unlimited buffered output. Small messages work across browser limits.
			for dc.BufferedAmount() > 128<<10 {
				select {
				case <-ctx.Done():
					return false
				case <-time.After(10 * time.Millisecond):
				}
			}
			size := min(len(data), 16<<10)
			if err := dc.Send(data[:size]); err != nil {
				return false
			}
			data = data[size:]
		}
		return true
	}
	if !send(att.Scrollback) || dc.SendText(`{"type":"ready"}`) != nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case data, ok := <-att.Output:
			if ok {
				// Line-by-line output arrives as one tiny chunk per line; a
				// message each falls behind and gets the client dropped.
				frame, open := coalesce(data, att.Output, maxTerminalFrame)
				if !send(frame) {
					return
				}
				if open {
					continue
				}
			}
			term, err := s.cfg.Terminals.Get(id)
			switch {
			case att.Lagged():
				_ = dc.SendText(`{"type":"fallback"}`)
			case errors.Is(err, app.ErrTerminalNotFound):
				_ = dc.SendText(`{"type":"closed"}`)
			case err == nil && term.Status == domain.TerminalExited:
				data, _ := json.Marshal(terminalExit{Type: "exit", Code: term.ExitCode})
				_ = dc.SendText(string(data))
			default:
				_ = dc.SendText(`{"type":"fallback"}`)
			}
			// Give the reliable channel time to deliver the final control message;
			// a browser that receives it closes the peer immediately.
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
			return
		}
	}
}
