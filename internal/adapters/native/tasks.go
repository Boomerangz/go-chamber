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
		tools = append(tools, domain.ModelTool{Name: "spawn_agent", Description: "Start an independent child agent for a bounded task; returns its ID. Children inherit your permission mode. Use wait_agent for results.", Parameters: json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"},"title":{"type":"string"}},"required":["task"],"additionalProperties":false}`)})
	}
	return append(tools,
		domain.ModelTool{Name: "wait_agent", Description: "Wait up to 30 seconds for your child agent; completed results remain available.", Parameters: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}`)},
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
		ID      string `json:"id"`
		Task    string `json:"task"`
		Title   string `json:"title"`
		Message string `json:"message"`
	}
	if json.Unmarshal(call.Arguments, &input) != nil {
		return "", errors.New("invalid agent arguments")
	}
	if call.Name == "spawn_agent" {
		return t.spawn(ctx, input.Task, input.Title)
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
		t.factory.taskMu.Lock()
		_, tracked := t.factory.tasks[input.ID]
		t.factory.taskMu.Unlock()
		if runtime == nil && !tracked && (child.Busy || child.PendingPrompt != "") {
			return `{"status":"interrupted","error":"Child runtime is not attached after restart. Open its session to resume; inspect unknown tool outcomes before retrying."}`, nil
		}
		deadline := time.NewTimer(30 * time.Second)
		defer deadline.Stop()
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			child, err = t.factory.Repo.LoadConversation(ctx, input.ID)
			if err != nil {
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
			case <-deadline.C:
				return `{"status":"running"}`, nil
			case <-tick.C:
			}
		}
	}
	return "", errors.New("unknown agent operation")
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
