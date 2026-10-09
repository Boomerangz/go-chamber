package main

import (
	"context"
	"net/http"
	"regexp"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func TestRunServesMCP(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	out := &syncBuf{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"-addr", "127.0.0.1:0", "-data", t.TempDir(), "-mcp-allow-approvals"}, out)
	}()
	re := regexp.MustCompile(`http://(\S+)/\?token=(\w+)`)
	var m []string
	for deadline := time.Now().Add(5 * time.Second); m == nil && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		m = re.FindStringSubmatch(out.String())
	}
	if m == nil {
		t.Fatalf("no startup URL in output: %q", out.String())
	}

	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:   "http://" + m[1] + "/api/mcp",
		HTTPClient: &http.Client{Transport: bearer{m[2]}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cs.Close() }()
	res, err := cs.CallTool(ctx, &sdk.CallToolParams{Name: "list_sessions", Arguments: map[string]any{}})
	if err != nil || res.IsError {
		t.Fatalf("list_sessions: %v %+v", err, res)
	}

	// A connected client keeps a stream open: were shutdown to wait on it,
	// it would give up with a deadline error.
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}
}
