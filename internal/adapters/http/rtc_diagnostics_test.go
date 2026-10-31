package httpapi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
	"github.com/pion/webrtc/v4"
)

func TestRTCCheckCountersExcludeCandidateAddresses(t *testing.T) {
	got := rtcCheckCounters(webrtc.StatsReport{
		"pair":      webrtc.ICECandidatePairStats{State: webrtc.StatsICECandidatePairStateSucceeded, RequestsSent: 12, ResponsesReceived: 3, RequestsReceived: 20, ResponsesSent: 20},
		"candidate": webrtc.ICECandidateStats{IP: "private-address-marker"},
	})
	if got.Total != 1 || got.Succeeded != 1 || got.RequestsSent != 12 || got.ResponsesReceived != 3 || got.RequestsReceived != 20 || got.ResponsesSent != 20 {
		t.Fatalf("counters: %+v", got)
	}
	data, _ := json.Marshal(got)
	if strings.Contains(string(data), "private-address-marker") {
		t.Fatal("candidate address entered diagnostics")
	}
}

func TestRTCDiagnosticsRetainBoundedClosedAttempts(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pc.Close() }()
	var d rtcDiagnostics
	stop := d.attach("terminal", pc)
	if got := d.snapshot(); len(got) != 1 || !got[0].Active || got[0].ID != "terminal" {
		t.Fatalf("active: %+v", got)
	}
	stop()
	if got := d.snapshot(); len(got) != 1 || got[0].Active {
		t.Fatalf("closed: %+v", got)
	}
	for i := range 70 {
		d.attach(domain.TerminalID(fmt.Sprintf("terminal-%d", i)), pc)()
	}
	if got := len(d.snapshot()); got != 64 {
		t.Fatalf("retained %d attempts", got)
	}
}
