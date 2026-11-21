package openai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestToolResultConversationBothProtocols(t *testing.T) {
	for _, wire := range []Wire{ChatCompletions, Responses} {
		t.Run(string(wire), func(t *testing.T) {
			var request map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&request)
				w.Header().Set("Content-Type", "text/event-stream")
				if wire == ChatCompletions {
					frame(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "done", "reasoning_content": "checked"}, "finish_reason": "stop"}}})
					_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
				} else {
					frame(w, map[string]any{"type": "response.reasoning_summary_text.delta", "delta": "checked"})
					frame(w, map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "output": []any{
						map[string]any{"type": "reasoning", "summary": []any{map[string]any{"text": "checked"}}},
						map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "done"}}},
					}}})
				}
			}))
			defer srv.Close()
			c := &Client{BaseURL: srv.URL, Wire: wire}
			in := domain.ModelRequest{Model: "model", SessionID: "session", Instructions: "instructions", Effort: "high", Tools: []domain.ModelTool{{Name: "read", Parameters: json.RawMessage(`{"type":"object"}`)}}, Messages: []domain.ModelMessage{
				{Role: "user", Text: "read a"},
				{Role: "assistant", Text: "reading", ToolCalls: []domain.ModelToolCall{{ID: "call", Name: "read", Arguments: json.RawMessage(`{"path":"a"}`)}}},
				{Role: "tool", CallID: "call", Text: "contents"},
			}}
			var reasoning strings.Builder
			res, err := c.Stream(context.Background(), in, func(d domain.ModelDelta) error { reasoning.WriteString(d.Reasoning); return nil })
			if err != nil || res.Message.Text != "done" || res.Message.Reasoning != "checked" || reasoning.String() != "checked" {
				t.Fatalf("%+v %v", res, err)
			}
			key := "input"
			if wire == ChatCompletions {
				key = "messages"
			}
			messages := request[key].([]any)
			last := messages[len(messages)-1].(map[string]any)
			if wire == ChatCompletions && last["tool_call_id"] != "call" || wire == Responses && last["call_id"] != "call" {
				t.Fatalf("tool result lost identity: %v", last)
			}
			in.Messages = append(in.Messages, res.Message)
			if _, err = c.Stream(context.Background(), in, nil); err != nil {
				t.Fatalf("replay: %v", err)
			}
			in.Model = "other-model"
			if _, err = c.Stream(context.Background(), in, nil); err == nil {
				t.Fatal("replayed provider state into another model")
			}
		})
	}
}

func TestMalformedOrTruncatedStreamsCannotReturnTools(t *testing.T) {
	for _, wire := range []Wire{ChatCompletions, Responses} {
		for name, stream := range map[string]string{
			"invalid-json":   "data: {\n\n",
			"unterminated":   "data: {}",
			"done-only":      "data: [DONE]\n\n",
			"partial":        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"x\",\"function\":{\"name\":\"write\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"length\"}]}\n\n",
			"provider-error": "data: {\"type\":\"error\",\"error\":{\"message\":\"secret\"}}\n\n",
			"bad-status":     "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"failed\"}}\n\n",
		} {
			t.Run(string(wire)+"/"+name, func(t *testing.T) {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprint(w, stream)
				}))
				defer srv.Close()
				res, err := (&Client{BaseURL: srv.URL, Wire: wire}).Stream(context.Background(), domain.ModelRequest{Model: "test"}, nil)
				if err == nil || len(res.Message.ToolCalls) != 0 || strings.Contains(err.Error(), "secret") {
					t.Fatalf("%+v %v", res, err)
				}
			})
		}
	}
}

func TestClientRejectsInvalidInputBeforeNetwork(t *testing.T) {
	for name, in := range map[string]domain.ModelRequest{
		"missing-model":   {},
		"role":            {Model: "m", Messages: []domain.ModelMessage{{Role: "arbitrary"}}},
		"bad-schema":      {Model: "m", Tools: []domain.ModelTool{{Name: "t", Parameters: json.RawMessage("null")}}},
		"missing-call-id": {Model: "m", Messages: []domain.ModelMessage{{Role: "tool", Text: "result"}}},
		"invalid-call":    {Model: "m", Messages: []domain.ModelMessage{{Role: "assistant", ToolCalls: []domain.ModelToolCall{{Name: "t"}}}}},
		"user-call":       {Model: "m", Messages: []domain.ModelMessage{{Role: "user", ToolCalls: []domain.ModelToolCall{{Name: "t"}}}}},
		"foreign-replay":  {Model: "m", Messages: []domain.ModelMessage{{Role: "assistant", Replay: domain.ModelReplay{Data: json.RawMessage(`[]`)}}}},
	} {
		t.Run(name, func(t *testing.T) {
			c := &Client{BaseURL: "http://127.0.0.1:1", Wire: Responses}
			_, err := c.Stream(context.Background(), in, nil)
			if err == nil || strings.Contains(err.Error(), "transport") {
				t.Fatalf("not rejected locally: %v", err)
			}
		})
	}
	for _, c := range []*Client{{Wire: "unknown", BaseURL: "https://example.test"}, {Wire: Codex}, {Wire: Responses, BaseURL: "https://user:password@example.test"}} {
		if _, err := c.Stream(context.Background(), domain.ModelRequest{Model: "m"}, nil); err == nil {
			t.Fatal("accepted invalid configuration")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Client{}).Stream(ctx, domain.ModelRequest{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestSSEFramingAndLimits(t *testing.T) {
	var seen []string
	err := readSSE(context.Background(), strings.NewReader(": heartbeat\r\nid: 1\r\nevent: ignored\r\ndata: {\r\ndata: \"ok\":true}\r\n\r\n"), func(b []byte) (bool, error) { seen = append(seen, string(b)); return true, nil })
	if err != nil || len(seen) != 1 || seen[0] != "{\n\"ok\":true}" {
		t.Fatalf("%q %v", seen, err)
	}
	for _, input := range []string{"data: " + strings.Repeat("x", maxEventBytes) + "\n\n", strings.Repeat("data: "+strings.Repeat("x", 1024)+"\n", 8193) + "\n"} {
		if err = readSSE(context.Background(), strings.NewReader(input), func([]byte) (bool, error) { t.Fatal("oversized event dispatched"); return true, nil }); err == nil {
			t.Fatal("missing size limit")
		}
	}
}

func TestPersistedEmptyReplayDoesNotBecomeProviderContext(t *testing.T) {
	raw, _ := json.Marshal(domain.ModelMessage{Role: "user", Text: "hello"})
	var message domain.ModelMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatal(err)
	}
	for _, wire := range []Wire{Codex, OpenRouter} {
		if _, err := (&Client{Wire: wire}).requestBody(domain.ModelRequest{Messages: []domain.ModelMessage{message}}, "source"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUserImagesUseWireSpecificContentParts(t *testing.T) {
	for _, wire := range []Wire{Codex, OpenRouter} {
		body, err := (&Client{Wire: wire}).requestBody(domain.ModelRequest{Messages: []domain.ModelMessage{{Role: "user", Text: "describe", Images: []domain.ModelImage{{URL: "data:image/png;base64,YQ=="}}}}}, "source")
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(body)
		want := "image_url"
		if wire == Codex {
			want = "input_image"
		}
		if !strings.Contains(string(raw), want) || !strings.Contains(string(raw), "data:image/png;base64,YQ==") {
			t.Fatalf("%s", raw)
		}
	}
}
