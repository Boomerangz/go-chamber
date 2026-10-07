package fsys

import (
	"os/exec"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// PathCLIs finds agent CLIs on PATH, as the agent adapters will run them.
// Binaries overrides an agent's command name; the default is the agent's
// own name ("claude", "codex").
type PathCLIs struct {
	Binaries map[domain.AgentKind]string
}

// FindCLI looks the agent's CLI up on PATH each time it is asked.
func (c PathCLIs) FindCLI(agent domain.AgentKind) (string, bool) {
	name := c.Binaries[agent]
	if name == "" {
		name = string(agent)
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return "", false
	}
	return path, true
}
