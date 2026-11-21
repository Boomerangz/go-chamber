// Package openai implements model inference over OpenAI-compatible HTTP/SSE.
package openai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type Wire string

const (
	ChatCompletions Wire = "chat-completions"
	Responses       Wire = "responses"
	Codex           Wire = "codex-responses"
	OpenRouter      Wire = "openrouter"
)

// CredentialSource resolves or refreshes authorization without exposing it to
// the model context, UI events, or diagnostics.
type CredentialSource interface {
	Credential(context.Context) (StaticCredentials, error)
}

type StaticCredentials struct {
	Token     string
	AccountID string
}

func (s StaticCredentials) Credential(context.Context) (StaticCredentials, error) { return s, nil }

type Client struct {
	// CatalogClientVersion overrides the tested Codex catalog compatibility version.
	CatalogClientVersion string
	BaseURL              string
	Wire                 Wire
	Credentials          CredentialSource
	HTTP                 *http.Client
}

var _ app.ModelClient = (*Client)(nil)

// HTTPError intentionally excludes response bodies: an upstream may echo secrets.
type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("model endpoint returned HTTP %d", e.Status) }

func (c *Client) Stream(ctx context.Context, in domain.ModelRequest, emit func(domain.ModelDelta) error) (domain.ModelResult, error) {
	result, err := c.stream(ctx, in, emit)
	if err != nil {
		return domain.ModelResult{}, err
	}
	return result, nil
}

func (c *Client) stream(ctx context.Context, in domain.ModelRequest, emit func(domain.ModelDelta) error) (domain.ModelResult, error) {
	var zero domain.ModelResult
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	endpoint, err := c.endpoint()
	if err != nil {
		return zero, err
	}
	if in.Model == "" {
		return zero, errors.New("model is required")
	}
	var auth StaticCredentials
	if c.Credentials != nil {
		auth, err = c.Credentials.Credential(ctx)
		if err != nil {
			return zero, err
		}
	}
	if c.Wire == Codex && (auth.Token == "" || auth.AccountID == "") {
		return zero, errors.New("codex subscription login required")
	}
	if c.Wire == OpenRouter && auth.Token == "" {
		return zero, errors.New("openrouter API key required")
	}
	identity := auth.AccountID
	if identity == "" {
		identity = auth.Token
	}
	source := fmt.Sprintf("%x", sha256.Sum256([]byte(string(c.Wire)+"\x00"+endpoint+"\x00"+in.Model+"\x00"+identity)))
	body, err := c.requestBody(in, source)
	if err != nil {
		return zero, err
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return zero, errors.New("invalid model request")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return zero, errors.New("invalid model endpoint")
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream")
	if auth.Token != "" {
		r.Header.Set("Authorization", "Bearer "+auth.Token)
	}
	if c.Wire == Codex {
		r.Header.Set("ChatGPT-Account-ID", auth.AccountID)
		r.Header.Set("OpenAI-Beta", "responses=experimental")
		r.Header.Set("originator", "go-chamber")
	}
	client := http.Client{}
	if c.HTTP != nil {
		client = *c.HTTP
	}
	// Neither OAuth nor inference credentials follow redirects to another endpoint.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return zero, ctx.Err()
		}
		return zero, errors.New("model request transport failed")
	}
	defer resp.Body.Close() //nolint:errcheck // Read-only response body.
	if resp.StatusCode != http.StatusOK {
		return zero, &HTTPError{Status: resp.StatusCode}
	}
	if contentType := resp.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/event-stream") && (c.Wire != Codex || contentType != "") {
		return zero, errors.New("model endpoint did not return SSE")
	}
	if emit == nil {
		emit = func(domain.ModelDelta) error { return nil }
	}
	if c.chat() {
		return readChat(ctx, resp.Body, source, emit)
	}
	return readResponses(ctx, resp.Body, source, c.Wire == Codex, emit)
}

func (c *Client) endpoint() (string, error) {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" && c.Wire == OpenRouter {
		base = "https://openrouter.ai/api/v1"
	}
	if base == "" && c.Wire == Codex {
		base = "https://chatgpt.com/backend-api"
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("invalid model base URL")
	}
	switch c.Wire {
	case Codex:
		if strings.HasSuffix(base, "/codex/responses") {
			return base, nil
		}
		if strings.HasSuffix(base, "/codex") {
			return base + "/responses", nil
		}
		return base + "/codex/responses", nil
	case Responses:
		return base + "/responses", nil
	case ChatCompletions, OpenRouter:
		return base + "/chat/completions", nil
	default:
		return "", errors.New("unsupported model wire protocol")
	}
}

func (c *Client) chat() bool { return c.Wire == ChatCompletions || c.Wire == OpenRouter }
