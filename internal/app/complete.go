package app

import (
	"context"
	"errors"
	"path"
	"sort"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ErrCommandsUnsupported is returned by a catalog for agents without commands.
var ErrCommandsUnsupported = errors.New("agent command listing is not supported")

const maxFileMatches = 50

// Command is one slash command (or skill) the agent offers in the composer.
// Insert is the text that invokes it, e.g. "/review" or "$skill".
type Command struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
	Insert       string `json:"insert"`
}

// FileMatch is a path relative to the session folder; directories end in "/".
type FileMatch struct {
	Path string `json:"path"`
	Dir  bool   `json:"dir,omitempty"`
}

// CommandCatalog lists the commands an agent offers in a folder.
type CommandCatalog interface {
	Commands(ctx context.Context, agent domain.AgentKind, cwd string) ([]Command, error)
}

// FileLister lists the files under root as slash-separated relative paths.
type FileLister interface {
	ListFiles(ctx context.Context, root string) ([]string, error)
}

type CompleterConfig struct {
	Sessions SessionLookup
	Files    FileLister
	Commands CommandCatalog
}

// Completer suggests @file mentions and /commands for a session's composer.
type Completer struct {
	cfg CompleterConfig
}

func NewCompleter(cfg CompleterConfig) *Completer { return &Completer{cfg: cfg} }

// Files fuzzy-matches query against the files and folders of the session's
// working directory.
func (c *Completer) Files(ctx context.Context, id domain.SessionID, query string) ([]FileMatch, error) {
	s, err := c.cfg.Sessions.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	files, err := c.cfg.Files.ListFiles(ctx, s.Cwd)
	if err != nil {
		return nil, err
	}
	return matchFiles(files, query), nil
}

// Commands lists the session agent's commands; an agent without any gives
// an empty list.
func (c *Completer) Commands(ctx context.Context, id domain.SessionID) ([]Command, error) {
	s, err := c.cfg.Sessions.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	cmds, err := c.cfg.Commands.Commands(ctx, s.Agent, s.Cwd)
	if errors.Is(err, ErrCommandsUnsupported) || (err == nil && cmds == nil) {
		return []Command{}, nil
	}
	return cmds, err
}

type fileCandidate struct {
	FileMatch
	tier, depth int
}

// matchFiles ranks basename prefix, basename, path substring and path
// subsequence matches in that order, shallow and short paths first.
func matchFiles(files []string, query string) []FileMatch {
	q := strings.ToLower(query)
	seen := map[string]bool{}
	var out []fileCandidate
	add := func(p string, dir bool) {
		if seen[p] {
			return
		}
		seen[p] = true
		trimmed := strings.TrimSuffix(p, "/")
		if tier, ok := matchTier(strings.ToLower(trimmed), strings.ToLower(path.Base(trimmed)), q); ok {
			out = append(out, fileCandidate{FileMatch{Path: p, Dir: dir}, tier, strings.Count(trimmed, "/")})
		}
	}
	for _, f := range files {
		for i := strings.IndexByte(f, '/'); i >= 0; i = next(f, i) {
			add(f[:i+1], true)
		}
		add(f, false)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		switch {
		case a.tier != b.tier:
			return a.tier < b.tier
		case a.depth != b.depth:
			return a.depth < b.depth
		case len(a.Path) != len(b.Path):
			return len(a.Path) < len(b.Path)
		}
		return a.Path < b.Path
	})
	matches := make([]FileMatch, 0, min(len(out), maxFileMatches))
	for _, c := range out[:min(len(out), maxFileMatches)] {
		matches = append(matches, c.FileMatch)
	}
	return matches
}

func next(s string, i int) int {
	j := strings.IndexByte(s[i+1:], '/')
	if j < 0 {
		return -1
	}
	return i + 1 + j
}

func matchTier(p, base, q string) (int, bool) {
	switch {
	case strings.HasPrefix(base, q):
		return 0, true
	case strings.Contains(base, q):
		return 1, true
	case strings.Contains(p, q):
		return 2, true
	case isSubsequence(p, q):
		return 3, true
	}
	return 0, false
}

func isSubsequence(s, sub string) bool {
	for _, r := range s {
		if sub == "" {
			return true
		}
		if strings.HasPrefix(sub, string(r)) {
			sub = sub[len(string(r)):]
		}
	}
	return sub == ""
}
