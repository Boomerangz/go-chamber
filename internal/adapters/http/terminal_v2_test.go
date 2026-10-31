package httpapi

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/igorzygin/go-chamber/internal/adapters/terminalscreen"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
	"github.com/pion/webrtc/v4"
)

func dialV2(t *testing.T, e termEnv, id domain.TerminalID, client string) *websocket.Conn {
	t.Helper()
	c, res, err := websocket.Dial(context.Background(), e.ts.URL+"/api/terminals/"+string(id)+"/pty?v=2&client="+client, &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {CookieName + "=" + testToken}}})
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

func v2Ready(t *testing.T, c *websocket.Conn) (terminalV2Control, uint64) {
	t.Helper()
	var hello terminalV2Control
	typ, data := readFrame(t, c)
	if typ != websocket.MessageText || json.Unmarshal([]byte(data), &hello) != nil || hello.Type != "hello" {
		t.Fatalf("hello: %q", data)
	}
	if !hello.InputPipeline {
		t.Fatal("v2 server did not advertise input pipeline capability")
	}
	var count uint64
	for {
		typ, data = readFrame(t, c)
		if typ == websocket.MessageBinary {
			if len(data) > 16<<10 || data[0] != 2 {
				t.Fatalf("snapshot frame: %d", len(data))
			}
			count += uint64(len(data) - 9)
			if err := wsjson.Write(context.Background(), c, terminalV2Control{Type: "ack", Bytes: count}); err != nil {
				t.Fatal(err)
			}
		} else if strings.Contains(data, `"type":"ready"`) {
			return hello, count
		}
	}
}

func inputV2(epoch, offset uint64, text string) []byte {
	b := make([]byte, 17+len(text))
	b[0] = 3
	binary.BigEndian.PutUint64(b[1:9], epoch)
	binary.BigEndian.PutUint64(b[9:17], offset)
	copy(b[17:], text)
	return b
}

func TestTerminalV2ReconnectDeduplicatesInputAndRestoresScreen(t *testing.T) {
	e := newTermEnv(t, func(c *app.TerminalsConfig) { c.Screens = terminalscreen.Factory{} })
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{Cols: 20, Rows: 5})
	c := dialV2(t, e, term.ID, "a")
	hello, _ := v2Ready(t, c)
	if !hello.Owner || hello.Run == "" {
		t.Fatalf("hello=%+v", hello)
	}
	if err := c.Write(context.Background(), websocket.MessageBinary, inputV2(hello.Epoch, 0, "abc")); err != nil {
		t.Fatal(err)
	}
	_, ack := readFrame(t, c)
	if !strings.Contains(ack, `"written":3`) {
		t.Fatal(ack)
	}
	_ = c.CloseNow()
	c = dialV2(t, e, term.ID, "a")
	hello, _ = v2Ready(t, c)
	if hello.Written != 3 {
		t.Fatalf("written=%d", hello.Written)
	}
	if err := c.Write(context.Background(), websocket.MessageBinary, inputV2(hello.Epoch, 0, "abcdef")); err != nil {
		t.Fatal(err)
	}
	_, ack = readFrame(t, c)
	if !strings.Contains(ack, `"written":6`) {
		t.Fatal(ack)
	}
	e.factory.ptys[0].mu.Lock()
	got := string(e.factory.ptys[0].input)
	e.factory.ptys[0].mu.Unlock()
	if got != "abcdef" {
		t.Fatalf("input=%q", got)
	}
}

func TestTerminalV2OutputWindowDoesNotBlockCtrlC(t *testing.T) {
	e := newTermEnv(t, func(c *app.TerminalsConfig) { c.Screens = terminalscreen.Factory{} })
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	c := dialV2(t, e, term.ID, "a")
	hello, count := v2Ready(t, c)
	go func() { _, _ = e.factory.ptys[0].outW.Write([]byte(strings.Repeat("x", 128<<10))) }()
	var output uint64
	for output < 48<<10 {
		typ, data := readFrame(t, c)
		if typ != websocket.MessageBinary {
			continue
		}
		if len(data) > 16<<10 {
			t.Fatal("oversized frame")
		}
		output += uint64(len(data) - 9)
	}
	// No output ACKs: input still travels on the independent receive loop.
	if err := c.Write(context.Background(), websocket.MessageBinary, inputV2(hello.Epoch, 0, "\x03")); err != nil {
		t.Fatal(err)
	}
	for {
		typ, data := readFrame(t, c)
		if typ == websocket.MessageBinary {
			output += uint64(len(data) - 9)
			continue
		}
		if strings.Contains(data, `"type":"inputAck"`) {
			break
		}
	}
	if output > 64<<10 {
		t.Fatalf("window exceeded: %d", output)
	}
	if report := e.terms.Diagnostics()[0]; report.UnackedOutputBytes <= 0 || report.UnackedOutputBytes > 64<<10 {
		t.Fatalf("diagnostic window=%d", report.UnackedOutputBytes)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, terminalV2Control{Type: "ack", Bytes: count + output}); err != nil {
		t.Fatal(err)
	}
	typ, _ := readFrame(t, c)
	if typ != websocket.MessageBinary {
		t.Fatal("output did not resume")
	}
}

