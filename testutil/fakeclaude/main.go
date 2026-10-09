// Command fakeclaude emulates the `claude` CLI stream-json protocol for tests
// and e2e runs, so they are deterministic and never spend subscription quota.
//
// Modes (FAKECLAUDE_MODE):
//
//	auto       (default) pick a scenario from the prompt text: "permission" ->
//	           can_use_tool prompt, "ask" -> AskUserQuestion, "bash" -> tool
//	           call, "crash" -> exit mid-turn, "crash while asking" -> exit while
//	           a permission waits, otherwise stream "echo: <prompt>" back
//	echo       always stream "echo: <prompt>" back
//	tool       always run a fake Bash tool call, then answer
//	permission always prompt for Bash permission, then continue
//	question   always ask one AskUserQuestion, then continue
//	die        stream a partial answer and exit mid-turn
//	huge       write a stdout line longer than the host's line limit
//	longstderr write a 1 MiB stderr line, then answer like echo
//	nocontrol  never answer control_requests
//
// set_model to "bad-model" is rejected with an error control_response.
//
// Like the real CLI, permission prompts and AskUserQuestion reach the host as
// can_use_tool control_requests only with --permission-prompt-tool stdio;
// without it they are denied on the spot.
//
// Like the real CLI, system/init is only written after the first user
// message, and the session id comes from --session-id, else --resume.
// FAKECLAUDE_SESSION_ID overrides the default id when neither is given.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type envelope struct {
	Type    string `json:"type"`
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
	Response struct {
		RequestID string `json:"request_id"`
		Response  struct {
			Behavior     string          `json:"behavior"`
			Message      string          `json:"message"`
			UpdatedInput json.RawMessage `json:"updatedInput"`
		} `json:"response"`
	} `json:"response"`
	RequestID string `json:"request_id"`
	Request   struct {
		Subtype  string                     `json:"subtype"`
		TaskID   string                     `json:"task_id"`
		Model    string                     `json:"model"`
		Mode     string                     `json:"mode"`
		Settings map[string]json.RawMessage `json:"settings"`
	} `json:"request"`
}

// pendingTurn marks a turn paused on a control_request we must answer.
type pendingTurn struct {
	requestID string
	toolUseID string
	question  bool
}

