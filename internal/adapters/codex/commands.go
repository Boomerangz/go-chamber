package codex

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Commands lists Codex's enabled skills for cwd (skills/list). Codex has no
// agent-side slash commands; a skill is invoked by mentioning $name.
func (f *Factory) Commands(ctx context.Context, agent domain.AgentKind, cwd string) ([]app.Command, error) {
	if agent != domain.AgentCodex {
		return nil, fmt.Errorf("codex: unsupported agent %q", agent)
	}
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return nil, err
	}
	res, err := srv.client.Call(ctx, "skills/list", map[string]any{"cwds": []string{cwd}})
	if err != nil {
		return nil, fmt.Errorf("codex: skills/list: %w", err)
	}
	var out struct {
		Data []struct {
			Skills []struct {
				Name             string `json:"name"`
				Description      string `json:"description"`
				ShortDescription string `json:"shortDescription"`
				Enabled          bool   `json:"enabled"`
			} `json:"skills"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return nil, fmt.Errorf("codex: skills/list response: %w", err)
	}
	list := []app.Command{}
	for _, entry := range out.Data {
		for _, s := range entry.Skills {
			if !s.Enabled {
				continue
			}
			desc := s.ShortDescription
			if desc == "" {
				desc = s.Description
			}
			list = append(list, app.Command{Name: s.Name, Description: desc, Insert: "$" + s.Name})
		}
	}
	return list, nil
}
