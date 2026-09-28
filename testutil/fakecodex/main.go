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
//	exit-after-turn  echo the prompt, then exit right after turn/completed
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

// policies holds the approval policy and sandbox type per thread; like the
// real server, turn/start overrides stick to the thread. Policy "never"
// runs commands without asking.
var policies = map[string][2]string{}

func setPolicy(threadID string, params json.RawMessage) {
	var p struct {
		ApprovalPolicy *string `json:"approvalPolicy"`
		SandboxPolicy  *struct {
			Type string `json:"type"`
		} `json:"sandboxPolicy"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	cur := policies[threadID]
	if p.ApprovalPolicy != nil {
		cur[0] = *p.ApprovalPolicy
	}
	if p.SandboxPolicy != nil {
		cur[1] = p.SandboxPolicy.Type
	}
	policies[threadID] = cur
}

// models holds the model and effort per thread; like the real server,
// turn/start overrides apply to that turn and the following ones.
var models = map[string][2]string{}

func setModel(threadID string, params json.RawMessage) {
	var p struct {
		Model  *string `json:"model"`
		Effort *string `json:"effort"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	cur := models[threadID]
	if p.Model != nil {
		cur[0] = *p.Model
	}
	if p.Effort != nil {
		cur[1] = *p.Effort
	}
	models[threadID] = cur
}

func effort(name string, efforts ...string) map[string]any {
	opts := []map[string]any{}
	for _, e := range efforts {
		opts = append(opts, map[string]any{"reasoningEffort": e, "description": e + " effort"})
	}
	return map[string]any{
		"id": name, "model": name, "displayName": strings.ToUpper(name[:1]) + name[1:],
		"description": "fake model " + name, "hidden": false, "isDefault": name == "fake-large",
		"defaultReasoningEffort": "medium", "supportedReasoningEfforts": opts,
	}
}

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
			setModel(threadID, m.Params)
			respond(m.ID, map[string]any{"thread": map[string]any{
				"id": threadID, "cwd": p.Cwd, "model": p.Model, "turns": []any{},
			}})
		case "thread/resume":
			var p struct {
				ThreadID string `json:"threadId"`
			}
			_ = json.Unmarshal(m.Params, &p)
			setReviewer(p.ThreadID, m.Params)
			setModel(p.ThreadID, m.Params)
			respond(m.ID, map[string]any{"thread": map[string]any{
				"id": p.ThreadID, "turns": []any{},
			}})
		case "thread/fork":
			threadID := nextID("thread")
			setReviewer(threadID, m.Params)
			setModel(threadID, m.Params)
			respond(m.ID, map[string]any{"thread": map[string]any{
				"id": threadID, "turns": []any{},
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
			setModel(p.ThreadID, m.Params)
			setPolicy(p.ThreadID, m.Params)
			text := ""
			for _, in := range p.Input {
				if in.Type == "text" {
					text += in.Text
				}
			}
			turnID := nextID("turn")
			respond(m.ID, map[string]any{"turn": map[string]any{"id": turnID, "status": "inProgress", "items": []any{}}})
			startTurn(mode, p.ThreadID, turnID, text, pending)
		case "skills/list":
			var p struct {
				Cwds []string `json:"cwds"`
			}
			_ = json.Unmarshal(m.Params, &p)
			cwd := ""
			if len(p.Cwds) > 0 {
				cwd = p.Cwds[0]
			}
			respond(m.ID, map[string]any{"data": []any{map[string]any{"cwd": cwd, "errors": []any{}, "skills": []any{
				map[string]any{"name": "pdf", "description": "Long PDF description", "shortDescription": "Read and write PDFs",
					"enabled": true, "path": "/skills/pdf/SKILL.md", "scope": "user"},
				map[string]any{"name": "off", "description": "Disabled", "enabled": false, "path": "/skills/off/SKILL.md", "scope": "user"},
				map[string]any{"name": "review", "description": "Review the working tree", "enabled": true,
					"path": cwd + "/.codex/skills/review/SKILL.md", "scope": "repo"},
			}}}})
		case "model/list":
			respond(m.ID, map[string]any{"data": []any{
				effort("fake-large", "low", "medium", "high"),
				effort("fake-small", "low", "medium"),
			}, "nextCursor": nil})
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
	case "exit-after-turn":
		echoTurn(threadID, turnID, text)
		_ = out.Flush()
		os.Exit(0)
	default: // auto
		switch {
		case strings.Contains(low, "permission"):
			permissionTurn(threadID, turnID, text, pending)
		case strings.Contains(low, "ask"):
			questionTurn(threadID, turnID, pending)
		case strings.Contains(low, "collab"):
			collabTurn(threadID, turnID, text)
		case strings.Contains(low, "hook"):
			hookTurn(threadID, turnID)
		case strings.Contains(low, "current mode"):
			pol := policies[threadID]
			replyTurn(threadID, turnID, text, "mode: "+pol[0]+" "+pol[1])
		case strings.Contains(low, "which model"):
			m := models[threadID]
			replyTurn(threadID, turnID, text, "model: "+m[0]+" effort: "+m[1])
		default:
			echoTurn(threadID, turnID, text)
		}
	}
}

// hookTurn answers, then a user Stop hook blocks with feedback (as with a
// real ~/.codex/hooks.json) and the agent answers again.
func hookTurn(threadID, turnID string) {
	turnStarted(threadID, turnID)
	message := func(text string) string {
		id := nextID("msg")
		notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID,
			"item": map[string]any{"type": "agentMessage", "id": id, "text": text}})
		return id
	}
	message("first answer")
	run := func(status string, entries []any) map[string]any {
		return map[string]any{"threadId": threadID, "turnId": turnID, "run": map[string]any{
			"id": "stop:0:/fake/hooks.json", "eventName": "stop", "handlerType": "command", "executionMode": "sync",
			"scope": "turn", "sourcePath": "/fake/hooks.json", "source": "user", "displayOrder": 0,
			"status": status, "statusMessage": "Fake Reflection", "startedAt": 1, "entries": entries,
		}}
	}
	notify("hook/started", run("running", []any{}))
	notify("hook/completed", run("blocked", []any{map[string]any{"kind": "feedback", "text": "Check your work first."}}))
	notify("item/completed", map[string]any{"threadId": threadID, "turnId": turnID, "item": map[string]any{
		"type": "hookPrompt", "id": nextID("msg"), "fragments": []any{map[string]any{"text": "Check your work first.", "hookRunId": "stop:0"}}}})
	last := message("checked after hook")
	turnCompleted(threadID, turnID, "completed", last, "checked after hook")
}

func echoTurn(threadID, turnID, text string) {
	replyTurn(threadID, turnID, text, "echo: "+text)
}

func replyTurn(threadID, turnID, text, answer string) {
	turnStarted(threadID, turnID)
	itemID := nextID("msg")
	notify("item/started", map[string]any{"threadId": threadID, "turnId": turnID,
		"item": map[string]any{"type": "agentMessage", "id": itemID, "text": ""}})
	for _, chunk := range chunks(answer, 3) {
		notify("item/agentMessage/delta", map[string]any{"threadId": threadID, "turnId": turnID, "itemId": itemID, "delta": chunk})
	}
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
	if reviewers[threadID] == "auto_review" || policies[threadID][0] == "never" {
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
