package native

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// taskTools coordinates separate journals. Children never share mutable history.
type taskTools struct {
	base    app.NativeTools
	factory *Factory
	parent  domain.Conversation
	cwd     string
	emit    func(domain.Event)
}

func (t *taskTools) Definitions() []domain.ModelTool {
	tools := t.base.Definitions()
	if canSpawnAgents(t.parent) {
		tools = append(tools, domain.ModelTool{Name: "spawn_agent", Description: "Run a child agent on one independent, bounded task and return its final result. The child starts with fresh context, so put everything it needs in task. Do steps that depend on each other yourself instead of delegating them. Set background=true only for work that can proceed while you do something else on different files; it returns the child ID at once, and wait_agent collects the result. Children inherit your permission mode.", Parameters: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"title":{"type":"string"},"background":{"type":"boolean"}},"required":["task"],"additionalProperties":false}`)})
	}
	return append(tools,
		domain.ModelTool{Name: "wait_agent", Description: "Wait up to 30 seconds for a background child agent; completed results remain available. Do not call it in a loop while you have other work.", Parameters: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}`)},
		domain.ModelTool{Name: "stop_agent", Description: "Interrupt your child agent and its descendants.", Parameters: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}`)},
		domain.ModelTool{Name: "send_agent", Description: "Send guidance to your child agent; starts a new turn if idle.", Parameters: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"},"message":{"type":"string"}},"required":["id","message"],"additionalProperties":false}`)})
}
func (t *taskTools) NeedsApproval(call domain.ModelToolCall) bool {
	switch call.Name {
	case "spawn_agent", "wait_agent", "stop_agent", "send_agent":
		return false
	default:
		return t.base.NeedsApproval(call)
	}
}
func (t *taskTools) Execute(ctx context.Context, call domain.ModelToolCall) (string, error) {
	switch call.Name {
	case "spawn_agent", "wait_agent", "stop_agent", "send_agent":
	default:
		return t.base.Execute(ctx, call)
	}
	var input struct {
		ID         string `json:"id"`
		Task       string `json:"task"`
		Title      string `json:"title"`
		Message    string `json:"message"`
		Background bool   `json:"background"`
	}
	if json.Unmarshal(call.Arguments, &input) != nil {
		return "", errors.New("invalid agent arguments")
	}
	if call.Name == "spawn_agent" {
		spawned, err := t.spawn(ctx, input.Task, input.Title)
		if err != nil || input.Background {
			return spawned, err
		}
		var child struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal([]byte(spawned), &child)
		return t.wait(ctx, child.ID, 0)
	}
	child, err := t.factory.Repo.LoadConversation(ctx, input.ID)
	if err != nil {
		return "", err
	}
	if child.Parent != t.parent.ID {
		return "", errors.New("agent is not your child")
	}
	t.factory.mu.Lock()
	runtime := t.factory.runtimes[input.ID]
	t.factory.mu.Unlock()
	switch call.Name {
	case "stop_agent":
		if runtime == nil {
			return "", errors.New("child is not attached")
		}
		return "Child interrupted", runtime.Interrupt(ctx)
	case "send_agent":
		if input.Message == "" || runtime == nil {
			return "", errors.New("message and attached child required")
		}
		if runtime.Running() {
			return "Guidance queued", runtime.Steer(ctx, input.Message)
		}
		turn := domain.TurnID(rand.Text())
		runtime.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: domain.ItemID(rand.Text()), SessionID: runtime.SessionID(), TurnID: turn, Kind: domain.ItemUserMessage, Status: domain.ItemCompleted, Text: input.Message}})
		return "Child started", runtime.Send(ctx, turn, input.Message)
	case "wait_agent":
		return t.wait(ctx, input.ID, 30*time.Second)
	}
	return "", errors.New("unknown agent operation")
}

// childStartTimeout bounds how long a parent waits for the session manager to
// attach a child it has just spawned.
var childStartTimeout = 30 * time.Second

