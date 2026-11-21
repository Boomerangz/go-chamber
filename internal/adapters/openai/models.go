package openai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
)

// This is a tested protocol compatibility version, not a model list or a
// dependency on an installed CLI. Codex filters models by this query value.
const defaultCatalogClientVersion = "0.160.1"

var _ app.InferenceModelCatalog = (*Client)(nil)

func (c *Client) ListModels(ctx context.Context) ([]app.ModelInfo, error) {
	endpoint, err := c.endpoint()
	if err != nil {
		return nil, err
	}
	if c.chat() {
		endpoint = strings.TrimSuffix(endpoint, "/chat/completions")
	} else {
		endpoint = strings.TrimSuffix(endpoint, "/responses")
	}
	endpoint += "/models"
	if c.Wire == Codex {
		version := c.CatalogClientVersion
		if version == "" {
			version = defaultCatalogClientVersion
		}
		endpoint += "?" + url.Values{"client_version": {version}}.Encode()
	}
	var auth StaticCredentials
	if c.Credentials != nil {
		auth, err = c.Credentials.Credential(ctx)
		if err != nil {
			return nil, err
		}
	}
	if c.Wire == Codex && (auth.Token == "" || auth.AccountID == "") {
		return nil, errors.New("codex subscription login required")
	}
	if c.Wire == OpenRouter && auth.Token == "" {
		return nil, errors.New("openrouter API key required")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errors.New("invalid catalog endpoint")
	}
	req.Header.Set("Accept", "application/json")
	if auth.Token != "" {
		req.Header.Set("Authorization", "Bearer "+auth.Token)
	}
	if c.Wire == Codex {
		req.Header.Set("ChatGPT-Account-ID", auth.AccountID)
		req.Header.Set("originator", "go-chamber")
	}
	client := http.Client{Timeout: 30 * time.Second}
	if c.HTTP != nil {
		client = *c.HTTP
		if client.Timeout == 0 {
			client.Timeout = 30 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("model catalog transport failed")
	}
	defer response.Body.Close() //nolint:errcheck // Read-only response body.
	if response.StatusCode != http.StatusOK {
		return nil, &HTTPError{Status: response.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxEventBytes+1))
	if err != nil || len(raw) > maxEventBytes {
		return nil, errors.New("invalid model catalog body")
	}
	return decodeModels(raw, c.Wire)
}

type catalogModel struct {
	ContextWindow   int      `json:"context_window"`
	ContextLength   int      `json:"context_length"`
	ID              string   `json:"id"`
	Slug            string   `json:"slug"`
	Name            string   `json:"name"`
	DisplayName     string   `json:"display_name"`
	Description     string   `json:"description"`
	Visibility      string   `json:"visibility"`
	InputModalities []string `json:"input_modalities"`
	DefaultEffort   string   `json:"default_reasoning_level"`
	Efforts         []struct {
		Effort string `json:"effort"`
	} `json:"supported_reasoning_levels"`
	Architecture struct {
		InputModalities []string `json:"input_modalities"`
	} `json:"architecture"`
}

func decodeModels(raw []byte, wire Wire) ([]app.ModelInfo, error) {
	var envelope struct {
		Models []catalogModel `json:"models"`
		Data   []catalogModel `json:"data"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return nil, errors.New("invalid model catalog JSON")
	}
	models := envelope.Data
	if wire == Codex {
		models = envelope.Models
	}
	if models == nil {
		return nil, errors.New("model catalog missing list")
	}
	result := make([]app.ModelInfo, 0, len(models))
	seen := map[string]bool{}
	for _, m := range models {
		id, name, modalities := m.ID, m.Name, m.Architecture.InputModalities
		provider := "openai-compatible"
		if wire == OpenRouter {
			provider, _, _ = strings.Cut(id, "/")
		}
		if wire == Codex {
			if m.Visibility != "list" {
				continue
			}
			id, name, modalities, provider = m.Slug, m.DisplayName, m.InputModalities, "openai"
		}
		if id == "" || seen[id] {
			return nil, errors.New("invalid or duplicate model ID")
		}
		seen[id] = true
		if name == "" {
			name = id
		}
		info := app.ModelInfo{ID: id, Name: name, Description: m.Description, Provider: provider, DefaultEffort: m.DefaultEffort}
		info.ContextWindow = m.ContextLength
		if wire == Codex {
			info.ContextWindow = m.ContextWindow
		}
		for _, effort := range m.Efforts {
			if effort.Effort != "" {
				info.Efforts = append(info.Efforts, effort.Effort)
			}
		}
		if modalities != nil {
			images := false
			for _, modality := range modalities {
				if modality == "image" {
					images = true
				}
			}
			info.Images = &images
		}
		result = append(result, info)
	}
	return result, nil
}
