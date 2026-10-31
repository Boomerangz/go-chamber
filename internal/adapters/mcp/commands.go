package mcpapi

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type commandIn struct {
	Program        string   `json:"program" jsonschema:"executable name or absolute path; no implicit shell"`
	Args           []string `json:"args,omitempty" jsonschema:"program arguments, not a shell command string"`
	Cwd            string   `json:"cwd" jsonschema:"absolute working directory on the go-chamber host"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty" jsonschema:"1 to 60 seconds; default 15"`
}

func (s *Server) runCommand(ctx context.Context, _ *sdk.CallToolRequest, in commandIn) (*sdk.CallToolResult, app.CommandResult, error) {
	if s.cfg.Commands == nil || !s.cfg.AllowCommands {
		return nil, app.CommandResult{}, errors.New("MCP commands are disabled")
	}
	if in.Program == "" || !filepath.IsAbs(in.Cwd) {
		return nil, app.CommandResult{}, errors.New("program and absolute cwd are required")
	}
	seconds := in.TimeoutSeconds
	if seconds == 0 {
		seconds = 15
	}
	if seconds < 1 || seconds > 60 {
		return nil, app.CommandResult{}, errors.New("timeout_seconds must be between 1 and 60")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	out, err := s.cfg.Commands.Run(ctx, in.Program, in.Args, in.Cwd)
	return nil, out, err
}
