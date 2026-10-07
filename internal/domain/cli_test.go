package domain

import (
	"errors"
	"testing"
)

func TestCLIMissingNamesTheCLIAndHowToInstallIt(t *testing.T) {
	cases := map[AgentKind]string{
		AgentCodex:  "Codex CLI not found on PATH. Install it with npm install -g @openai/codex",
		AgentClaude: "Claude Code CLI not found on PATH. Install it with npm install -g @anthropic-ai/claude-code",
	}
	for agent, want := range cases {
		err := CLIMissing(agent)
		if !errors.Is(err, ErrCLIMissing) {
			t.Fatalf("%s: not ErrCLIMissing: %v", agent, err)
		}
		if got := err.Error(); got != want {
			t.Fatalf("%s: message = %q", agent, got)
		}
		if errors.Is(err, ErrFolderGone) {
			t.Fatal("a missing CLI is not a missing folder")
		}
	}
}

func TestInstallHint(t *testing.T) {
	if got := InstallHint(AgentCodex); got != "npm install -g @openai/codex" {
		t.Fatalf("codex hint = %q", got)
	}
	if got := InstallHint(AgentClaude); got != "npm install -g @anthropic-ai/claude-code" {
		t.Fatalf("claude hint = %q", got)
	}
	if got := InstallHint("other"); got != "" {
		t.Fatalf("unknown agent hint = %q", got)
	}
}