func main() {
	sessionID := envOr("FAKECLAUDE_SESSION_ID", "fake-session-1")
	args := os.Args[1:]
	for i, a := range args {
		if a == "--resume" && i+1 < len(args) {
			sessionID = args[i+1]
		}
	}
	for i, a := range args {
		if a == "--session-id" && i+1 < len(args) {
			sessionID = args[i+1]
		}
		if a == "--permission-prompt-tool" && i+1 < len(args) && args[i+1] == "stdio" {
			promptTool = true
		}
		if a == "--include-hook-events" {
			hookEvents = true
		}
		if a == "--model" && i+1 < len(args) {
			model = args[i+1]
		}
		if a == "--effort" && i+1 < len(args) {
			effort = args[i+1]
		}
		if a == "--permission-mode" && i+1 < len(args) {
			permissionMode = args[i+1]
			bypassAvailable = permissionMode == "bypassPermissions"
		}
	}
	mode := envOr("FAKECLAUDE_MODE", "auto")

	out := bufio.NewWriter(os.Stdout)
	defer func() { _ = out.Flush() }()
	enc := json.NewEncoder(out)

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	var pending *pendingTurn
	initSent := false
	for scanner.Scan() {
		var env envelope
		if err := json.Unmarshal(scanner.Bytes(), &env); err != nil {
			continue
		}
		switch env.Type {
		case "control_response":
			if pending != nil && env.Response.RequestID == pending.requestID {
				finishTurn(enc, out, sessionID, pending,
					env.Response.Response.Behavior,
					env.Response.Response.Message,
					env.Response.Response.UpdatedInput)
				pending = nil
				_ = out.Flush()
			}
		case "control_request":
			if mode == "nocontrol" {
				continue
			}
			switch env.Request.Subtype {
			case "interrupt":
				_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{
					"subtype": "success", "request_id": env.RequestID, "response": map[string]any{},
				}})
				// Like the real CLI: a stopped turn ends with its result; a
				// background task outlives it.
				if taskTurnOpen {
					taskTurnOpen = false
					_ = enc.Encode(result(sessionID, ""))
				}
				// Like the real CLI: a turn waiting on a permission or a
				// question withdraws it and ends.
				if pending != nil {
					_ = enc.Encode(map[string]any{"type": "control_cancel_request", "request_id": pending.requestID})
					writeToolResult(enc, sessionID, pending.toolUseID, "[Request interrupted by user for tool use]", true)
					_ = enc.Encode(result(sessionID, ""))
					pending = nil
				}
				_ = out.Flush()
			case "stop_task":
				stopTask(enc, out, sessionID, env.RequestID, env.Request.TaskID)
			case "initialize":
				// Like the real CLI: the slash commands and skills on offer.
				_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{
					"subtype": "success", "request_id": env.RequestID, "response": map[string]any{
						"commands": []map[string]any{
							{"name": "compact", "description": "Clear history but keep a summary", "argumentHint": "<instructions>", "builtin": true},
							{"name": "review-mr", "description": "Review a merge request (user)", "argumentHint": ""},
						},
					},
				}})
				_ = out.Flush()
			case "set_permission_mode":
				// Like the real CLI: bypassPermissions is only allowed in a
				// process started with it.
				if env.Request.Mode == "bypassPermissions" && !bypassAvailable {
					_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{
						"subtype": "error", "request_id": env.RequestID, "error": "bypassPermissions mode is disabled",
					}})
				} else {
					permissionMode = env.Request.Mode
					_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{
						"subtype": "success", "request_id": env.RequestID, "response": map[string]any{},
					}})
				}
				_ = out.Flush()
			case "set_model", "apply_flag_settings":
				// Like the real CLI: set_model switches the live model (no
				// model means the default); apply_flag_settings changes
				// effortLevel (null means the default).
				if env.Request.Subtype == "set_model" && env.Request.Model == "bad-model" {
					_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{
						"subtype": "error", "request_id": env.RequestID, "error": "model not available",
					}})
					_ = out.Flush()
					continue
				}
				if env.Request.Subtype == "set_model" {
					model = env.Request.Model
					effort = "" // a new model starts from its own default
				} else if raw, ok := env.Request.Settings["effortLevel"]; ok {
					effort = ""
					_ = json.Unmarshal(raw, &effort)
				}
				_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{
					"subtype": "success", "request_id": env.RequestID, "response": map[string]any{},
				}})
				_ = out.Flush()
			}
		case "user":
			if !initSent {
				initSent = true
				writeInit(enc, out, sessionID)
			}
			pending = startTurn(mode, enc, out, sessionID, userText(env.Message.Content))
			_ = out.Flush()
		}
	}
}

// startTurn emits a turn; when it pauses on a permission prompt it returns
// the pending request to resume on the next control_response.
// promptTool is set by --permission-prompt-tool stdio.
var promptTool bool

// model and effort come from --model/--effort; set_model changes model.
var model, effort string

// permissionMode comes from --permission-mode; set_permission_mode changes
// it. bypassAvailable is set when the process started in bypassPermissions.
var permissionMode string
var bypassAvailable bool

// hookEvents is set by --include-hook-events.
var hookEvents bool

// askHost sends a can_use_tool control_request, or, without a prompt tool,
// denies it at once as the real CLI does and finishes the turn.
func askHost(enc *json.Encoder, out *bufio.Writer, sessionID string, p *pendingTurn, request map[string]any) *pendingTurn {
	if !promptTool {
		_ = enc.Encode(map[string]any{"type": "system", "subtype": "permission_denied", "session_id": sessionID})
		writeToolResult(enc, sessionID, p.toolUseID, "Claude requested permissions but you haven't granted it yet.", true)
		emitTextTurn(enc, out, sessionID, "permission denied")
		_ = out.Flush()
		return nil
	}
	_ = enc.Encode(map[string]any{"type": "control_request", "request_id": p.requestID, "request": request})
	_ = out.Flush()
	return p
}

