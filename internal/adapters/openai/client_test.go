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

func frame(w http.ResponseWriter, value any) {
	b, _ := json.Marshal(value)
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
}

func TestCodexStreamAndReplay(t *testing.T) {
	var requests []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/codex/responses" || r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("ChatGPT-Account-ID") != "account" {
			t.Errorf("incorrect route or authorization: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		requests = append(requests, body)
		w.Header().Set("Content-Type", "text/event-stream")
		frame(w, map[string]any{"type": "response.output_text.delta", "delta": "hello"})
		frame(w, map[string]any{"type": "response.completed", "response": map[string]any{
			"status": "completed", "output": []any{
				map[string]any{"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque", "summary": []any{}},
				map[string]any{"type": "message", "id": "msg_1", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "hello"}}},
			}, "usage": map[string]any{"input_tokens": 10, "output_tokens": 4, "input_tokens_details": map[string]any{"cached_tokens": 3}},
		}})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Wire: Codex, Credentials: StaticCredentials{Token: "secret", AccountID: "account"}}
	req := domain.ModelRequest{Model: "test-model", Messages: []domain.ModelMessage{{Role: "user", Text: "hi"}}}
	var deltas []string
	res, err := c.Stream(context.Background(), req, func(d domain.ModelDelta) error { deltas = append(deltas, d.Text); return nil })
	if err != nil || strings.Join(deltas, "") != "hello" || res.Message.Text != "hello" || res.Usage.Input != 10 || res.Usage.CachedInput != 3 {
		t.Fatalf("result=%+v deltas=%v err=%v", res, deltas, err)
	}
	if requests[0]["store"] != false || requests[0]["stream"] != true {
		t.Fatal("Codex requests must stream without server storage")
	}
	req.Messages = append(req.Messages, res.Message, domain.ModelMessage{Role: "user", Text: "continue"})
	if _, err = c.Stream(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	input := requests[1]["input"].([]any)
	if len(input) != 4 || input[1].(map[string]any)["encrypted_content"] != "opaque" {
		t.Fatalf("lost reasoning replay: %#v", input)
	}
}

func TestResponsesOnlyReturnsExecutableToolsAfterCompleted(t *testing.T) {
	for _, terminal := range []string{"completed", "incomplete", "failed", "eof", "invalid-arguments"} {
		t.Run(terminal, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				frame(w, map[string]any{"type": "response.function_call_arguments.delta", "delta": "{\"path\":\"a\"}"})
				if terminal == "eof" {
					return
				}
				args := `{"path":"a"}`
				status := terminal
				if terminal == "invalid-arguments" {
					args = "{"
					status = "completed"
				}
				frame(w, map[string]any{"type": "response." + status, "response": map[string]any{"status": status, "output": []any{
					map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read", "arguments": args},
				}}})
			}))
			defer srv.Close()
			c := &Client{BaseURL: srv.URL, Wire: Responses}
			res, err := c.Stream(context.Background(), domain.ModelRequest{Model: "test"}, nil)
			if terminal == "completed" {
				if err != nil || len(res.Message.ToolCalls) != 1 || res.Message.ToolCalls[0].ID != "call_1" {
					t.Fatalf("%+v %v", res, err)
				}
			} else if err == nil || len(res.Message.ToolCalls) != 0 {
				t.Fatalf("unsafe partial tool calls: %+v %v", res, err)
			}
		})
	}
}

