package codex

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

type permissionDefaultsResult struct {
	approval, sandbox json.RawMessage
	err               error
}

func resolveDefaultsAsync(r *Runtime, ctx context.Context) <-chan permissionDefaultsResult {
	done := make(chan permissionDefaultsResult, 1)
	go func() {
		approval, sandbox, err := r.configuredPermissions(ctx)
		done <- permissionDefaultsResult{approval, sandbox, err}
	}()
	return done
}

func TestConfiguredPermissionsPreservesPolicyAndCachesDefaults(t *testing.T) {
	client, peer := newPair(t, nil)
	rt := &Runtime{server: &Server{client: client}, cwd: "/project"}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := resolveDefaultsAsync(rt, ctx)
	request := peer.read()
	var params struct {
		Cwd       string `json:"cwd"`
		Ephemeral bool   `json:"ephemeral"`
	}
	if err := json.Unmarshal(request.Params, &params); err != nil || request.Method != "thread/start" || params.Cwd != "/project" || !params.Ephemeral {
		t.Fatalf("configuration request: %+v %v", request, err)
	}
	approval := json.RawMessage(`{"granular":{"sandbox_approval":true,"rules":false}}`)
	sandbox := json.RawMessage(`{"type":"workspaceWrite","networkAccess":true,"writableRoots":["/extra"],"excludeSlashTmp":true}`)
	response, err := json.Marshal(map[string]any{"thread": map[string]any{"id": "temporary"}, "approvalPolicy": approval, "sandbox": sandbox})
	if err != nil {
		t.Fatal(err)
	}
	peer.send(rpcMessage{JSONRPC: "2.0", ID: request.ID, Result: response})
	// Read without a fatal assertion in the goroutine: a missing unsubscribe
	// must fail promptly rather than hang the protocol test.
	released := make(chan rpcMessage, 1)
	go func() {
		line, err := peer.r.ReadBytes('\n')
		if err != nil {
			return
		}
		var message rpcMessage
		if json.Unmarshal(line, &message) == nil {
			released <- message
		}
	}()
	select {
	case request = <-released:
		if request.Method != "thread/unsubscribe" || string(request.Params) != `{"threadId":"temporary"}` {
			t.Fatalf("release: %+v", request)
		}
		peer.send(rpcMessage{JSONRPC: "2.0", ID: request.ID, Result: json.RawMessage(`{"status":"unsubscribed"}`)})
	case result := <-done:
		t.Fatalf("returned before releasing temporary thread: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	result := <-done
	if result.err != nil || string(result.approval) != string(approval) || string(result.sandbox) != string(sandbox) {
		t.Fatalf("defaults: %+v", result)
	}
	// Once resolved, no network round trip is required even with a cancelled
	// context. Both the granular approval and custom sandbox remain intact.
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	cachedApproval, cachedSandbox, err := rt.configuredPermissions(cancelled)
	if err != nil || string(cachedApproval) != string(approval) || string(cachedSandbox) != string(sandbox) {
		t.Fatalf("cached defaults: %s %s %v", cachedApproval, cachedSandbox, err)
	}
	if err := rt.SetPermissionMode(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := rt.configuredPermissions(cancelled); err == nil {
		t.Fatal("selecting configuration did not request fresh defaults")
	}
}

func TestConfiguredPermissionsRejectsIncompleteDefaults(t *testing.T) {
	for _, response := range []string{
		`{"sandbox":{"type":"readOnly"}}`,
		`{"approvalPolicy":null,"sandbox":{"type":"readOnly"}}`,
		`{"approvalPolicy":"on-request"}`,
		`{"approvalPolicy":"on-request","sandbox":null}`,
		`[]`,
	} {
		t.Run(response, func(t *testing.T) {
			client, peer := newPair(t, nil)
			rt := &Runtime{server: &Server{client: client}}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			done := resolveDefaultsAsync(rt, ctx)
			request := peer.read()
			peer.send(rpcMessage{JSONRPC: "2.0", ID: request.ID, Result: json.RawMessage(response)})
			if result := <-done; result.err == nil {
				t.Fatalf("accepted incomplete defaults: %+v", result)
			}
		})
	}
}