func startTurn(mode string, enc *json.Encoder, out *bufio.Writer, sessionID, prompt string) *pendingTurn {
	low := strings.ToLower(prompt)
	switch mode {
	case "die":
		emitPartial(enc, out, sessionID, "echo: "+prompt)
		_ = out.Flush()
		os.Exit(3)
	case "echo":
		emitTextTurn(enc, out, sessionID, "echo: "+prompt)
	case "huge":
		_, _ = out.WriteString(`{"type":"assistant","pad":"` + strings.Repeat("x", 17<<20) + "\"}\n")
		_ = out.Flush()
		select {}
	case "longstderr":
		_, _ = os.Stderr.WriteString(strings.Repeat("e", 1<<20) + "\n")
		emitTextTurn(enc, out, sessionID, "echo: "+prompt)
	case "tool":
		emitToolTurn(enc, out, sessionID, prompt)
	case "permission":
		return emitPermission(enc, out, sessionID, prompt)
	case "question":
		return emitQuestion(enc, out, sessionID, prompt)
	case "task":
		emitTaskTurn(enc, out, sessionID, prompt)
	default: // auto
		switch {
		case strings.Contains(low, "crash while asking"):
			// The process dies while a permission waits for the owner.
			emitPermission(enc, out, sessionID, prompt)
			_ = out.Flush()
			time.Sleep(200 * time.Millisecond)
			os.Exit(3)
		case strings.Contains(low, "permission"):
			return emitPermission(enc, out, sessionID, prompt)
		case strings.Contains(low, "ask"):
			return emitQuestion(enc, out, sessionID, prompt)
		case strings.Contains(low, "subagent"):
			emitTaskTurn(enc, out, sessionID, prompt)
		case strings.Contains(low, "bash"):
			emitToolTurn(enc, out, sessionID, prompt)
		case strings.Contains(low, "crash"):
			emitPartial(enc, out, sessionID, "echo: "+prompt)
			_ = out.Flush()
			os.Exit(3)
		case strings.Contains(low, "hook"):
			emitHookTurn(enc, out, sessionID)
		case strings.Contains(low, "current mode"):
			emitTextTurn(enc, out, sessionID, "mode: "+permissionMode)
		case strings.Contains(low, "make a plan"):
			return emitPlanApproval(enc, out, sessionID)
		case strings.Contains(low, "which model"):
			emitTextTurn(enc, out, sessionID, "model: "+model+" effort: "+effort)
		case strings.Contains(low, "edit some files"):
			emitEditTurn(enc, out, sessionID)
		case strings.Contains(low, "fail this turn"):
			emitText(enc, out, sessionID, "trying")
			_ = enc.Encode(map[string]any{
				"type": "result", "subtype": "error_during_execution", "is_error": true,
				"session_id": sessionID, "result": "API Error: overloaded",
				"usage": map[string]any{"input_tokens": 7, "output_tokens": 3},
			})
		default:
			emitTextTurn(enc, out, sessionID, "echo: "+prompt)
		}
	}
	return nil
}

func emitPermission(enc *json.Encoder, out *bufio.Writer, sessionID, prompt string) *pendingTurn {
	msgID := "msg_" + strconv.Itoa(nextSeq())
	toolUseID := "toolu_perm_" + strconv.Itoa(nextSeq())
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "p-" + msgID,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": msgID, "role": "assistant", "content": []any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "p-" + msgID + "-start",
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": toolUseID, "name": "Bash", "input": map[string]any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "assistant", "session_id": sessionID, "uuid": "p-" + msgID + "-msg",
		"parent_tool_use_id": nil,
		"message": map[string]any{"id": msgID, "role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": toolUseID, "name": "Bash", "input": map[string]any{"command": prompt}},
		}},
	})
	requestID := "perm_" + strconv.Itoa(nextSeq())
	return askHost(enc, out, sessionID, &pendingTurn{requestID: requestID, toolUseID: toolUseID},
		map[string]any{
			"subtype":   "can_use_tool",
			"tool_name": "Bash",
			"input":     map[string]any{"command": prompt},
			"permission_suggestions": []any{map[string]any{
				"type": "addRules", "behavior": "allow", "destination": "session",
				"rules": []any{map[string]any{"toolName": "Bash"}},
			}},
			"tool_use_id": toolUseID,
			"description": "Claude wants to run: " + prompt,
			"title":       "Run command",
		})
}

// emitPlanApproval asks to leave plan mode with a plan, as ExitPlanMode does.
func emitPlanApproval(enc *json.Encoder, out *bufio.Writer, sessionID string) *pendingTurn {
	toolUseID := "toolu_plan_" + strconv.Itoa(nextSeq())
	input := map[string]any{"plan": "## Plan\n\n1. Read the code\n2. **Fix** the bug"}
	_ = enc.Encode(map[string]any{
		"type": "assistant", "session_id": sessionID, "uuid": "plan-" + toolUseID,
		"parent_tool_use_id": nil,
		"message": map[string]any{"id": "msg_" + toolUseID, "role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": toolUseID, "name": "ExitPlanMode", "input": input},
		}},
	})
	return askHost(enc, out, sessionID, &pendingTurn{requestID: "perm_" + strconv.Itoa(nextSeq()), toolUseID: toolUseID},
		map[string]any{
			"subtype": "can_use_tool", "tool_name": "ExitPlanMode", "input": input,
			"tool_use_id": toolUseID, "title": "Ready to code?",
		})
}

