package httpapi

import (
	"slices"
	"strings"
	"sync"

	"github.com/igorzygin/go-chamber/internal/domain"
	"github.com/pion/webrtc/v4"
)

type iceCheckCounters struct {
	Total             int    `json:"total"`
	Succeeded         int    `json:"succeeded"`
	RequestsSent      uint64 `json:"requestsSent"`
	ResponsesReceived uint64 `json:"responsesReceived"`
	RequestsReceived  uint64 `json:"requestsReceived"`
	ResponsesSent     uint64 `json:"responsesSent"`
}

func rtcCheckCounters(stats webrtc.StatsReport) iceCheckCounters {
	var out iceCheckCounters
	for _, stat := range stats {
		pair, ok := stat.(webrtc.ICECandidatePairStats)
		if !ok {
			continue
		}
		out.Total++
		if pair.State == webrtc.StatsICECandidatePairStateSucceeded {
			out.Succeeded++
		}
		out.RequestsSent += pair.RequestsSent
		out.ResponsesReceived += pair.ResponsesReceived
		out.RequestsReceived += pair.RequestsReceived
		out.ResponsesSent += pair.ResponsesSent
	}
	return out
}

type rtcDiagnostic struct {
	ID             domain.TerminalID `json:"id"`
	Active         bool              `json:"active"`
	Connection     string            `json:"connectionState"`
	ICE            string            `json:"iceState"`
	CandidatePairs iceCheckCounters  `json:"candidatePairs"`
}

func rtcDiagnosticFor(id domain.TerminalID, pc *webrtc.PeerConnection, active bool) rtcDiagnostic {
	return rtcDiagnostic{ID: id, Active: active, Connection: pc.ConnectionState().String(), ICE: pc.ICEConnectionState().String(), CandidatePairs: rtcCheckCounters(pc.GetStats())}
}

// Only counts and states are retained. Native stats with addresses and ICE
// credentials never leave this adapter. Closed attempts are bounded separately
// from the active peers, which already have a 64-slot admission limit.
type rtcDiagnostics struct {
	mu     sync.Mutex
	active map[*webrtc.PeerConnection]domain.TerminalID
	last   map[domain.TerminalID]rtcDiagnostic
}

func (d *rtcDiagnostics) attach(id domain.TerminalID, pc *webrtc.PeerConnection) func() {
	d.mu.Lock()
	if d.active == nil {
		d.active = make(map[*webrtc.PeerConnection]domain.TerminalID)
		d.last = make(map[domain.TerminalID]rtcDiagnostic)
	}
	d.active[pc] = id
	d.mu.Unlock()
	return func() {
		out := rtcDiagnosticFor(id, pc, false)
		d.mu.Lock()
		defer d.mu.Unlock()
		delete(d.active, pc)
		if _, exists := d.last[id]; !exists && len(d.last) >= 64 {
			for old := range d.last {
				delete(d.last, old)
				break
			}
		}
		d.last[id] = out
	}
}

func (d *rtcDiagnostics) snapshot() []rtcDiagnostic {
	d.mu.Lock()
	latest := make(map[domain.TerminalID]rtcDiagnostic, len(d.last))
	for id, out := range d.last {
		latest[id] = out
	}
	active := make(map[*webrtc.PeerConnection]domain.TerminalID, len(d.active))
	for pc, id := range d.active {
		active[pc] = id
	}
	d.mu.Unlock()
	// GetStats may wait on ICE; never hold the registry lock while collecting.
	for pc, id := range active {
		latest[id] = rtcDiagnosticFor(id, pc, true)
	}
	out := make([]rtcDiagnostic, 0, len(latest))
	for _, item := range latest {
		out = append(out, item)
	}
	slices.SortFunc(out, func(a, b rtcDiagnostic) int { return strings.Compare(string(a.ID), string(b.ID)) })
	return out
}
