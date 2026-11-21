package mcpclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type emptyTools struct{}

func (emptyTools) Definitions() []domain.ModelTool                               { return nil }
func (emptyTools) NeedsApproval(domain.ModelToolCall) bool                       { return false }
func (emptyTools) Execute(context.Context, domain.ModelToolCall) (string, error) { return "local", nil }
func TestMCPToolsDiscoverCallAndRequireApproval(t *testing.T) {
	server := sdk.NewServer(&sdk.Implementation{Name: "fake", Version: "1"}, nil)
	server.AddTool(&sdk.Tool{Name: "lookup", Description: "Lookup", InputSchema: json.RawMessage(`{"type":"object"}`)}, func(context.Context, *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: "found"}}}, nil
	})
	httpServer := httptest.NewServer(sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, nil))
	defer httpServer.Close()
	tools, err := Connect(context.Background(), emptyTools{}, []Config{{Name: "test", URL: httpServer.URL}}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tools.Close() }()
	defs := tools.Definitions()
	if len(defs) != 1 || defs[0].Name != "mcp_test_lookup" {
		t.Fatalf("%+v", defs)
	}
	call := domain.ModelToolCall{Name: defs[0].Name, Arguments: json.RawMessage(`{}`)}
	if !tools.NeedsApproval(call) {
		t.Fatal("untrusted server annotations bypass approvals")
	}
	result, err := tools.Execute(context.Background(), call)
	if err != nil || !strings.Contains(result, "found") {
		t.Fatalf("%s %v", result, err)
	}
}

func TestMCPFailuresAndDelegation(t *testing.T) {
	ctx := context.Background()
	for _, cfg := range []Config{{Name: "bad name", URL: "http://localhost"}, {Name: "both", URL: "http://localhost", Command: "x"}, {Name: "missing"}, {Name: "stdio", Command: "/nonexistent-native-mcp-command"}, {Name: "http", URL: ":invalid"}} {
		if _, err := Connect(ctx, emptyTools{}, []Config{cfg}, t.TempDir()); err == nil {
			t.Fatalf("accepted %+v", cfg)
		}
	}
	for _, names := range [][]string{{"bad.name"}, {"repeat", "repeat"}} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var req struct {
				ID     any    `json:"id"`
				Method string `json:"method"`
			}
			_ = json.NewDecoder(r.Body).Decode(&req)
			w.Header().Set("Content-Type", "application/json")
			if req.Method == "initialize" {
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "test", "version": "1"}}})
				return
			}
			if req.Method == "tools/list" {
				tools := []any{}
				for _, name := range names {
					tools = append(tools, map[string]any{"name": name, "inputSchema": map[string]string{"type": "object"}})
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"tools": tools}})
				return
			}
			w.WriteHeader(202)
		}))
		_, err := Connect(ctx, emptyTools{}, []Config{{Name: "test", URL: server.URL}}, t.TempDir())
		server.Close()
		if err == nil {
			t.Fatalf("accepted tools %v", names)
		}
	}
	tools, err := Connect(ctx, emptyTools{}, nil, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if tools.NeedsApproval(domain.ModelToolCall{Name: "local"}) {
		t.Fatal("changed local approval")
	}
	result, err := tools.Execute(ctx, domain.ModelToolCall{Name: "local"})
	if err != nil || result != "local" {
		t.Fatal(result, err)
	}
	if err = tools.Close(); err != nil {
		t.Fatal(err)
	}
}
func TestMCPHeadersOutputLimitAndCancelledCalls(t *testing.T) {
	t.Setenv("NATIVE_MCP_TEST_KEY", "secret")
	server := sdk.NewServer(&sdk.Implementation{Name: "fake", Version: "1"}, nil)
	server.AddTool(&sdk.Tool{Name: "large", InputSchema: json.RawMessage(`{"type":"object"}`)}, func(context.Context, *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: strings.Repeat("x", 100000)}}}, nil
	})
	handler := sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, nil)
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "secret" {
			t.Error("missing configured header")
		}
		handler.ServeHTTP(w, r)
	}))
	defer httpServer.Close()
	tools, err := Connect(context.Background(), emptyTools{}, []Config{{Name: "test", URL: httpServer.URL, HeaderEnv: map[string]string{"Authorization": "NATIVE_MCP_TEST_KEY"}}}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tools.Close() }()
	call := domain.ModelToolCall{Name: "mcp_test_large", Arguments: json.RawMessage(`{}`)}
	result, err := tools.Execute(context.Background(), call)
	if err != nil || len(result) > 66000 || !strings.Contains(result, "truncated") {
		t.Fatal("output not bounded", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tools.Execute(ctx, call); err == nil {
		t.Fatal("cancel ignored")
	}
	req, _ := http.NewRequest("GET", httpServer.URL, nil)
	if response, err := (headerTransport{map[string]string{"Authorization": "NATIVE_MCP_MISSING"}}).RoundTrip(req); err == nil {
		_ = response.Body.Close()
		t.Fatal("missing header env accepted")
	}
}
