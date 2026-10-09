package mcpapi_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	mcpapi "github.com/igorzygin/go-chamber/internal/adapters/mcp"
)

func post(t *testing.T, url, version, method, body string) (http.Header, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Mcp-Protocol-Version", version)
	if method != "" {
		req.Header.Set("Mcp-Method", method)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	return resp.Header, string(b)
}

// ChatGPT asks server/discover on 2026-07-28 and gives up unless that
// version is offered; older clients still get a session from initialize.
func TestServesBothTheStatelessAndTheSessionProtocol(t *testing.T) {
	h := hub.New()
	s := mcpapi.New(mcpapi.Config{Sessions: newFakeSessions(h), Events: h})
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	meta := `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"chatgpt","version":"1"}}`

	_, body := post(t, srv.URL, "2026-07-28", "server/discover", `{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{`+meta+`}}`)
	if !strings.Contains(body, `"supportedVersions":["2026-07-28"`) {
		t.Fatalf("discover = %s", body)
	}
	_, body = post(t, srv.URL, "2026-07-28", "tools/list", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{`+meta+`}}`)
	if !strings.Contains(body, `"send_message"`) {
		t.Fatalf("tools/list = %s", body)
	}

	header, body := post(t, srv.URL, "2025-06-18", "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex","version":"1"}}}`)
	if header.Get("Mcp-Session-Id") == "" {
		t.Fatalf("initialize gave no session: %s", body)
	}
}
