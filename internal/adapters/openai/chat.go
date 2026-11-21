package openai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sort"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type chatCall struct {
	ID, Name  string
	Arguments strings.Builder
}

func readChat(ctx context.Context, r io.Reader, source string, emit func(domain.ModelDelta) error) (domain.ModelResult, error) {
	var result domain.ModelResult
	var text, reasoning strings.Builder
	calls := map[int]*chatCall{}
	var details []map[string]json.RawMessage
	detailBytes := 0
	finish := ""
	err := readSSE(ctx, r, func(data []byte) (bool, error) {
		if string(data) == "[DONE]" {
			if finish != "stop" && finish != "tool_calls" {
				return false, errors.New("chat stream ended without a successful finish reason")
			}
			return true, nil
		}
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				Index  int    `json:"index"`
				Finish string `json:"finish_reason"`
				Delta  struct {
					Text            string            `json:"content"`
					Reasoning       string            `json:"reasoning_content"`
					RouterReasoning string            `json:"reasoning"`
					Details         []json.RawMessage `json:"reasoning_details"`
					Calls           []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				Input   int64 `json:"prompt_tokens"`
				Output  int64 `json:"completion_tokens"`
				Details struct {
					Cached int64 `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &chunk) != nil {
			return false, errors.New("invalid chat stream event")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return false, errors.New("model returned a chat stream error")
		}
		if chunk.Usage != nil {
			result.Usage = domain.ModelUsage{Input: chunk.Usage.Input, Output: chunk.Usage.Output, CachedInput: chunk.Usage.Details.Cached}
		}
		for _, choice := range chunk.Choices {
			if choice.Index != 0 {
				return false, errors.New("multiple model choices are unsupported")
			}
			if finish != "" {
				// OpenRouter repeats the finished choice in its final usage chunk.
				// A usage trailer may confirm completion but must not add output.
				if chunk.Usage != nil && choice.Finish == finish && choice.Delta.Text == "" && choice.Delta.Reasoning == "" && choice.Delta.RouterReasoning == "" && len(choice.Delta.Details) == 0 && len(choice.Delta.Calls) == 0 {
					continue
				}
				return false, errors.New("chat choice continued after finish")
			}
			if choice.Delta.Reasoning == "" {
				choice.Delta.Reasoning = choice.Delta.RouterReasoning
			}
			for _, raw := range choice.Delta.Details {
				detailBytes += len(raw)
				if detailBytes > maxEventBytes {
					return false, errors.New("reasoning details exceed size limit")
				}
				var detail map[string]json.RawMessage
				if json.Unmarshal(raw, &detail) != nil || detail == nil {
					return false, errors.New("invalid reasoning detail")
				}
				details = appendReasoningDetail(details, detail)
			}
			text.WriteString(choice.Delta.Text)
			reasoning.WriteString(choice.Delta.Reasoning)
			if text.Len()+reasoning.Len() > maxEventBytes {
				return false, errors.New("chat response exceeds size limit")
			}
			if choice.Delta.Text != "" || choice.Delta.Reasoning != "" {
				if err := emit(domain.ModelDelta{Text: choice.Delta.Text, Reasoning: choice.Delta.Reasoning}); err != nil {
					return false, err
				}
			}
			for _, delta := range choice.Delta.Calls {
				if delta.Index < 0 || delta.Index >= 256 {
					return false, errors.New("invalid tool call index")
				}
				call := calls[delta.Index]
				if call == nil {
					call = &chatCall{}
					calls[delta.Index] = call
				}
				if delta.ID != "" {
					if call.ID != "" && call.ID != delta.ID {
						return false, errors.New("tool call identity changed")
					}
					call.ID = delta.ID
				}
				if delta.Function.Name != "" {
					if call.Name != "" && call.Name != delta.Function.Name {
						return false, errors.New("tool name changed")
					}
					call.Name = delta.Function.Name
				}
				call.Arguments.WriteString(delta.Function.Arguments)
				if call.Arguments.Len() > maxEventBytes {
					return false, errors.New("tool arguments exceed size limit")
				}
			}
			if choice.Finish != "" {
				if choice.Finish != "stop" && choice.Finish != "tool_calls" {
					return false, errors.New("chat response did not complete: " + choice.Finish)
				}
				finish = choice.Finish
			}
		}
		return false, nil
	})
	if err != nil {
		return domain.ModelResult{}, err
	}
	if (len(calls) > 0) != (finish == "tool_calls") {
		return domain.ModelResult{}, errors.New("chat finish reason disagrees with tool calls")
	}
	message := domain.ModelMessage{Role: "assistant", Text: text.String(), Reasoning: reasoning.String()}
	indices := make([]int, 0, len(calls))
	for index := range calls {
		indices = append(indices, index)
	}
	sort.Ints(indices)
	seen := map[string]bool{}
	toolJSON := []any{}
	for _, index := range indices {
		call := calls[index]
		if call.ID == "" || call.Name == "" || !objectJSON([]byte(call.Arguments.String())) || seen[call.ID] {
			return domain.ModelResult{}, errors.New("invalid or duplicate chat tool call")
		}
		seen[call.ID] = true
		message.ToolCalls = append(message.ToolCalls, domain.ModelToolCall{ID: call.ID, Name: call.Name, Arguments: json.RawMessage(call.Arguments.String())})
		toolJSON = append(toolJSON, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": call.Arguments.String()}})
	}
	replay := map[string]any{"role": "assistant", "content": message.Text}
	if len(toolJSON) > 0 {
		replay["tool_calls"] = toolJSON
	}
	if len(details) > 0 {
		replay["reasoning_details"] = details
	}
	if message.Reasoning != "" {
		replay["reasoning_content"] = message.Reasoning
	}
	raw, err := json.Marshal([]any{replay})
	if err != nil {
		return domain.ModelResult{}, err
	}
	message.Replay = domain.ModelReplay{Format: "chat-v1", Source: source, Data: raw}
	result.Message = message
	return result, nil
}
