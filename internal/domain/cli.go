package domain

import "errors"

// ErrCLIMissing refuses to start an agent whose CLI is not installed: the
// process could never start, and the owner should hear why in plain words
// rather than as an exec error chain.
var ErrCLIMissing = errors.New("agent CLI not found on PATH")

// cliMissing names the agent's CLI and how to install it; errors.Is matches
// ErrCLIMissing.
type cliMissing struct{ agent AgentKind }

func (e cliMissing) Error() string {
	return cliName(e.agent) + " CLI not found on PATH. Install it with " + InstallHint(e.agent)
}

func (e cliMissing) Is(target error) bool { return target == ErrCLIMissing }

// CLIMissing is ErrCLIMissing for agent.
func CLIMissing(agent AgentKind) error { return cliMissing{agent: agent} }

// InstallHint is the command that installs the agent's CLI.
func InstallHint(agent AgentKind) string {
	switch agent {
	case AgentClaude:
		return "npm install -g @anthropic-ai/claude-code"
	case AgentCodex:
		return "npm install -g @openai/codex"
	case AgentOpenCode:
		return "npm install -g opencode-ai"
	}
	return ""
}

func cliName(agent AgentKind) string {
	if agent == AgentOpenCode {
		return "OpenCode"
	}
	if agent == AgentClaude {
		return "Claude Code"
	}
	return "Codex"
}
