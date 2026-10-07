package httpapi

import (
	"net/http"
	"runtime"
	"time"

	"github.com/coder/websocket"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/app"
)

func (s *server) diagnosticsRoutes() {
	s.mux.HandleFunc("GET /api/diagnostics", s.diagnostics)
	s.mux.HandleFunc("GET /api/diagnostics/ws", s.diagnosticsEcho)
	s.mux.HandleFunc("GET /api/agents", s.agents)
}

// CLIReporter tells which agent CLIs are installed.
type CLIReporter interface {
	CLIs() []app.CLIStatus
}

func (s *server) clis() []app.CLIStatus {
	if r, ok := s.cfg.Sessions.(CLIReporter); ok {
		return r.CLIs()
	}
	return []app.CLIStatus{}
}

// agents says which agent CLIs are installed, for the new-session form.
func (s *server) agents(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, s.clis())
}

func (s *server) diagnostics(w http.ResponseWriter, _ *http.Request) {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	var events hub.Stats
	if s.cfg.Events != nil {
		events = s.cfg.Events.Stats()
	}
	terminals := []app.TerminalDiagnostic{}
	if provider, ok := s.cfg.Terminals.(interface {
		Diagnostics() []app.TerminalDiagnostic
	}); ok {
		terminals = provider.Diagnostics()
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, struct {
		UptimeSeconds float64                  `json:"uptimeSeconds"`
		Goroutines    int                      `json:"goroutines"`
		HeapBytes     uint64                   `json:"heapBytes"`
		Events        hub.Stats                `json:"events"`
		Terminals     []app.TerminalDiagnostic `json:"terminals"`
		CLIs          []app.CLIStatus          `json:"clis"`
	}{time.Since(s.started).Seconds(), runtime.NumGoroutine(), memory.HeapAlloc, events, terminals, s.clis()})
}

// A separate bounded echo channel measures round trips with the browser's
// monotonic clock, without changing agent or terminal protocols.
func (s *server) diagnosticsEcho(w http.ResponseWriter, r *http.Request) {
	c, err := acceptSameOrigin(w, r)
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(128)
	for {
		kind, data, err := c.Read(r.Context())
		if err != nil {
			return
		}
		if kind != websocket.MessageText {
			_ = c.Close(websocket.StatusUnsupportedData, "text probes only")
			return
		}
		if err := c.Write(r.Context(), kind, data); err != nil {
			return
		}
	}
}
