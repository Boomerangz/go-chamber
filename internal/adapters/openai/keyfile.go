package openai

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
)

// KeyFile is explicitly configured by the owner. It accepts a plain API key,
// a dotenv OPENROUTER_API_KEY entry, or OpenCode's auth.json format. No shell
// code or variable substitutions are evaluated and secrets never enter errors.
type KeyFile struct{ Path string }

func (k KeyFile) Credential(ctx context.Context) (StaticCredentials, error) {
	if err := ctx.Err(); err != nil {
		return StaticCredentials{}, err
	}
	raw, err := os.ReadFile(k.Path)
	if err != nil {
		return StaticCredentials{}, errors.New("cannot read OpenRouter key file")
	}
	if len(raw) > 1<<20 {
		return StaticCredentials{}, errors.New("OpenRouter key file exceeds limit")
	}
	text := strings.TrimSpace(string(raw))
	key := ""
	switch {
	case strings.HasPrefix(text, "{"):
		var auth map[string]struct {
			Type string `json:"type"`
			Key  string `json:"key"`
		}
		if json.Unmarshal(raw, &auth) == nil && auth["openrouter"].Type == "api" {
			key = auth["openrouter"].Key
		}
	case strings.Contains(text, "=") || strings.Contains(text, "\n"):
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
			name, value, ok := strings.Cut(line, "=")
			if !ok || strings.TrimSpace(name) != "OPENROUTER_API_KEY" {
				continue
			}
			value = strings.TrimSpace(value)
			switch {
			case strings.HasPrefix(value, `"`):
				value, err = strconv.Unquote(value)
				if err != nil {
					value = ""
				}
			case strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'"):
				value = strings.Trim(value, "'")
			default:
				value, _, _ = strings.Cut(value, " #")
			}
			key = strings.TrimSpace(value)
		}
	default:
		key = text
	}
	if key == "" || strings.ContainsAny(key, " \t\r\n$") {
		return StaticCredentials{}, errors.New("OpenRouter API key not found in configured file")
	}
	return StaticCredentials{Token: key}, nil
}
