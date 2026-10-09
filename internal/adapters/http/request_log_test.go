package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newLoggedServer(mcp http.Handler) (http.Handler, *bytes.Buffer) {
	var buf bytes.Buffer
	return NewServer(Config{Token: testToken, MCP: mcp, OAuth: &fakeOAuth{}, RequestLog: &buf}), &buf
}

func TestMCPRequestsAreLoggedWithoutTheirTokens(t *testing.T) {
	var got string
	srv, log := newLoggedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.WriteHeader(http.StatusAccepted)
	}))
	body := `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
	req := httptest.NewRequest("POST", "/api/mcp", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer linked")
	req.Header.Set("Mcp-Protocol-Version", "2025-06-18")
	req.Header.Set("User-Agent", "openai-mcp/1.0")
	do(srv, req)

	if got != body {
		t.Fatalf("the endpoint read %q", got)
	}
	line := log.String()
	for _, want := range []string{"POST /api/mcp 202", "rpc=tools/list", "protocol=2025-06-18", "bearer=yes", `ua="openai-mcp/1.0"`} {
		if !strings.Contains(line, want) {
			t.Errorf("log %q lacks %q", line, want)
		}
	}
	if strings.Contains(line, "linked") {
		t.Fatalf("log leaks the token: %q", line)
	}
}

func TestRejectedMCPRequestsLogWhy(t *testing.T) {
	srv, log := newLoggedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":{"code":-32022,"message":"protocol version not supported"}}`, http.StatusBadRequest)
	}))
	req := httptest.NewRequest("POST", "/api/mcp", strings.NewReader(`[{"jsonrpc":"2.0","id":1,"method":"server/discover"}]`))
	req.Header.Set("Authorization", "Bearer linked")
	do(srv, req)
	do(srv, httptest.NewRequest("POST", "/api/mcp", nil))

	lines := log.String()
	for _, want := range []string{"rpc=server/discover", "400", "protocol version not supported", "POST /api/mcp 401", "bearer=no"} {
		if !strings.Contains(lines, want) {
			t.Errorf("log %q lacks %q", lines, want)
		}
	}
}

func TestOnlyMCPAndOAuthRequestsAreLogged(t *testing.T) {
	srv, log := newLoggedServer(http.NotFoundHandler())
	do(srv, httptest.NewRequest("GET", "/.well-known/oauth-authorization-server", nil))
	do(srv, httptest.NewRequest("GET", "/api/sessions", nil))
	if lines := log.String(); !strings.Contains(lines, "/.well-known/oauth-authorization-server") || strings.Contains(lines, "/api/sessions") {
		t.Fatalf("log = %q", lines)
	}
}
