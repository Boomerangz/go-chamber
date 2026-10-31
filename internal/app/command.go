package app

import "context"

// CommandResult captures a bounded command response. A nonzero exit is a result,
// not a transport failure.
type CommandResult struct {
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	ExitCode        int    `json:"exit_code"`
	StdoutTruncated bool   `json:"stdout_truncated"`
	StderrTruncated bool   `json:"stderr_truncated"`
}

// CommandRunner executes one program with arguments, without an implicit shell.
type CommandRunner interface {
	Run(context.Context, string, []string, string) (CommandResult, error)
}
