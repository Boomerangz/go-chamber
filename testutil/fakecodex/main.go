// Command fakecodex emulates `codex app-server` (JSON-RPC 2.0 over stdio) for
// tests and e2e runs, so scenarios are deterministic and never spend
// subscription quota. It is installed as a binary named `codex` on PATH.
//
// Modes (FAKECODEX_MODE):
//
//	auto       (default) echo the prompt, or prompt for approval / ask a
//	           question when the prompt mentions "permission" / "ask"
//	echo       always stream "echo: <prompt>"
//	permission always request command approval, then continue
//	question   always ask one requestUserInput question, then continue
//
// Like the real server, approvalsReviewer (thread/start, thread/resume,
// turn/start; it sticks to the thread) set to "auto_review" settles approval
// requests without asking the client.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"strconv"
	"strings"
)

type msg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	Result  json.RawMessage `json:"result"`
}

var seq int

// reviewers holds the approval reviewer per thread.
var reviewers = map[string]string{}

func setReviewer(threadID string, params json.RawMessage) {
	var p struct {
		ApprovalsReviewer *string `json:"approvalsReviewer"`
	}
	if json.Unmarshal(params, &p) == nil && p.ApprovalsReviewer != nil {
		reviewers[threadID] = *p.ApprovalsReviewer
	}
}

var out *bufio.Writer
var enc *json.Encoder

