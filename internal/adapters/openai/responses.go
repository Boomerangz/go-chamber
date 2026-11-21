package openai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func readResponses(ctx context.Context, r io.Reader, source string, codex bool, emit func(domain.ModelDelta) error) (domain.ModelResult, error) {
	var result domain.ModelResult
	items := map[int]json.RawMessage{}
	itemBytes := 0
	err := readSSE(ctx, r, func(data []byte) (bool, error) {
		var event struct {
			Type     string          `json:"type"`
			Index    int             `json:"output_index"`
			Item     json.RawMessage `json:"item"`
			Delta    string          `json:"delta"`
			Response struct {
				Status string            `json:"status"`
				Output []json.RawMessage `json:"output"`
				Usage  struct {
					Input   int64 `json:"input_tokens"`
					Output  int64 `json:"output_tokens"`
					Details struct {
						Cached int64 `json:"cached_tokens"`
					} `json:"input_tokens_details"`
				} `json:"usage"`
			} `json:"response"`
		}
		if json.Unmarshal(data, &event) != nil {
			return false, errors.New("invalid Responses event")
		}
		switch event.Type {
		case "response.output_text.delta":
			return false, emit(domain.ModelDelta{Text: event.Delta})
		case "response.reasoning_summary_text.delta":
			return false, emit(domain.ModelDelta{Reasoning: event.Delta})
		case "response.failed", "response.incomplete", "response.cancelled", "error":
			return false, errors.New("model response did not complete: " + event.Type)
		case "response.output_item.done":
			if event.Index < 0 || event.Index >= 256 || len(event.Item) == 0 {
				return false, errors.New("invalid Responses output index or item")
			}
			itemBytes += len(event.Item) - len(items[event.Index])
			if itemBytes > 8<<20 {
				return false, errors.New("responses output exceeds limit")
			}
			items[event.Index] = event.Item
		case "response.completed", "response.done":
			if event.Type == "response.done" {
				if !codex {
					return false, errors.New("unexpected Responses terminal event")
				}
				if event.Response.Status == "" {
					event.Response.Status = "completed"
				}
			}
			if event.Response.Status != "completed" {
				return false, errors.New("model response has non-completed status")
			}
			if event.Response.Output == nil {
				for i := 0; i < len(items); i++ {
					item, ok := items[i]
					if !ok {
						return false, errors.New("missing Responses output item")
					}
					event.Response.Output = append(event.Response.Output, item)
				}
			}
			if event.Response.Output == nil {
				return false, errors.New("missing completed Responses output")
			}
			msg, err := responseMessage(event.Response.Output)
			if err != nil {
				return false, err
			}
			replay, err := json.Marshal(event.Response.Output)
			if err != nil {
				return false, errors.New("invalid Responses output")
			}
			msg.Replay = domain.ModelReplay{Format: "responses-v1", Source: source, Data: replay}
			result = domain.ModelResult{Message: msg, Usage: domain.ModelUsage{Input: event.Response.Usage.Input, Output: event.Response.Usage.Output, CachedInput: event.Response.Usage.Details.Cached}}
			return true, nil
		}
		return false, nil
	})
	return result, err
}

func responseMessage(items []json.RawMessage) (domain.ModelMessage, error) {
	msg := domain.ModelMessage{Role: "assistant"}
	var text, reasoning strings.Builder
	seen := map[string]bool{}
	for _, raw := range items {
		var item struct {
			Type      string `json:"type"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
			Content   []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Refusal string `json:"refusal"`
			} `json:"content"`
			Summary []struct {
				Text string `json:"text"`
			} `json:"summary"`
		}
		if json.Unmarshal(raw, &item) != nil {
			return msg, errors.New("invalid Responses output item")
		}
		switch item.Type {
		case "message":
			for _, part := range item.Content {
				switch part.Type {
				case "output_text":
					text.WriteString(part.Text)
				case "refusal":
					text.WriteString(part.Refusal)
				}
			}
		case "reasoning":
			for _, part := range item.Summary {
				reasoning.WriteString(part.Text)
			}
		case "function_call":
			if item.CallID == "" || item.Name == "" || !objectJSON([]byte(item.Arguments)) || seen[item.CallID] {
				return msg, errors.New("invalid or duplicate Responses tool call")
			}
			seen[item.CallID] = true
			msg.ToolCalls = append(msg.ToolCalls, domain.ModelToolCall{ID: item.CallID, Name: item.Name, Arguments: json.RawMessage(item.Arguments)})
		default:
			return msg, errors.New("unsupported Responses output item")
		}
	}
	msg.Text, msg.Reasoning = text.String(), reasoning.String()
	return msg, nil
}
