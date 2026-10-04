package codex

import (
	"context"
	"encoding/json"
	"fmt"
)

// permissionPresets maps the session's permission mode to Codex's approval
// policy and sandbox, as its /approvals presets do.
var permissionPresets = map[string]struct {
	approval string
	sandbox  string
}{
	"read-only":   {"on-request", "readOnly"},
	"auto":        {"on-request", "workspaceWrite"},
	"full-access": {"never", "dangerFullAccess"},
}

// SetPermissionMode switches the preset from the next turn on; turn/start
// overrides stick to the thread; empty restores the effective CLI configuration.
func (r *Runtime) SetPermissionMode(_ context.Context, mode string) error {
	r.mu.Lock()
	r.mode = mode
	if mode == "" {
		r.configuredApproval, r.configuredSandbox = nil, nil
	}
	r.mu.Unlock()
	return nil
}

func addPermissionMode(params map[string]any, mode string) {
	if p, ok := permissionPresets[mode]; ok {
		params["approvalPolicy"] = p.approval
		params["sandboxPolicy"] = map[string]any{"type": p.sandbox}
	}
}

// configuredPermissions resolves defaults in a fresh ephemeral thread: resuming
// the active thread would return its sticky overrides instead of configuration.
func (r *Runtime) configuredPermissions(ctx context.Context) (json.RawMessage, json.RawMessage, error) {
	r.mu.Lock()
	approval, sandbox := r.configuredApproval, r.configuredSandbox
	r.mu.Unlock()
	if approval != nil && sandbox != nil {
		return approval, sandbox, nil
	}

	res, err := r.current().client.Call(ctx, "thread/start", map[string]any{"cwd": r.cwd, "ephemeral": true})
	if err != nil {
		return nil, nil, fmt.Errorf("codex: resolve permissions: %w", err)
	}
	var out struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		Approval json.RawMessage `json:"approvalPolicy"`
		Sandbox  json.RawMessage `json:"sandbox"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, nil, err
	}
	if out.Thread.ID != "" {
		if _, err := r.current().client.Call(ctx, "thread/unsubscribe", map[string]any{"threadId": out.Thread.ID}); err != nil {
			return nil, nil, fmt.Errorf("codex: release configuration thread: %w", err)
		}
	}
	if len(out.Approval) == 0 || string(out.Approval) == "null" || len(out.Sandbox) == 0 || string(out.Sandbox) == "null" {
		return nil, nil, fmt.Errorf("codex: missing configured permissions")
	}
	r.mu.Lock()
	r.configuredApproval, r.configuredSandbox = out.Approval, out.Sandbox
	r.mu.Unlock()
	return out.Approval, out.Sandbox, nil
}
