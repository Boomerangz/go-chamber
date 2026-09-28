package codex

import "context"

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
// overrides stick to the thread, so an empty mode keeps the last one.
func (r *Runtime) SetPermissionMode(_ context.Context, mode string) error {
	r.mu.Lock()
	r.mode = mode
	r.mu.Unlock()
	return nil
}

func addPermissionMode(params map[string]any, mode string) {
	if p, ok := permissionPresets[mode]; ok {
		params["approvalPolicy"] = p.approval
		params["sandboxPolicy"] = map[string]any{"type": p.sandbox}
	}
}
