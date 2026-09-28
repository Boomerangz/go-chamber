package claude

import (
	"context"

	"github.com/igorzygin/go-chamber/internal/app"
)

// SetPermissionMode switches the live session with set_permission_mode.
// bypassPermissions needs a process started with it, so that switch asks
// for a restart.
func (r *Runtime) SetPermissionMode(_ context.Context, mode string) error {
	r.modelMu.Lock()
	defer r.modelMu.Unlock()
	if mode == "bypassPermissions" && !r.bypass {
		return app.ErrRestartRequired
	}
	// ponytail: the CLI can't be told "back to the user's configured mode"
	// live, so empty means "default"; a restart would pick up the config.
	if mode == "" {
		mode = "default"
	}
	return r.controlRequest(map[string]any{"subtype": "set_permission_mode", "mode": mode})
}
