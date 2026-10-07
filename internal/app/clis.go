package app

import "github.com/igorzygin/go-chamber/internal/domain"

// CLIFinder tells whether an agent's CLI is installed, and where.
type CLIFinder interface {
	FindCLI(agent domain.AgentKind) (path string, ok bool)
}

// CLIStatus is one agent CLI's availability, for the new-session form and
// Diagnostics. Hint is how to install a missing one.
type CLIStatus struct {
	Agent domain.AgentKind `json:"agent"`
	Found bool             `json:"found"`
	Path  string           `json:"path,omitempty"`
	Hint  string           `json:"hint,omitempty"`
}

var allAgents = []domain.AgentKind{domain.AgentClaude, domain.AgentCodex}

// CLIs reports each agent's CLI. It looks again on every call, so a CLI
// installed while go-chamber runs is found without a restart.
func (m *Manager) CLIs() []CLIStatus {
	out := make([]CLIStatus, 0, len(allAgents))
	for _, agent := range allAgents {
		if m.cfg.CLIs == nil {
			out = append(out, CLIStatus{Agent: agent, Found: true})
			continue
		}
		path, ok := m.cfg.CLIs.FindCLI(agent)
		s := CLIStatus{Agent: agent, Found: ok, Path: path}
		if !ok {
			s.Hint = domain.InstallHint(agent)
		}
		out = append(out, s)
	}
	return out
}

// checkCLI refuses an agent whose CLI is not installed, in plain words.
func (m *Manager) checkCLI(agent domain.AgentKind) error {
	if m.cfg.CLIs == nil {
		return nil
	}
	if _, ok := m.cfg.CLIs.FindCLI(agent); !ok {
		return domain.CLIMissing(agent)
	}
	return nil
}