func emitQuestion(enc *json.Encoder, out *bufio.Writer, sessionID, prompt string) *pendingTurn {
	msgID := "msg_" + strconv.Itoa(nextSeq())
	toolUseID := "toolu_q_" + strconv.Itoa(nextSeq())
	questions := []any{map[string]any{
		"question":    "Which option should we use?",
		"header":      "Choice",
		"multiSelect": false,
		"options": []any{
			map[string]any{"label": "Alpha", "description": "first option"},
			map[string]any{"label": "Beta", "description": "second option"},
		},
	}}
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "q-" + msgID,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": msgID, "role": "assistant", "content": []any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "assistant", "session_id": sessionID, "uuid": "q-" + msgID + "-msg",
		"parent_tool_use_id": nil,
		"message": map[string]any{"id": msgID, "role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": toolUseID, "name": "AskUserQuestion", "input": map[string]any{"questions": questions}},
		}},
	})
	requestID := "ask_" + strconv.Itoa(nextSeq())
	return askHost(enc, out, sessionID, &pendingTurn{requestID: requestID, toolUseID: toolUseID, question: true},
		map[string]any{
			"subtype":     "can_use_tool",
			"tool_name":   "AskUserQuestion",
			"input":       map[string]any{"questions": questions},
			"tool_use_id": toolUseID,
			"description": "Claude has a question",
			"title":       "Question",
		})
}

// taskTurnOpen is set while a subagent turn runs.
var taskTurnOpen bool

// emitTaskTurn starts a subagent task (in the background unless the prompt
// says "foreground") and leaves the turn running until the host stops the
// task or the turn.
func emitTaskTurn(enc *json.Encoder, out *bufio.Writer, sessionID, prompt string) {
	taskTurnOpen = true
	started := map[string]any{
		"type": "system", "subtype": "task_started", "session_id": sessionID,
		"task_id": "task-1", "description": "work: " + prompt,
		"subagent_type": "general-purpose", "task_type": "local_agent",
	}
	if !strings.Contains(strings.ToLower(prompt), "foreground") {
		started["is_backgrounded"] = true
	}
	msgID := "msg_" + strconv.Itoa(nextSeq())
	toolUseID := "toolu_task_" + strconv.Itoa(nextSeq())
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "k-" + msgID,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": msgID, "role": "assistant", "content": []any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "k-" + msgID + "-start",
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": toolUseID, "name": "Task", "input": map[string]any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "assistant", "session_id": sessionID, "uuid": "k-" + msgID + "-msg",
		"parent_tool_use_id": nil,
		"message": map[string]any{"id": msgID, "role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": toolUseID, "name": "Task", "input": map[string]any{"description": "work: " + prompt}},
		}},
	})
	started["tool_use_id"] = toolUseID
	_ = enc.Encode(started)
	_ = out.Flush()
}

// stopTask answers a stop_task control request and ends the background task.
func stopTask(enc *json.Encoder, out *bufio.Writer, sessionID, requestID, taskID string) {
	taskTurnOpen = false
	if taskID == "" {
		taskID = "task-1"
	}
	_ = enc.Encode(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype": "success", "request_id": requestID, "response": map[string]any{},
		},
	})
	_ = enc.Encode(map[string]any{
		"type": "system", "subtype": "task_notification", "session_id": sessionID,
		"task_id": taskID, "status": "stopped", "summary": "stopped by user",
	})
	_ = enc.Encode(result(sessionID, "stopped"))
	_ = out.Flush()
}

// finishTurn continues after a control_response: it records the tool_result
// and answers.
func finishTurn(enc *json.Encoder, out *bufio.Writer, sessionID string, p *pendingTurn, behavior, message string, updatedInput json.RawMessage) {
	if p.question {
		answers := ""
		var ui struct {
			Answers map[string]any `json:"answers"`
		}
		if err := json.Unmarshal(updatedInput, &ui); err == nil {
			if b, err := json.Marshal(ui.Answers); err == nil {
				answers = string(b)
			}
		}
		writeToolResult(enc, sessionID, p.toolUseID, "answered: "+answers, false)
		emitTextTurn(enc, out, sessionID, "answered: "+answers)
		return
	}
	allowed := behavior == "allow"
	text := "approved: run " + p.requestID
	if !allowed {
		reason := message
		if reason == "" {
			reason = "denied"
		}
		text = "denied: " + reason
	}
	writeToolResult(enc, sessionID, p.toolUseID, text, !allowed)
	emitTextTurn(enc, out, sessionID, text)
}