// wait blocks until the child has finished; a positive limit returns "running"
// once it passes.
func (t *taskTools) wait(ctx context.Context, id string, limit time.Duration) (string, error) {
	f := t.factory
	attached := func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.runtimes[id] != nil }
	child, err := f.Repo.LoadConversation(ctx, id)
	if err != nil {
		return "", err
	}
	f.taskMu.Lock()
	_, tracked := f.tasks[id]
	f.taskMu.Unlock()
	if !attached() && !tracked && (child.Busy || child.PendingPrompt != "") {
		return `{"status":"interrupted","error":"Child runtime is not attached after restart. Open its session to resume; inspect unknown tool outcomes before retrying."}`, nil
	}
	var deadline <-chan time.Time
	if limit > 0 {
		timer := time.NewTimer(limit)
		defer timer.Stop()
		deadline = timer.C
	}
	start := time.NewTimer(childStartTimeout)
	defer start.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		if child, err = f.Repo.LoadConversation(ctx, id); err != nil {
			return "", err
		}
		if !child.Busy && child.PendingPrompt == "" {
			text := ""
			for i := len(child.Messages) - 1; i >= 0; i-- {
				if child.Messages[i].Role == "assistant" {
					text = child.Messages[i].Text
					break
				}
			}
			out, _ := json.Marshal(map[string]any{"id": child.ID, "status": "completed", "result": text, "error": child.LastError})
			return string(out), nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline:
			return `{"status":"running"}`, nil
		case <-start.C:
			if limit == 0 && !attached() {
				child.Busy = false
				child.PendingPrompt = ""
				child.LastError = "Child agent did not start"
				_ = f.Repo.SaveConversation(ctx, child)
				return "", errors.New("child agent did not start; do the task yourself")
			}
		case <-tick.C:
		}
	}
}
func (t *taskTools) spawn(ctx context.Context, task, title string) (string, error) {
	if task == "" || len(task) > 128<<10 {
		return "", errors.New("task is empty or exceeds limit")
	}
	if !canSpawnAgents(t.parent) {
		return "", errors.New("only the root agent may spawn subagents; complete the assigned task yourself")
	}
	f := t.factory
	f.taskMu.Lock()
	defer f.taskMu.Unlock()
	active := 0
	for id := range f.tasks {
		c, err := f.Repo.LoadConversation(ctx, id)
		if errors.Is(err, app.ErrConversationNotFound) {
			delete(f.tasks, id)
			continue
		}
		if err != nil {
			return "", err
		}
		if c.Busy || c.PendingPrompt != "" {
			active++
		}
	}
	if active >= 4 {
		return "", errors.New("four native child agents are already active; wait for one")
	}
	child := domain.Conversation{ID: rand.Text(), Parent: t.parent.ID, Depth: t.parent.Depth + 1, Model: t.parent.Model, Effort: t.parent.Effort, PermissionMode: t.parent.PermissionMode, PendingPrompt: task, Busy: true}
	if err := f.Repo.SaveConversation(ctx, child); err != nil {
		return "", err
	}
	if f.tasks == nil {
		f.tasks = map[string]string{}
	}
	f.tasks[child.ID] = child.Parent
	t.emit(domain.Event{Type: domain.EventSubagentSpawned, Subagent: &domain.SubagentSpawn{ThreadID: child.ID, Title: title}})
	out, _ := json.Marshal(map[string]string{"id": child.ID})
	return string(out), nil
}
func (f *Factory) interruptChildren(parent string) {
	f.taskMu.Lock()
	var ids []string
	for id, p := range f.tasks {
		if p == parent {
			ids = append(ids, id)
		}
	}
	f.taskMu.Unlock()
	for _, id := range ids {
		f.startMu.Lock()
		f.mu.Lock()
		r := f.runtimes[id]
		f.mu.Unlock()
		if r == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			child, err := f.Repo.LoadConversation(ctx, id)
			if err == nil {
				child.Busy = false
				child.PendingPrompt = ""
				child.LastError = "Cancelled before child attachment"
				_ = f.Repo.SaveConversation(ctx, child)
			}
			cancel()
		}
		f.startMu.Unlock()
		if r != nil {
			_ = r.Interrupt(context.Background())
		}
	}
}

// Both markers are checked so old or partially populated journals cannot
// restore nested delegation.
func canSpawnAgents(conversation domain.Conversation) bool {
	return conversation.Parent == "" && conversation.Depth == 0
}
