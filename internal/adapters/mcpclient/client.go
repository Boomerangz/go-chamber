// Package mcpclient connects explicitly configured MCP servers to native tools.
package mcpclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	Name    string   `json:"name"`
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	URL     string   `json:"url,omitempty"`
	// HeaderEnv maps HTTP header names to environment variable names.
	HeaderEnv map[string]string `json:"headerEnv,omitempty"`
}
type remoteTool struct {
	session *sdk.ClientSession
	name    string
}
type Tools struct {
	base        app.NativeTools
	definitions []domain.ModelTool
	remote      map[string]remoteTool
	sessions    []*sdk.ClientSession
	once        sync.Once
}

var toolName = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

func Connect(ctx context.Context, base app.NativeTools, configs []Config, cwd string) (*Tools, error) {
	t := &Tools{base: base, remote: map[string]remoteTool{}}
	fail := func(err error) (*Tools, error) { _ = t.Close(); return nil, err }
	for _, cfg := range configs {
		if !toolName.MatchString(cfg.Name) || (cfg.Command == "") == (cfg.URL == "") {
			return fail(errors.New("MCP requires a valid name and exactly one command or URL"))
		}
		var transport sdk.Transport
		if cfg.Command != "" {
			cmd := exec.Command(cfg.Command, cfg.Args...)
			cmd.Dir = cwd
			transport = &sdk.CommandTransport{Command: cmd, TerminateDuration: time.Second}
		} else {
			transport = &sdk.StreamableClientTransport{Endpoint: cfg.URL, HTTPClient: &http.Client{Transport: headerTransport{cfg.HeaderEnv}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, MaxRetries: -1}
		}
		startup, cancel := context.WithTimeout(ctx, 20*time.Second)
		client := sdk.NewClient(&sdk.Implementation{Name: "go-chamber-native", Version: "1"}, nil)
		session, err := client.Connect(startup, transport, nil)
		if err != nil {
			cancel()
			return fail(fmt.Errorf("MCP %s connection failed", cfg.Name))
		}
		t.sessions = append(t.sessions, session)
		cursor := ""
		for {
			list, e := session.ListTools(startup, &sdk.ListToolsParams{Cursor: cursor})
			if e != nil {
				cancel()
				return fail(fmt.Errorf("MCP %s tool discovery failed", cfg.Name))
			}
			for _, tool := range list.Tools {
				name := "mcp_" + cfg.Name + "_" + tool.Name
				if len(name) > 64 || !toolName.MatchString(name) {
					cancel()
					return fail(errors.New("MCP tool name is invalid or too long"))
				}
				if _, ok := t.remote[name]; ok {
					cancel()
					return fail(errors.New("duplicate MCP tool name"))
				}
				schema, e := json.Marshal(tool.InputSchema)
				if e != nil {
					cancel()
					return fail(e)
				}
				t.definitions = append(t.definitions, domain.ModelTool{Name: name, Description: tool.Description, Parameters: schema})
				t.remote[name] = remoteTool{session, tool.Name}
				if len(t.remote) > 256 {
					cancel()
					return fail(errors.New("MCP catalog exceeds 256 tools"))
				}
			}
			if list.NextCursor == "" {
				break
			}
			if list.NextCursor == cursor {
				cancel()
				return fail(errors.New("MCP catalog repeated cursor"))
			}
			cursor = list.NextCursor
		}
		cancel()
	}
	return t, nil
}
func (t *Tools) Definitions() []domain.ModelTool {
	return append(t.base.Definitions(), t.definitions...)
}
func (t *Tools) NeedsApproval(call domain.ModelToolCall) bool {
	if _, ok := t.remote[call.Name]; ok {
		return true
	}
	return t.base.NeedsApproval(call)
}
func (t *Tools) Execute(ctx context.Context, call domain.ModelToolCall) (string, error) {
	remote, ok := t.remote[call.Name]
	if !ok {
		return t.base.Execute(ctx, call)
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result, err := remote.session.CallTool(bounded, &sdk.CallToolParams{Name: remote.name, Arguments: call.Arguments})
	if err != nil {
		return "", fmt.Errorf("MCP tool %s failed", call.Name)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	if len(raw) > 64<<10 {
		raw = append(raw[:64<<10], []byte("\n[output truncated]")...)
	}
	// Keep isError and structured content visible to the model, not just text.
	return string(raw), nil
}
func (t *Tools) Close() error {
	t.once.Do(func() {
		for _, s := range t.sessions {
			_ = s.Close()
		}
	})
	return nil
}

type headerTransport struct{ env map[string]string }

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	for header, env := range t.env {
		value := os.Getenv(env)
		if value == "" {
			return nil, errors.New("MCP header environment variable is empty")
		}
		clone.Header.Set(header, value)
	}
	return http.DefaultTransport.RoundTrip(clone)
}
