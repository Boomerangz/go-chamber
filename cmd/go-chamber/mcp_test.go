package main

import (
	"context"
	"io"
	"net/http"
	"regexp"
	"strings"
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
		done <- run(ctx, []string{"-addr", "127.0.0.1:0", "-data", t.TempDir(), "-mcp-allow-approvals", "-mcp-allow-commands", "-mcp-allow-auto-review", "-public-url", "https://chamber.test"}, out)
	}()
	re := regexp.MustCompile(`http://(\S+)/\?token=(\w+)`)
	var m []string
	for deadline := time.Now().Add(15 * time.Second); m == nil && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
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
	result, err := cs.CallTool(ctx, &sdk.CallToolParams{Name: "run_command", Arguments: map[string]any{
		"program": "/bin/pwd", "cwd": t.TempDir(),
	}})
	if err != nil || result.IsError {
		t.Fatalf("run_command: %v %+v", err, result)
	}
	started, err := cs.CallTool(ctx, &sdk.CallToolParams{Name: "start_session", Arguments: map[string]any{
		"agent": "codex", "cwd": t.TempDir(), "approval_reviewer": "auto_review",
	}})
	if err != nil || started.IsError {
		t.Fatalf("start_session auto reviewer: %v %+v", err, started)
	}

	// OAuth clients find their way in without the token.
	meta, err := http.Get("http://" + m[1] + "/.well-known/oauth-protected-resource/api/mcp")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(meta.Body)
	_ = meta.Body.Close()
	if meta.StatusCode != http.StatusOK || !strings.Contains(string(body), `"resource":"https://chamber.test/api/mcp"`) {
		t.Fatalf("metadata: %d %s", meta.StatusCode, body)
	}

	// A connected client keeps a stream open: were shutdown to wait on it,
	// it would give up with a deadline error.
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}
}
