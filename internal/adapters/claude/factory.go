package claude

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Factory launches `claude` processes. It is the app.RuntimeFactory for
// Claude Code.
type Factory struct {
	// Binary is the CLI to run; defaults to "claude".
	Binary string
	// Args are extra arguments appended to the standard stream-json flags.
	Args []string
	// Env are extra environment variables (KEY=VALUE).
	Env []string
	// Stderr receives the process stderr; defaults to os.Stderr.
	Stderr io.Writer
}

func defaultArgs() []string {
	return []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		// Without a prompt tool the CLI denies anything that needs a
		// permission (and AskUserQuestion) instead of asking the host.
		"--permission-prompt-tool", "stdio",
		"--forward-subagent-text",
	}
}

func (f *Factory) binary() string {
	if f.Binary != "" {
		return f.Binary
	}
	return "claude"
}

func (f *Factory) stderr() io.Writer {
	if f.Stderr != nil {
		return f.Stderr
	}
	return os.Stderr
}

// argsFor builds the command line. native is the session id the process
// will use: the resumed id, or a fresh one passed with --session-id for new
// sessions and forks.
func (f *Factory) argsFor(req app.StartRequest, native string) []string {
	args := append(defaultArgs(), f.Args...)
	if req.NativeID != "" {
		args = append(args, "--resume", req.NativeID)
	}
	if req.Fork {
		args = append(args, "--fork-session")
	}
	if native != req.NativeID {
		args = append(args, "--session-id", native)
	}
	if req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if req.Effort != "" {
		args = append(args, "--effort", req.Effort)
	}
	if req.PermissionMode != "" {
		args = append(args, "--permission-mode", req.PermissionMode)
	}
	return args
}

// Start implements app.RuntimeFactory.
func (f *Factory) Start(ctx context.Context, req app.StartRequest) (app.AgentRuntime, error) {
	return start(ctx, f, req)
}

// efforts are the --effort levels of `claude` (2.1.x).
var efforts = []string{"low", "medium", "high", "xhigh", "max"}

// Models implements app.ModelCatalog. The CLI has no listing command, so
// these are its documented aliases, each resolving to the latest model of
// the family.
func (f *Factory) Models(_ context.Context, agent domain.AgentKind) ([]app.ModelInfo, error) {
	if agent != domain.AgentClaude {
		return nil, fmt.Errorf("claude: unsupported agent %q", agent)
	}
	return []app.ModelInfo{
		{ID: "fable", Name: "Fable", Description: "Most capable, for the hardest long-running work", Efforts: efforts},
		{ID: "opus", Name: "Opus", Description: "Deep reasoning for complex tasks", Efforts: efforts},
		{ID: "sonnet", Name: "Sonnet", Description: "Fast and capable for everyday coding", Efforts: efforts},
		{ID: "haiku", Name: "Haiku", Description: "Fastest, for quick and simple tasks"},
	}, nil
}

var (
	_ app.RuntimeFactory = (*Factory)(nil)
	_ app.ModelCatalog   = (*Factory)(nil)
)
