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

// AcceptsPermissionMode reports whether the agent takes mode; every agent
// takes the empty one.
func AcceptsPermissionMode(agent AgentKind, mode string) bool {
	return mode == "" || slices.Contains(permissionModes[agent], mode)
}

// UnboundedPermissionMode reports whether mode lets the agent act with no
// check at all: no question, no sandbox.
func UnboundedPermissionMode(mode string) bool {
	return mode == "bypassPermissions" || mode == "full-access"
}

func (s *Session) PermissionMode() string { return s.mode }

// SetPermissionMode chooses how the agent asks before acting from now on.
func (s *Session) SetPermissionMode(mode string) error {
	if !AcceptsPermissionMode(s.agent, mode) {
		return fmt.Errorf("%w: %q for %s", ErrInvalidPermissionMode, mode, s.agent)
	}
	s.mode = mode
	return nil
}
