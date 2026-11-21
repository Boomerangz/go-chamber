package openai

import (
	"encoding/json"
	"errors"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func objectJSON(raw json.RawMessage) bool {
	var obj map[string]json.RawMessage
	return json.Unmarshal(raw, &obj) == nil && obj != nil
}

func (c *Client) requestBody(in domain.ModelRequest, source string) (map[string]any, error) {
	chat := c.chat()
	format := "responses-v1"
	if chat {
		format = "chat-v1"
	}
	messages := []any{}
	if in.Instructions != "" {
		role := "developer"
		if chat {
			role = "system"
		}
		messages = append(messages, map[string]any{"role": role, "content": in.Instructions})
	}
	for _, m := range in.Messages {
		if len(m.Replay.Data) > 0 && string(m.Replay.Data) != "null" {
			if m.Role != "assistant" || m.Replay.Source != source || m.Replay.Format != format {
				return nil, errors.New("model replay belongs to a different endpoint, model or account")
			}
			var replay []json.RawMessage
			if json.Unmarshal(m.Replay.Data, &replay) != nil || len(replay) == 0 {
				return nil, errors.New("invalid model replay")
			}
			for _, item := range replay {
				messages = append(messages, item)
			}
			continue
		}
		switch m.Role {
		case "user", "assistant":
			entry := map[string]any{"role": m.Role, "content": m.Text}
			if len(m.Images) > 0 {
				if m.Role != "user" {
					return nil, errors.New("images require user role")
				}
				parts := []any{}
				if chat {
					parts = append(parts, map[string]any{"type": "text", "text": m.Text})
				} else {
					parts = append(parts, map[string]any{"type": "input_text", "text": m.Text})
				}
				for _, im := range m.Images {
					if chat {
						parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": im.URL}})
					} else {
						parts = append(parts, map[string]any{"type": "input_image", "image_url": im.URL})
					}
				}
				entry["content"] = parts
			}
			if len(m.ToolCalls) > 0 {
				if m.Role != "assistant" {
					return nil, errors.New("only assistant messages may call tools")
				}
				calls := []any{}
				for _, call := range m.ToolCalls {
					if call.ID == "" || call.Name == "" || !objectJSON(call.Arguments) {
						return nil, errors.New("invalid tool call")
					}
					if chat {
						calls = append(calls, map[string]any{"id": call.ID, "type": "function", "function": map[string]any{"name": call.Name, "arguments": string(call.Arguments)}})
					} else {
						calls = append(calls, map[string]any{"type": "function_call", "call_id": call.ID, "name": call.Name, "arguments": string(call.Arguments)})
					}
				}
				if chat {
					entry["tool_calls"] = calls
				} else {
					if m.Text != "" {
						messages = append(messages, entry)
					}
					messages = append(messages, calls...)
					continue
				}
			}
			messages = append(messages, entry)
		case "tool":
			if m.CallID == "" {
				return nil, errors.New("tool result requires call ID")
			}
			if chat {
				messages = append(messages, map[string]any{"role": "tool", "tool_call_id": m.CallID, "content": m.Text})
			} else {
				messages = append(messages, map[string]any{"type": "function_call_output", "call_id": m.CallID, "output": m.Text})
			}
		default:
			return nil, errors.New("invalid model message role")
		}
	}
	body := map[string]any{"model": in.Model, "stream": true}
	if chat {
		body["messages"] = messages
		body["stream_options"] = map[string]bool{"include_usage": true}
		if in.Effort != "" {
			if c.Wire == OpenRouter {
				body["reasoning"] = map[string]string{"effort": in.Effort}
			} else {
				body["reasoning_effort"] = in.Effort
			}
		}
	} else {
		body["input"] = messages
		body["store"] = false
		body["include"] = []string{"reasoning.encrypted_content"}
		if in.SessionID != "" {
			body["prompt_cache_key"] = string(in.SessionID)
		}
		if in.Effort != "" {
			body["reasoning"] = map[string]string{"effort": in.Effort}
		}
	}
	if len(in.Tools) > 0 {
		tools := []any{}
		for _, tool := range in.Tools {
			if tool.Name == "" || !objectJSON(tool.Parameters) {
				return nil, errors.New("invalid tool definition")
			}
			f := map[string]any{"name": tool.Name, "description": tool.Description, "parameters": tool.Parameters}
			if chat {
				tools = append(tools, map[string]any{"type": "function", "function": f})
			} else {
				f["type"] = "function"
				tools = append(tools, f)
			}
		}
		body["tools"] = tools
	}
	return body, nil
}
