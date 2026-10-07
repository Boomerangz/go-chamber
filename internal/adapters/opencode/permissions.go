package opencode

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Native `always` saves a rule beyond this session, even into the project.
// Keep go-chamber's session grants locally and reply once. They survive
// facade detach/reattach, but never reach another native ID.
type permissionGrant struct {
	id, action string
	patterns   []string
}

func (s *server) remember(native string, p request) {
	patterns := p.Save
	if len(patterns) == 0 {
		patterns = p.Resources
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.grants == nil {
		s.grants = map[string][]permissionGrant{}
	}
	s.grants[native] = append(s.grants[native], permissionGrant{id: p.ID, action: p.Action, patterns: append([]string(nil), patterns...)})
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
	if p.Form || len(p.Resources) == 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, g := range s.grants[native] {
		if g.action != p.Action {
			continue
		}
		all := true
		for _, resource := range p.Resources {
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
	if e.Type != "permission.asked" {
		return request{}, false
	}
	var p request
	if json.Unmarshal(e.Data, &p) != nil || p.ID == "" {
		return request{}, false
	}
	return p, true
}

// formAnswer turns the chosen labels, keyed by question text, into the
// form's typed answer. Unanswered fields are left out.
func formAnswer(p request, answers map[string][]string) map[string]any {
	out := map[string]any{}
	for _, f := range p.Fields {
		picked := answers[f.question()]
		if !f.asks() || len(picked) == 0 {
			continue
		}
		values := make([]string, len(picked))
		for i, label := range picked {
			values[i] = label
			for _, o := range f.choices() {
				if o.Label == label {
					values[i] = o.Value
				}
			}
		}
		switch f.Type {
		case "multiselect":
			out[f.Key] = values
		case "boolean":
			out[f.Key] = values[0] == "true"
		case "number", "integer":
			if n, err := strconv.ParseFloat(values[0], 64); err == nil {
				out[f.Key] = n
			}
		default:
			out[f.Key] = values[0]
		}
	}
	return out
}