func TestRTCV2UsesSeparateReliableChannelsAndSameInputPrefix(t *testing.T) {
	t.Run("immediate answer", func(t *testing.T) { testRTCV2Channels(t, 0) })
	t.Run("delayed answer", func(t *testing.T) { testRTCV2Channels(t, 11*time.Second) })
	t.Run("bound interface", func(t *testing.T) {
		if runtime.GOOS != "darwin" {
			t.Skip("macOS interface binding contract")
		}
		testRTCV2Channels(t, 0, "lo0")
	})
}

func testRTCV2Channels(t *testing.T, answerDelay time.Duration, interfaces ...string) {
	t.Helper()
	e := newTermEnv(t, func(c *app.TerminalsConfig) { c.Screens = terminalscreen.Factory{} })
	settings := webrtc.SettingEngine{}
	if len(interfaces) > 0 {
		name := interfaces[0]
		e.ts.Close()
		e.ts = httptest.NewServer(NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Terminals: e.terms, RTCInterface: name}))
		t.Cleanup(e.ts.Close)
		settings.SetInterfaceFilter(func(candidate string) bool { return candidate == name })
		settings.SetIncludeLoopbackCandidate(true)
	}
	term, _ := e.terms.Open(context.Background(), app.OpenTerminal{})
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = pc.Close() }()
	control, _ := pc.CreateDataChannel("terminal-control-v2", nil)
	output, _ := pc.CreateDataChannel("terminal-output-v2", nil)
	controls := make(chan []byte, 20)
	outputs := make(chan []byte, 20)
	control.OnMessage(func(m webrtc.DataChannelMessage) { controls <- m.Data })
	output.OnMessage(func(m webrtc.DataChannelMessage) { outputs <- m.Data })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gather := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gather
	body, _ := json.Marshal(pc.LocalDescription())
	code, response := e.call(t, "POST", "/api/terminals/"+string(term.ID)+"/rtc?v=2&client=a", string(body))
	if code != 200 {
		t.Fatalf("signal=%d %s", code, response)
	}
	var answer webrtc.SessionDescription
	if err := json.Unmarshal([]byte(response), &answer); err != nil {
		t.Fatal(err)
	}
	// Model answer delivery through a delayed proxy while the server's ICE
	// agent has already begun checking. The terminal remains on WebSocket.
	time.Sleep(answerDelay)
	if err := pc.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	var hello terminalV2Control
	select {
	case b := <-controls:
		if json.Unmarshal(b, &hello) != nil || hello.Type != "hello" {
			t.Fatalf("hello=%s", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no hello on control channel")
	}
	var count uint64
	for {
		select {
		case b := <-outputs:
			if len(b) > 0 && b[0] == 2 {
				count += uint64(len(b) - 9)
				ack, _ := json.Marshal(terminalV2Control{Type: "ack", Bytes: count})
				if err := control.SendText(string(ack)); err != nil {
					t.Fatal(err)
				}
			} else if strings.Contains(string(b), `"type":"ready"`) {
				goto ready
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no snapshot on output channel")
		}
	}
ready:
	status, report := e.call(t, "GET", "/api/diagnostics", "")
	var diagnostics struct {
		RTC []rtcDiagnostic `json:"rtc"`
	}
	if status != 200 || json.Unmarshal([]byte(report), &diagnostics) != nil || len(diagnostics.RTC) != 1 || diagnostics.RTC[0].CandidatePairs.Succeeded == 0 {
		t.Fatalf("missing successful server ICE counters: %s", report)
	}
	if err := control.Send(inputV2(hello.Epoch, 0, "abc")); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-controls:
		if !strings.Contains(string(b), `"written":3`) {
			t.Fatalf("ack=%s", b)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no input ACK")
	}
}
