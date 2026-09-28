package domain

import (
	"errors"
	"fmt"
	"slices"
)

var ErrInvalidPermissionMode = errors.New("invalid permission mode")

// permissionModes lists the approval behaviours each agent accepts. Claude
// takes its own --permission-mode names; Codex takes presets of approval
// policy and sandbox, as its /approvals command offers them. Empty defers
// to the agent's configuration.
var permissionModes = map[AgentKind][]string{
	AgentClaude: {"default", "acceptEdits", "plan", "bypassPermissions"},
	AgentCodex:  {"read-only", "auto", "full-access"},
}

func (s *Session) PermissionMode() string { return s.mode }

// SetPermissionMode chooses how the agent asks before acting from now on.
func (s *Session) SetPermissionMode(mode string) error {
	if mode != "" && !slices.Contains(permissionModes[s.agent], mode) {
		return fmt.Errorf("%w: %q for %s", ErrInvalidPermissionMode, mode, s.agent)
	}
	s.mode = mode
	return nil
}
