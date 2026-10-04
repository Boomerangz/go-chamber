package httpapi

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/igorzygin/go-chamber/internal/app"
)

// Count actual bytes received on the socket, including WebSocket framing.
type countedTerminalConn struct {
	net.Conn
	received atomic.Int64
}

func (c *countedTerminalConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.received.Add(int64(n))
	return n, err
}

func TestTerminalPTYCompression(t *testing.T) {
	for _, compressed := range []bool{false, true} {
		name := "plain"
		if compressed {
			name = "compressed"
		}
		t.Run(name, func(t *testing.T) {
			e := newTermEnv(t)
			term, err := e.terms.Open(context.Background(), app.OpenTerminal{})
			if err != nil {
				t.Fatal(err)
			}
			var wire *countedTerminalConn
			transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				conn, dialErr := (&net.Dialer{}).DialContext(ctx, network, address)
				if dialErr != nil {
					return nil, dialErr
				}
				wire = &countedTerminalConn{Conn: conn}
				return wire, nil
			}}
			t.Cleanup(transport.CloseIdleConnections)
			mode := websocket.CompressionDisabled
			if compressed {
				mode = websocket.CompressionNoContextTakeover
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c, res, err := websocket.Dial(ctx, e.ts.URL+"/api/terminals/"+string(term.ID)+"/pty", &websocket.DialOptions{ //nolint:bodyclose // successful upgrade has no response body
				HTTPClient:      &http.Client{Transport: transport},
				HTTPHeader:      http.Header{"Authorization": {"Bearer " + testToken}},
				CompressionMode: mode,
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = c.CloseNow() })
			ext := res.Header.Get("Sec-WebSocket-Extensions")
			if compressed != strings.Contains(ext, "permessage-deflate") {
				t.Fatalf("compression negotiation = %q, compressed = %v", ext, compressed)
			}
			if compressed && (!strings.Contains(ext, "server_no_context_takeover") || !strings.Contains(ext, "client_no_context_takeover")) {
				t.Fatalf("compression retained a dictionary between messages: %q", ext)
			}
			readFrame(t, c) // ready, before measuring output
			p := e.factory.ptys[0]
			large := strings.Repeat("\x1b[32mterminal output line\x1b[0m\r\n", 200)
			for _, output := range []string{large, large, "x"} {
				before := wire.received.Load()
				go func() { _, _ = p.outW.Write([]byte(output)) }()
				if typ, got := readFrame(t, c); typ != websocket.MessageBinary || got != output {
					t.Fatalf("output mismatch: type %v, bytes %d", typ, len(got))
				}
				bytes := wire.received.Load() - before
				if len(output) == 1 && bytes != 3 {
					t.Fatalf("short output used %d wire bytes, want 3 (no compression)", bytes)
				}
				if len(output) > 1 {
					if compressed && bytes >= int64(len(output)/4) {
						t.Fatalf("large output not reduced: %d wire bytes / %d raw", bytes, len(output))
					}
					if !compressed && bytes < int64(len(output)) {
						t.Fatalf("unnegotiated compression: %d wire bytes / %d raw", bytes, len(output))
					}
					t.Logf("output: %d raw bytes → %d wire bytes", len(output), bytes)
				}
			}
		})
	}
}
