package openai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestOpenRouterProfileAndReasoningReplay(t *testing.T) {
	var requests []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer router-key" || r.Header.Get("ChatGPT-Account-ID") != "" {
			t.Error("incorrect router route or credentials")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests = append(requests, body)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, detail := range []map[string]any{
			{"type": "reasoning.text", "index": 0, "text": "think ", "format": "anthropic-v1"},
			{"type": "reasoning.text", "index": 0, "text": "more", "signature": "signed"},
			{"type": "reasoning.encrypted", "index": 1, "data": "opaque1"},
			{"type": "reasoning.encrypted", "index": 2, "data": "opaque2"},
		} {
			frame(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"reasoning_details": []any{detail}}}}})
		}
		frame(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"reasoning": "visible", "tool_calls": []any{map[string]any{"index": 0, "id": "call", "function": map[string]any{"name": "read", "arguments": "{}"}}}}, "finish_reason": "tool_calls"}}})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	c := &Client{Wire: Wire("openrouter"), BaseURL: srv.URL, Credentials: StaticCredentials{Token: "router-key"}}
	req := domain.ModelRequest{Model: "provider/model", Effort: "high", Messages: []domain.ModelMessage{{Role: "user", Text: "hello"}}}
	result, err := c.Stream(context.Background(), req, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Message.Reasoning != "visible" || len(result.Message.ToolCalls) != 1 {
		t.Fatalf("message=%+v", result.Message)
	}
	req.Messages = append(req.Messages, result.Message, domain.ModelMessage{Role: "tool", CallID: "call", Text: "done"})
	if _, err = c.Stream(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if requests[0]["reasoning"].(map[string]any)["effort"] != "high" || requests[0]["reasoning_effort"] != nil {
		t.Fatal("wrong effort format")
	}
	assistant := requests[1]["messages"].([]any)[1].(map[string]any)
	details := assistant["reasoning_details"].([]any)
	if len(details) != 3 || details[0].(map[string]any)["text"] != "think more" || details[0].(map[string]any)["signature"] != "signed" || details[2].(map[string]any)["data"] != "opaque2" {
		t.Fatalf("lost replay: %#v", details)
	}
	c.Credentials = StaticCredentials{Token: "different-key"}
	if _, err = c.Stream(context.Background(), req, nil); err == nil {
		t.Fatal("replayed reasoning into different credentials")
	}
}

func TestOpenRouterDefaultsAndRequiresOwnKey(t *testing.T) {
	c := &Client{Wire: Wire("openrouter")}
	endpoint, err := c.endpoint()
	if err != nil || endpoint != "https://openrouter.ai/api/v1/chat/completions" {
		t.Fatalf("%s %v", endpoint, err)
	}
	if _, err = c.Stream(context.Background(), domain.ModelRequest{Model: "provider/model"}, nil); err == nil {
		t.Fatal("missing API key accepted")
	}
}

func TestOpenRouterUsageTrailerAfterFinish(t *testing.T) {
	for _, tc := range []struct {
		name, text, finish string
		usage, wantError   bool
	}{
		{"usage trailer", "", "stop", true, false},
		{"late content", "late", "stop", true, true},
		{"changed finish", "", "tool_calls", true, true},
		{"duplicate without usage", "", "stop", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				frame(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "done"}, "finish_reason": "stop"}}})
				trailer := map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": tc.text, "role": "assistant"}, "finish_reason": tc.finish}}}
				if tc.usage {
					trailer["usage"] = map[string]any{"prompt_tokens": 13, "completion_tokens": 7}
				}
				frame(w, trailer)
				_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer srv.Close()
			result, err := (&Client{Wire: OpenRouter, BaseURL: srv.URL, Credentials: StaticCredentials{Token: "key"}}).Stream(context.Background(), domain.ModelRequest{Model: "test"}, nil)
			if tc.wantError {
				if err == nil {
					t.Fatal("accepted continuation after finish")
				}
				return
			}
			if err != nil || result.Message.Text != "done" || result.Usage.Input != 13 || result.Usage.Output != 7 {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}
