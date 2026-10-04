package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/pion/webrtc/v4"
)

func TestRTCConfigRequiresAuthentication(t *testing.T) {
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}})
	if got := do(h, authed("GET", "/api/rtc/config", "")); got.Code != http.StatusOK {
		t.Fatalf("config: %d %s", got.Code, got.Body.String())
	}
	if got := do(h, httptest.NewRequest("GET", "/api/rtc/config", nil)); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: %d", got.Code)
	}
}

func TestParseICEServers(t *testing.T) {
	for _, raw := range []string{`[]`, `[{"urls":["stun:stun.example.org:3478"]}]`, `[{"urls":["turn:turn.example.org:3478"],"username":"u","credential":"p"}]`} {
		if _, err := ParseICEServers(raw); err != nil {
			t.Fatalf("valid ICE config rejected: %v", err)
		}
	}
	for _, raw := range []string{`{`, `[{}]`, `[{"urls":["https://example.org"]}]`, `[{"urls":["turn:example.org:3478"]}]`} {
		if _, err := ParseICEServers(raw); err == nil {
			t.Fatal("invalid ICE config accepted")
		}
	}
}

func TestRTCRejectsInvalidOffersAndCrossOrigin(t *testing.T) {
	e := newTermEnv(t)
	term, err := e.terms.Open(context.Background(), app.OpenTerminal{Cwd: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{`, `{"type":"answer","sdp":"x"}`, `{"type":"offer","sdp":"bad-sdp"}`} {
		req := authed("POST", "/api/terminals/"+string(term.ID)+"/rtc", body)
		got := do(e.ts.Config.Handler, req)
		if got.Code != http.StatusBadRequest {
			t.Fatalf("invalid offer: %d %s", got.Code, got.Body.String())
		}
	}
	req := authed("POST", "/api/terminals/"+string(term.ID)+"/rtc", `{}`)
	req.Header.Set("Origin", "https://elsewhere.invalid")
	if got := do(e.ts.Config.Handler, req); got.Code != http.StatusForbidden {
		t.Fatalf("cross origin: %d", got.Code)
	}
	if got := do(e.ts.Config.Handler, httptest.NewRequest("POST", "/api/terminals/"+string(term.ID)+"/rtc", nil)); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized: %d", got.Code)
	}
	if got := do(e.ts.Config.Handler, authed("POST", "/api/terminals/missing/rtc", `{}`)); got.Code != http.StatusNotFound {
		t.Fatalf("missing terminal: %d", got.Code)
	}
}

func TestRTCTerminalStreamsInputOutputResizeAndPing(t *testing.T) {
	e := newTermEnv(t)
	term, err := e.terms.Open(context.Background(), app.OpenTerminal{Cwd: "/tmp"})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pc.Close() }()
	dc, err := pc.CreateDataChannel("terminal", nil)
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan webrtc.DataChannelMessage, 16)
	dc.OnMessage(func(m webrtc.DataChannelMessage) { received <- m })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathering := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathering:
	case <-time.After(5 * time.Second):
		t.Fatal("gathering timed out")
	}
	body, _ := json.Marshal(pc.LocalDescription())
	req := authed("POST", "/api/terminals/"+string(term.ID)+"/rtc", "")
	req.URL.Scheme = "http"
	req.RequestURI = ""
	req.URL.Host = e.ts.Listener.Addr().String()
	req.Body = io.NopCloser(bytes.NewReader(body))
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("offer: %d", response.StatusCode)
	}
	var answer webrtc.SessionDescription
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if err := pc.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	next := func() webrtc.DataChannelMessage {
		t.Helper()
		select {
		case msg := <-received:
			return msg
		case <-time.After(5 * time.Second):
			t.Fatal("data channel timed out")
			return webrtc.DataChannelMessage{}
		}
	}
	if ready := next(); !ready.IsString || !bytes.Contains(ready.Data, []byte("ready")) {
		t.Fatalf("ready: %+v", ready)
	}
	if err := dc.Send([]byte("input")); err != nil {
		t.Fatal(err)
	}
	if err := dc.SendText(`{"type":"resize","cols":100,"rows":30}`); err != nil {
		t.Fatal(err)
	}
	if err := dc.SendText(`{"type":"ping","token":"42"}`); err != nil {
		t.Fatal(err)
	}
	if pong := next(); !pong.IsString || !bytes.Contains(pong.Data, []byte(`"token":"42"`)) {
		t.Fatalf("pong: %+v", pong)
	}
	p := e.factory.ptys[0]
	p.mu.Lock()
	input, sizes := string(p.input), append([][2]uint16(nil), p.sizes...)
	p.mu.Unlock()
	if input != "input" || len(sizes) != 1 || sizes[0] != [2]uint16{100, 30} {
		t.Fatalf("input %q sizes %v", input, sizes)
	}
	if _, err := p.outW.Write([]byte("output")); err != nil {
		t.Fatal(err)
	}
	if output := next(); output.IsString || string(output.Data) != "output" {
		t.Fatalf("output: %+v", output)
	}
	p.exit(7)
	if exit := next(); !exit.IsString || !bytes.Contains(exit.Data, []byte(`"code":7`)) {
		t.Fatalf("exit: %+v", exit)
	}
}