func writeToolResult(enc *json.Encoder, sessionID, toolUseID, content string, isError bool) {
	_ = enc.Encode(map[string]any{
		"type": "user", "session_id": sessionID, "uuid": "tr-" + toolUseID,
		"parent_tool_use_id": nil,
		"message": map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "tool_result", "tool_use_id": toolUseID, "content": content, "is_error": isError},
		}},
	})
}

func emitTextTurn(enc *json.Encoder, out *bufio.Writer, sessionID, text string) {
	emitText(enc, out, sessionID, text)
	_ = enc.Encode(result(sessionID, text))
}

// emitHookTurn runs a silent UserPromptSubmit hook and answers, then a Stop
// hook blocks and feeds back a reason, as the real CLI does with a user Stop
// hook; the agent answers again.
func emitHookTurn(enc *json.Encoder, out *bufio.Writer, sessionID string) {
	if hookEvents {
		_ = enc.Encode(map[string]any{"type": "system", "subtype": "hook_started", "hook_id": "hook-0",
			"hook_name": "UserPromptSubmit", "hook_event": "UserPromptSubmit", "session_id": sessionID})
		_ = enc.Encode(map[string]any{"type": "system", "subtype": "hook_response", "hook_id": "hook-0",
			"hook_name": "UserPromptSubmit", "hook_event": "UserPromptSubmit", "output": "", "stdout": "", "stderr": "",
			"exit_code": 0, "outcome": "success", "session_id": sessionID})
	}
	emitText(enc, out, sessionID, "first answer")
	reason := "Check your work first."
	if hookEvents {
		_ = enc.Encode(map[string]any{"type": "system", "subtype": "hook_started", "hook_id": "hook-1",
			"hook_name": "Stop", "hook_event": "Stop", "session_id": sessionID})
		block := `{"decision": "block", "reason": "` + reason + `"}` + "\n"
		_ = enc.Encode(map[string]any{"type": "system", "subtype": "hook_response", "hook_id": "hook-1",
			"hook_name": "Stop", "hook_event": "Stop", "output": block, "stdout": block, "stderr": "",
			"exit_code": 0, "outcome": "success", "session_id": sessionID})
	}
	_ = enc.Encode(map[string]any{"type": "user", "session_id": sessionID, "isSynthetic": true,
		"message": map[string]any{"role": "user", "content": []any{
			map[string]any{"type": "text", "text": "Stop hook feedback:\n" + reason},
		}}})
	emitTextTurn(enc, out, sessionID, "checked after hook")
}

func emitText(enc *json.Encoder, out *bufio.Writer, sessionID, text string) {
	msgID := "msg_" + strconv.Itoa(nextSeq())
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "u-" + msgID,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": msgID, "role": "assistant", "content": []any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "u-" + msgID + "-start",
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}},
	})
	for _, chunk := range chunk(text, 3) {
		_ = enc.Encode(map[string]any{
			"type": "stream_event", "session_id": sessionID, "uuid": "u-" + msgID + "-d",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": chunk}},
		})
		_ = out.Flush()
	}
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "u-" + msgID + "-stop",
		"event": map[string]any{"type": "content_block_stop", "index": 0},
	})
	_ = enc.Encode(map[string]any{
		"type": "assistant", "session_id": sessionID, "uuid": "u-" + msgID + "-msg",
		"parent_tool_use_id": nil,
		"message": map[string]any{"id": msgID, "role": "assistant", "content": []any{
			map[string]any{"type": "text", "text": text},
		}},
	})
}