func main() {
	out = bufio.NewWriter(os.Stdout)
	defer func() { _ = out.Flush() }()
	enc = json.NewEncoder(out)

	mode := envOr("FAKECODEX_MODE", "auto")
	pending := map[string]func(result json.RawMessage){}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var m msg
		if err := json.Unmarshal(scanner.Bytes(), &m); err != nil {
			continue
		}
		if m.Method == "" {
			if fn := pending[idKey(m.ID)]; fn != nil {
				delete(pending, idKey(m.ID))
				fn(m.Result)
			}
			continue
		}
		switch m.Method {
		case "initialize":
			respond(m.ID, map[string]any{"userAgent": "fakecodex", "codexHome": "/tmp", "platformFamily": "unix"})
		case "initialized":
			// notification, no reply
		case "thread/start":
			var p struct {
				Cwd   string `json:"cwd"`
				Model string `json:"model"`
			}
			_ = json.Unmarshal(m.Params, &p)
			threadID := nextID("thread")
			setReviewer(threadID, m.Params)
			respond(m.ID, map[string]any{"thread": map[string]any{
				"id": threadID, "cwd": p.Cwd, "model": p.Model, "turns": []any{},
			}})
		case "thread/resume":
			var p struct {
				ThreadID string `json:"threadId"`
			}
			_ = json.Unmarshal(m.Params, &p)
			setReviewer(p.ThreadID, m.Params)
			respond(m.ID, map[string]any{"thread": map[string]any{
				"id": p.ThreadID, "turns": []any{},
			}})
		case "turn/start":
			var p struct {
				ThreadID string `json:"threadId"`
				Input    []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"input"`
			}
			_ = json.Unmarshal(m.Params, &p)
			setReviewer(p.ThreadID, m.Params)
			text := ""
			for _, in := range p.Input {
				if in.Type == "text" {
					text += in.Text
				}
			}
			turnID := nextID("turn")
			respond(m.ID, map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}})
			startTurn(mode, p.ThreadID, turnID, text, pending)
		case "account/rateLimits/read":
			respond(m.ID, map[string]any{"rateLimits": map[string]any{
				"primary":   map[string]any{"usedPercent": 25, "resetsAt": 1790000000, "windowDurationMins": 300},
				"secondary": map[string]any{"usedPercent": 5, "windowDurationMins": 10080},
				"planType":  "plus",
			}})
		case "account/read":
			if envOr("FAKECODEX_LOGGED_IN", "") != "" {
				respond(m.ID, map[string]any{"account": map[string]any{"type": "chatgpt", "email": "dev@example.com", "planType": "plus"}})
			} else {
				respond(m.ID, map[string]any{"account": nil, "requiresOpenaiAuth": true})
			}
		case "account/login/start":
			respond(m.ID, map[string]any{"type": "chatgptDeviceCode", "loginId": "login-1", "userCode": "ABCD-EFGH", "verificationUrl": "https://example.com/device"})
		case "turn/steer":
			respond(m.ID, map[string]any{})
		case "turn/interrupt":
			respond(m.ID, map[string]any{})
		default:
			respond(m.ID, map[string]any{})
		}
	}
	_ = out.Flush()
}

func startTurn(mode, threadID, turnID, text string, pending map[string]func(json.RawMessage)) {
	low := strings.ToLower(text)
	switch mode {
	case "permission":
		permissionTurn(threadID, turnID, text, pending)
	case "question":
		questionTurn(threadID, turnID, pending)
	case "collab":
		collabTurn(threadID, turnID, text)
	default: // auto
		switch {
		case strings.Contains(low, "permission"):
			permissionTurn(threadID, turnID, text, pending)
		case strings.Contains(low, "ask"):
			questionTurn(threadID, turnID, pending)
		case strings.Contains(low, "collab"):
			collabTurn(threadID, turnID, text)
		default:
			echoTurn(threadID, turnID, text)
		}
	}
}

func echoTurn(threadID, turnID, text string) {
	turnStarted(threadID, turnID)
	itemID := nextID("msg")
	notify("item/started", map[string]any{"threadId": threadID, "turnId": turnID,
		"item": map[string]any{"type": "agentMessage", "id": itemID, "text": ""}})
	for _, chunk := range chunks("echo: "+text, 3) {
		notify("item/agentMessage/delta", map[string]any{"threadId": threadID, "turnId": turnID, "itemId": itemID, "delta": chunk})
	}
	answer := "echo: " + text
	notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
		"item": map[string]any{"type": "agentMessage", "id": itemID, "text": answer}})
	notify("thread/tokenUsage/updated", map[string]any{"threadId": threadID, "turnId": turnID,
		"tokenUsage": map[string]any{"total": map[string]any{"inputTokens": len(text), "outputTokens": len(answer), "totalTokens": len(text) + len(answer)}}})
	turnCompleted(threadID, turnID, "completed", itemID, answer)
}

func permissionTurn(threadID, turnID, text string, pending map[string]func(json.RawMessage)) {
	turnStarted(threadID, turnID)
	itemID := nextID("cmd")
	notify("item/started", map[string]any{"threadId": threadID, "turnId": turnID,
		"item": map[string]any{"type": "commandExecution", "id": itemID, "command": text, "status": "inProgress"}})
	reqID := nextID("appr")
	pending[reqID] = func(result json.RawMessage) {
		var r struct {
			Decision string `json:"decision"`
		}
		_ = json.Unmarshal(result, &r)
		allowed := r.Decision == "accept" || r.Decision == "acceptForSession"
		status, exit, answer := "failed", 1, "denied"
		if allowed {
			status, exit, answer = "completed", 0, "approved: "+text
		}
		notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"type": "commandExecution", "id": itemID, "command": text,
				"aggregatedOutput": answer, "exitCode": exit, "status": status}})
		notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"type": "agentMessage", "id": "agent-final", "text": answer}})
		turnCompleted(threadID, turnID, "completed", "agent-final", answer)
	}
	if reviewers[threadID] == "auto_review" {
		delete(pending, reqID)
		notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"type": "commandExecution", "id": itemID, "command": text,
				"aggregatedOutput": "auto-approved: " + text, "exitCode": 0, "status": "completed"}})
		notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"type": "agentMessage", "id": "agent-final", "text": "auto-approved: " + text}})
		turnCompleted(threadID, turnID, "completed", "agent-final", "auto-approved: "+text)
		return
	}
	serverRequest(reqID, "item/commandExecution/requestApproval", map[string]any{
		"threadId": threadID, "turnId": turnID, "itemId": itemID, "command": text, "reason": "destructive",
	})
}

func questionTurn(threadID, turnID string, pending map[string]func(json.RawMessage)) {
	turnStarted(threadID, turnID)
	reqID := nextID("ask")
	pending[reqID] = func(result json.RawMessage) {
		var r struct {
			Answers map[string]struct {
				Answers []string `json:"answers"`
			} `json:"answers"`
		}
		_ = json.Unmarshal(result, &r)
		answer := "answered"
		for id, a := range r.Answers {
			answer = "answered " + id + ": " + strings.Join(a.Answers, ",")
		}
		notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"type": "agentMessage", "id": "agent-final", "text": answer}})
		turnCompleted(threadID, turnID, "completed", "agent-final", answer)
	}
	serverRequest(reqID, "item/tool/requestUserInput", map[string]any{
		"threadId": threadID, "turnId": turnID, "itemId": nextID("q"), "isBlocking": true,
		"questions": []any{map[string]any{
			"id": "q1", "header": "Choice", "question": "Which option should we use?",
			"options": []any{
				map[string]any{"label": "Alpha", "description": "first"},
				map[string]any{"label": "Beta", "description": "second"},
			},
		}},
	})
}

// collabTurn spawns a child thread (collab agent) and streams its activity.
func collabTurn(threadID, turnID, text string) {
	turnStarted(threadID, turnID)
	itemID := nextID("collab")
	childThread := "child-" + itemID
	childTurn := nextID("turn")
	notify("item/started", map[string]any{"threadId": threadID, "turnId": turnID,
		"item": map[string]any{"type": "collabAgentToolCall", "id": itemID, "prompt": "child task",
			"receiverThreadIds": []string{childThread}, "senderThreadId": threadID, "status": "inProgress"}})
	notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
		"item": map[string]any{"type": "collabAgentToolCall", "id": itemID, "prompt": "child task",
			"receiverThreadIds": []string{childThread}, "senderThreadId": threadID, "status": "completed"}})
	notify("item/started", map[string]any{"threadId": childThread, "turnId": childTurn,
		"item": map[string]any{"type": "agentMessage", "id": "child-msg", "text": ""}})
	notify("item/agentMessage/delta", map[string]any{"threadId": childThread, "turnId": childTurn,
		"itemId": "child-msg", "delta": "child working"})
	notify("item/completed", map[string]any{"threadId": childThread, "turnId": childTurn,
		"item": map[string]any{"type": "agentMessage", "id": "child-msg", "text": "child working"}})
	turnCompleted(threadID, turnID, "completed", nextID("final"), "collab started")
}

func turnStarted(threadID, turnID string) {
	notify("turn/started", map[string]any{"threadId": threadID,
		"turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}})
}

func turnCompleted(threadID, turnID, status, itemID, text string) {
	notify("turn/completed", map[string]any{"threadId": threadID,
		"turn": map[string]any{"id": turnID, "status": status, "items": []any{
			map[string]any{"type": "agentMessage", "id": itemID, "text": text},
		}}})
}

func notify(method string, params any) {
	_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	_ = out.Flush()
}

func serverRequest(id string, method string, params any) {
	_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	_ = out.Flush()
}

func respond(id json.RawMessage, result any) {
	_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	_ = out.Flush()
}

func nextID(prefix string) string {
	seq++
	return prefix + "-" + strconv.Itoa(seq)
}

func idKey(id json.RawMessage) string {
	var s string
	if json.Unmarshal(id, &s) == nil {
		return s
	}
	return string(id)
}

func chunks(s string, n int) []string {
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
