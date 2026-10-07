package opencode

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Native `always` can remember a rule beyond this session (v2 even saves it
// in the project). Keep go-chamber's session grants locally and reply once.
// They survive facade detach/reattach, but never reach another native ID.
type permissionGrant struct {
	id, permission string
	patterns       []string
}

func (s *server) remember(native string, p request) {
	patterns := p.Always
	if len(patterns) == 0 {
		patterns = p.Patterns
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.grants == nil {
		s.grants = map[string][]permissionGrant{}
	}
	s.grants[native] = append(s.grants[native], permissionGrant{id: p.ID, permission: p.Permission, patterns: append([]string(nil), patterns...)})
}
func (s *server) forget(native, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	grants := s.grants[native]
	out := grants[:0]
	for _, g := range grants {
		if g.id != id {
			out = append(out, g)
		}
	}
	s.grants[native] = out
}
func (s *server) allowed(native string, p request) bool {
	if len(p.Questions) > 0 || len(p.Patterns) == 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, g := range s.grants[native] {
		if g.permission != p.Permission {
			continue
		}
		all := true
		for _, resource := range p.Patterns {
			matched := false
			for _, pattern := range g.patterns {
				if wildcard(pattern, resource) {
					matched = true
					break
				}
			}
			if !matched {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}
func wildcard(pattern, value string) bool {
	quoted := regexp.QuoteMeta(pattern)
	quoted = strings.ReplaceAll(quoted, `\*`, ".*")
	quoted = strings.ReplaceAll(quoted, `\?`, ".")
	ok, _ := regexp.MatchString("^"+quoted+"$", value)
	return ok
}
func asked(e event) (request, bool) {
	switch e.Type {
	case "permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked":
	default:
		return request{}, false
	}
	var p request
	if json.Unmarshal(e.Properties, &p) != nil || p.ID == "" {
		return request{}, false
	}
	p.V2 = strings.Contains(e.Type, ".v2.")
	if p.V2 && len(p.Questions) == 0 {
		p.Permission, p.Patterns, p.Always = p.Action, p.Resources, p.Save
	}
	return p, true
}