func emitToolTurn(enc *json.Encoder, out *bufio.Writer, sessionID, prompt string) {
	msgID := "msg_" + strconv.Itoa(nextSeq())
	toolUseID := "toolu_fake_" + strconv.Itoa(nextSeq())
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "t-" + msgID,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": msgID, "role": "assistant", "content": []any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "t-" + msgID + "-start",
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": toolUseID, "name": "Bash", "input": map[string]any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "assistant", "session_id": sessionID, "uuid": "t-" + msgID + "-msg",
		"parent_tool_use_id": nil,
		"message": map[string]any{"id": msgID, "role": "assistant", "content": []any{
			map[string]any{"type": "tool_use", "id": toolUseID, "name": "Bash", "input": map[string]any{"command": "echo " + prompt}},
		}},
	})
	_ = out.Flush()
	writeToolResult(enc, sessionID, toolUseID, "ran: "+prompt, false)
	emitTextTurn(enc, out, sessionID, "done: "+prompt)
}

// emitEditTurn reads three files, edits one of them and answers, as a turn
// that changes code does.
func emitEditTurn(enc *json.Encoder, out *bufio.Writer, sessionID string) {
	tool := func(name string, input map[string]any, result string) {
		msgID := "msg_" + strconv.Itoa(nextSeq())
		toolUseID := "toolu_edit_" + strconv.Itoa(nextSeq())
		_ = enc.Encode(map[string]any{
			"type": "assistant", "session_id": sessionID, "uuid": "e-" + msgID,
			"parent_tool_use_id": nil,
			"message": map[string]any{"id": msgID, "role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": toolUseID, "name": name, "input": input},
			}},
		})
		writeToolResult(enc, sessionID, toolUseID, result, false)
		_ = out.Flush()
	}
	for _, path := range []string{"/src/a.go", "/src/b.go", "/src/c.go"} {
		tool("Read", map[string]any{"file_path": path}, "package src")
	}
	tool("Edit", map[string]any{"file_path": "/src/a.go", "old_string": "x := 1\ny := 2", "new_string": "x := 1\ny := 3\nz := 4"}, "edited")
	emitTextTurn(enc, out, sessionID, "edited a.go")
}

func emitPartial(enc *json.Encoder, out *bufio.Writer, sessionID, text string) {
	msgID := "msg_" + strconv.Itoa(nextSeq())
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "p-" + msgID,
		"event": map[string]any{"type": "message_start", "message": map[string]any{"id": msgID, "role": "assistant", "content": []any{}}},
	})
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "p-" + msgID + "-start",
		"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}},
	})
	_ = enc.Encode(map[string]any{
		"type": "stream_event", "session_id": sessionID, "uuid": "p-" + msgID + "-d",
		"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}},
	})
	_ = out.Flush()
}

func result(sessionID, text string) map[string]any {
	return map[string]any{
		"type": "result", "subtype": "success", "is_error": false,
		"session_id": sessionID, "result": text,
		"duration_ms": 1, "num_turns": 1, "total_cost_usd": 0.0,
		"usage": map[string]any{"input_tokens": len(text), "output_tokens": len(text)},
	}
}

func userText(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []struct {
		Type   string `json:"type"`
		Text   string `json:"text"`
		Source struct {
			Type      string `json:"type"`
			MediaType string `json:"media_type"`
			Data      string `json:"data"`
		} `json:"source"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		var b strings.Builder
		for _, blk := range blocks {
			switch blk.Type {
			case "text":
				b.WriteString(blk.Text)
			case "image":
				// Echo what arrived so tests can check the encoding.
				data, _ := base64.StdEncoding.DecodeString(blk.Source.Data)
				fmt.Fprintf(&b, "[image %s %d bytes] ", blk.Source.MediaType, len(data))
			}
		}
		return b.String()
	}
	return ""
}

func chunk(s string, n int) []string {
	if s == "" {
		return []string{""}
	}
	var out []string
	for len(s) > n {
		out = append(out, s[:n])
		s = s[n:]
	}
	return append(out, s)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return wd
}

var seq int

func nextSeq() int {
	seq++
	return seq
}

// writeInit reports the session, as the real CLI does on the first message.
func writeInit(enc *json.Encoder, out *bufio.Writer, sessionID string) {
	_ = enc.Encode(map[string]any{
		"type":       "system",
		"subtype":    "init",
		"session_id": sessionID,
		"cwd":        mustGetwd(),
		"model":      "fake-model",
		"tools":      []string{"Bash", "Edit", "Read", "AskUserQuestion"},
	})
	_ = enc.Encode(map[string]any{
		"type": "rate_limit_event", "session_id": sessionID,
		"rate_limit_info": map[string]any{
			"status": "allowed", "resetsAt": 1790000000, "rateLimitType": "five_hour", "utilization": 0.3,
		},
	})
	_ = out.Flush()
}
