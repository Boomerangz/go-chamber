package app

// TerminalScreen is the server's authoritative terminal display. Calls are
// serialized with PTY output, resize and attachment by the terminal use case.
// Feed returns terminal query replies to write to the PTY exactly once.
// Snapshot must not contain clipboard operations or terminal queries.
type TerminalScreen interface {
	Feed([]byte) []byte
	Resize(cols, rows uint16) []byte
	Snapshot() TerminalScreenSnapshot
	Close()
}

type TerminalScreenSnapshot struct {
	Prompt    bool   `json:"prompt"`
	PromptID  uint64 `json:"promptId"`
	CommandID uint64 `json:"commandId"`
	Data      []byte `json:"data"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Position  uint64 `json:"position"`
}

type TerminalScreenFactory interface {
	New(cols, rows uint16) TerminalScreen
}