func TestChatStreamAssemblesToolArguments(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		for _, call := range []map[string]any{
			{"index": 0, "id": "call_1", "function": map[string]any{"name": "read", "arguments": `{"pa`}},
			{"index": 0, "function": map[string]any{"arguments": `th":"a"}`}},
		} {
			frame(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{call}}}}})
		}
		frame(w, map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"}}})
		frame(w, map[string]any{"choices": []any{}, "usage": map[string]any{"prompt_tokens": 9, "completion_tokens": 2}})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Wire: ChatCompletions}
	res, err := c.Stream(context.Background(), domain.ModelRequest{Model: "test", Instructions: "system", Tools: []domain.ModelTool{{Name: "read", Parameters: json.RawMessage(`{"type":"object"}`)}}}, nil)
	if err != nil || len(res.Message.ToolCalls) != 1 || string(res.Message.ToolCalls[0].Arguments) != `{"path":"a"}` || res.Usage.Input != 9 {
		t.Fatalf("%+v %v", res, err)
	}
	if len(body["tools"].([]any)) != 1 || body["messages"].([]any)[0].(map[string]any)["role"] != "system" {
		t.Fatalf("body %#v", body)
	}
}

func TestStreamCancellationAndConsumerFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		frame(w, map[string]any{"type": "response.output_text.delta", "delta": "x"})
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Wire: Responses}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := c.Stream(ctx, domain.ModelRequest{Model: "test"}, func(domain.ModelDelta) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	want := errors.New("consumer stopped")
	_, err = c.Stream(context.Background(), domain.ModelRequest{Model: "test"}, func(domain.ModelDelta) error { return want })
	if !errors.Is(err, want) {
		t.Fatalf("consumer: %v", err)
	}
}

func TestNoAutomaticRetriesAndNoErrorBodySecrets(t *testing.T) {
	for _, status := range []int{401, 429, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.WriteHeader(status)
				_, _ = fmt.Fprint(w, "secret-token")
			}))
			defer srv.Close()
			_, err := (&Client{BaseURL: srv.URL, Wire: Responses}).Stream(context.Background(), domain.ModelRequest{Model: "test"}, nil)
			if err == nil || calls != 1 || strings.Contains(err.Error(), "secret-token") {
				t.Fatalf("calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestCodexDoneUsesCompletedOutputItems(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		frame(w, map[string]any{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "fc", "call_id": "c", "name": "read", "arguments": "{}"}})
		frame(w, map[string]any{"type": "response.done", "response": map[string]any{"usage": map[string]any{"input_tokens": 5}}})
	}))
	defer srv.Close()
	c := &Client{Wire: Codex, BaseURL: srv.URL, Credentials: StaticCredentials{Token: "t", AccountID: "a"}}
	got, err := c.Stream(context.Background(), domain.ModelRequest{Model: "m"}, nil)
	if err != nil || len(got.Message.ToolCalls) != 1 || got.Usage.Input != 5 {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestResponsesRejectsLostOutputAndPreservesRefusal(t *testing.T) {
	for _, refusal := range []bool{false, true} {
		t.Run(fmt.Sprint(refusal), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				response := map[string]any{"status": "completed"}
				if refusal {
					response["output"] = []any{map[string]any{"type": "message", "content": []any{map[string]any{"type": "refusal", "refusal": "Cannot help."}}}}
				} else {
					frame(w, map[string]any{"type": "response.output_text.delta", "delta": "lost"})
				}
				frame(w, map[string]any{"type": "response.completed", "response": response})
			}))
			defer srv.Close()
			c := &Client{BaseURL: srv.URL, Wire: Responses}
			result, err := c.Stream(context.Background(), domain.ModelRequest{Model: "test"}, nil)
			if refusal {
				if err != nil || result.Message.Text != "Cannot help." {
					t.Fatalf("result=%+v error=%v", result, err)
				}
			} else if err == nil {
				t.Fatal("silently lost streamed output")
			}
		})
	}
}

func TestCodexAcceptsSSEWithoutContentType(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header()["Content-Type"] = nil
		frame(w, map[string]any{"type": "response.completed", "response": map[string]any{"status": "completed", "output": []any{}}})
	}))
	defer srv.Close()
	c := &Client{Wire: Codex, BaseURL: srv.URL, Credentials: StaticCredentials{Token: "token", AccountID: "account"}}
	if _, err := c.Stream(context.Background(), domain.ModelRequest{Model: "test"}, nil); err != nil {
		t.Fatal(err)
	}
}
