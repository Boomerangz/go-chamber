package app

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var ErrConversationNotFound = errors.New("native conversation not found")

type ConversationRepo interface {
	LoadConversation(context.Context, string) (domain.Conversation, error)
	SaveConversation(context.Context, domain.Conversation) error
}

type NativeTools interface {
	Definitions() []domain.ModelTool
	NeedsApproval(domain.ModelToolCall) bool
	Execute(context.Context, domain.ModelToolCall) (string, error)
}

type NativeRuntimeConfig struct {
	SessionID      domain.SessionID
	Conversation   domain.Conversation
	Model          ModelClient
	Tools          NativeTools
	Repo           ConversationRepo
	Instructions   string
	ContextWindow  int
	LoadImages     func(context.Context, []Image) ([]domain.ModelImage, error)
	PermissionMode string
	StopTask       func(context.Context, string) error
	OnClose        func()
	OnInterrupt    func()
}

type NativeRuntime struct {
	cfg            NativeRuntimeConfig
	events         chan domain.Event
	eventMu        sync.RWMutex
	ctx            context.Context
	cancel         context.CancelFunc
	mu             sync.Mutex
	running        bool
	acceptingSteer bool
	closed         bool
	turnCancel     context.CancelFunc
	steering       []string
	answers        map[domain.RequestID]chan RequestAnswer
	grants         map[string]bool
	wg             sync.WaitGroup
	closeOnce      sync.Once
}

func NewNativeRuntime(cfg NativeRuntimeConfig) *NativeRuntime {
	ctx, cancel := context.WithCancel(context.Background())
	return &NativeRuntime{cfg: cfg, events: make(chan domain.Event, 128), ctx: ctx, cancel: cancel, answers: map[domain.RequestID]chan RequestAnswer{}, grants: map[string]bool{}}
}
func (r *NativeRuntime) Running() bool               { r.mu.Lock(); defer r.mu.Unlock(); return r.running }
func (r *NativeRuntime) SessionID() domain.SessionID { return r.cfg.SessionID }
func (r *NativeRuntime) SelectedSettings() (string, string, string) {
	return r.cfg.Conversation.Model, r.cfg.Conversation.Effort, r.cfg.PermissionMode
}
func (r *NativeRuntime) NativeID() string            { return r.cfg.Conversation.ID }
func (r *NativeRuntime) Events() <-chan domain.Event { return r.events }
func (r *NativeRuntime) Emit(ev domain.Event) {
	r.eventMu.RLock()
	defer r.eventMu.RUnlock()
	if r.ctx.Err() != nil {
		return
	}
	ev.SessionID = r.cfg.SessionID
	select {
	case r.events <- ev:
	case <-r.ctx.Done():
	}
}
func (r *NativeRuntime) Send(ctx context.Context, turn domain.TurnID, text string) error {
	return r.send(ctx, turn, text, nil)
}
func (r *NativeRuntime) SendImages(ctx context.Context, turn domain.TurnID, text string, images []Image) error {
	if r.cfg.LoadImages == nil {
		return ErrImagesUnsupported
	}
	loaded, err := r.cfg.LoadImages(ctx, images)
	if err != nil {
		return err
	}
	return r.send(ctx, turn, text, loaded)
}
func (r *NativeRuntime) send(ctx context.Context, turn domain.TurnID, text string, images []domain.ModelImage) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("native runtime closed")
	}
	if r.running {
		return domain.ErrSessionBusy
	}
	r.running = true
	r.acceptingSteer = true
	turnCtx, cancel := context.WithCancel(r.ctx)
	r.turnCancel = cancel
	r.wg.Go(func() {
		result := r.runTurn(turnCtx, turn, text, images)
		cancel()
		r.mu.Lock()
		r.running = false
		r.turnCancel = nil
		r.mu.Unlock()
		r.Emit(domain.Event{Type: domain.EventTurnEnded, Result: &result})
	})
	return nil
}
func (r *NativeRuntime) Steer(ctx context.Context, text string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.running || !r.acceptingSteer {
		return errors.New("native turn is not running")
	}
	r.steering = append(r.steering, text)
	return nil
}
func (r *NativeRuntime) Interrupt(context.Context) error {
	r.mu.Lock()
	if r.turnCancel != nil {
		r.turnCancel()
	}
	r.mu.Unlock()
	if r.cfg.OnInterrupt != nil {
		r.cfg.OnInterrupt()
	}
	return nil
}
func (r *NativeRuntime) StopTask(ctx context.Context, id string) error {
	if r.cfg.StopTask != nil {
		return r.cfg.StopTask(ctx, id)
	}
	return errors.New("no native subagent with this ID")
}
func (r *NativeRuntime) Respond(ctx context.Context, id domain.RequestID, answer RequestAnswer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	ch, ok := r.answers[id]
	if !ok {
		return ErrRequestNotFound
	}
	delete(r.answers, id)
	ch <- answer
	return nil
}
func (r *NativeRuntime) Close() error {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.cancel()
		r.mu.Unlock()
		r.wg.Wait()
		r.eventMu.Lock()
		close(r.events)
		r.eventMu.Unlock()
		if r.cfg.OnClose != nil {
			r.cfg.OnClose()
		}
	})
	return nil
}
func (r *NativeRuntime) SetModel(context.Context, string, string) error { return ErrRestartRequired }

func (r *NativeRuntime) persist() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return r.cfg.Repo.SaveConversation(ctx, r.cfg.Conversation)
}
func (r *NativeRuntime) runTurn(ctx context.Context, turn domain.TurnID, text string, images []domain.ModelImage) (result domain.TurnResult) {
	r.Emit(domain.Event{Type: domain.EventTurnStarted})
	r.cfg.Conversation.Busy = true
	goalReply, goalPrompt, goalCommand := r.goalCommand(text)
	if goalCommand {
		r.notice(turn, goalReply)
		text = goalPrompt
	}
	settled := goalCommand && goalPrompt == ""
	if text != "/compact" && !settled {
		r.cfg.Conversation.Messages = append(r.cfg.Conversation.Messages, domain.ModelMessage{Role: "user", Text: text, Images: images})
	}
	var charged int64
	defer func() {
		r.finishSteering(turn)
		// A goal is active only while its turn runs: any exit that left it
		// active was cut short.
		if g := r.cfg.Conversation.Goal; g.Active() {
			g.Spend(result.InputTokens + result.OutputTokens - charged)
			reason := "turn failed: " + result.Error
			if ctx.Err() != nil {
				reason = "stopped by the user"
			}
			g.Pause(reason)
			r.notice(turn, g.Progress())
		}
		r.cfg.Conversation.Busy = false
		r.cfg.Conversation.LastError = result.Error
		if err := r.persist(); err != nil {
			result.IsError = true
			result.Error = err.Error()
		}
		if ctx.Err() != nil {
			result.Stopped = true
		}
	}()
	if settled {
		return domain.TurnResult{Text: goalReply}
	}
	if err := r.persist(); err != nil {
		return nativeFailure(err)
	}
	if text == "/compact" {
		if err := r.compact(ctx); err != nil {
			return nativeFailure(err)
		}
		r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: domain.ItemID(rand.Text()), SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "Context compacted."}})
		return domain.TurnResult{Text: "Context compacted."}
	}
	for step := 0; step < 100; step++ {
		if err := ctx.Err(); err != nil {
			return nativeFailure(err)
		}
		r.drainSteering(turn)
		if err := r.persist(); err != nil {
			return nativeFailure(err)
		}
		if r.needsCompaction() {
			if err := r.compact(ctx); err != nil {
				return nativeFailure(err)
			}
		}
		message, usage, err := r.infer(ctx, turn)
		result.InputTokens += usage.Input
		result.OutputTokens += usage.Output
		if err != nil {
			result.IsError = true
			result.Error = err.Error()
			return result
		}
		r.cfg.Conversation.Messages = append(r.cfg.Conversation.Messages, message)
		// Commit an explicit unknown outcome for EVERY call before running any tool.
		// A crash never leaves a call to be blindly replayed on resume.
		start := len(r.cfg.Conversation.Messages)
		for _, call := range message.ToolCalls {
			r.cfg.Conversation.Messages = append(r.cfg.Conversation.Messages, domain.ModelMessage{Role: "tool", CallID: call.ID, Text: "Execution interrupted or not started; outcome unknown. Inspect state before retrying."})
		}
		if err = r.persist(); err != nil {
			return nativeFailure(err)
		}
		if len(message.ToolCalls) == 0 {
			result.Text = message.Text
			if r.cfg.Conversation.Goal.Active() {
				if r.drainSteering(turn) {
					continue
				}
				spent := result.InputTokens + result.OutputTokens
				next := r.pursueGoal(ctx, turn, message.Text, spent-charged)
				charged = spent
				if next != "" {
					r.cfg.Conversation.Messages = append(r.cfg.Conversation.Messages, domain.ModelMessage{Role: "user", Text: next})
					step = -1 // Each continuation gets its own step allowance.
					continue
				}
			}
			if r.drainOrFinishSteering(turn) {
				continue
			}
			return result
		}
		for i, call := range message.ToolCalls {
			if err = ctx.Err(); err != nil {
				return nativeFailure(err)
			}
			output, toolErr := r.execute(ctx, turn, call)
			if toolErr != nil {
				output = "Tool error: " + toolErr.Error()
			}
			r.cfg.Conversation.Messages[start+i].Text = output
			if err = r.persist(); err != nil {
				return nativeFailure(err)
			}
		}
	}
	return nativeFailure(errors.New("native turn reached the 100-step limit; send a message to continue"))
}
func nativeFailure(err error) domain.TurnResult {
	return domain.TurnResult{IsError: true, Error: err.Error()}
}
func (r *NativeRuntime) drainSteering(turn domain.TurnID) bool {
	r.mu.Lock()
	texts := r.steering
	r.steering = nil
	r.mu.Unlock()
	r.absorb(turn, texts)
	return len(texts) > 0
}
func (r *NativeRuntime) finishSteering(turn domain.TurnID) {
	r.mu.Lock()
	r.acceptingSteer = false
	texts := r.steering
	r.steering = nil
	r.mu.Unlock()
	r.absorb(turn, texts)
}
func (r *NativeRuntime) drainOrFinishSteering(turn domain.TurnID) bool {
	r.mu.Lock()
	texts := r.steering
	r.steering = nil
	if len(texts) == 0 {
		r.acceptingSteer = false
	}
	r.mu.Unlock()
	r.absorb(turn, texts)
	return len(texts) > 0
}
func (r *NativeRuntime) infer(ctx context.Context, turn domain.TurnID) (domain.ModelMessage, domain.ModelUsage, error) {
	id := domain.ItemID(rand.Text())
	reasoningID := domain.ItemID(rand.Text())
	r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: id, SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemAssistantMessage, Status: domain.ItemStreaming}})
	reasoningStarted := false
	res, err := r.cfg.Model.Stream(ctx, domain.ModelRequest{Model: r.cfg.Conversation.Model, Effort: r.cfg.Conversation.Effort, SessionID: r.cfg.SessionID, Instructions: r.cfg.Instructions, Messages: r.cfg.Conversation.Messages, Tools: r.definitions()}, func(delta domain.ModelDelta) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if delta.Text != "" {
			r.Emit(domain.Event{Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: id, Text: delta.Text}})
		}
		if delta.Reasoning != "" {
			if !reasoningStarted {
				reasoningStarted = true
				r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: reasoningID, SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemReasoning, Status: domain.ItemStreaming}})
			}
			r.Emit(domain.Event{Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: reasoningID, Text: delta.Reasoning}})
		}
		return nil
	})
	if err != nil {
		return domain.ModelMessage{}, domain.ModelUsage{}, err
	}
	res.Message.Role = "assistant"
	r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: id, SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: res.Message.Text}})
	if reasoningStarted {
		r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: reasoningID, SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemReasoning, Status: domain.ItemCompleted, Text: res.Message.Reasoning}})
	}
	return res.Message, res.Usage, nil
}
func (r *NativeRuntime) execute(ctx context.Context, turn domain.TurnID, call domain.ModelToolCall) (output string, err error) {
	if call.Name == planTool.Name {
		return r.updatePlan(turn, call)
	}
	item := domain.Item{ID: domain.ItemID(rand.Text()), SessionID: r.cfg.SessionID, TurnID: turn, Kind: domain.ItemToolCall, Status: domain.ItemStreaming, Name: call.Name, Input: call.Arguments}
	r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &item})
	defer func() {
		done := item
		done.Status = domain.ItemCompleted
		done.Text = output
		if err != nil {
			done.Status = domain.ItemFailed
			done.Text = err.Error()
		}
		r.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &done})
	}()
	known := false
	for _, tool := range r.definitions() {
		if tool.Name == call.Name {
			known = true
			break
		}
	}
	if !known {
		return "", fmt.Errorf("unknown tool %q", call.Name)
	}
	if call.Name == "ask_user" {
		return r.question(ctx, turn, item.ID, call)
	}
	if r.cfg.Tools.NeedsApproval(call) && r.cfg.PermissionMode != "full-access" && !r.grants[call.Name] {
		if r.cfg.PermissionMode == "read-only" {
			return "", errors.New("tool blocked in read-only mode")
		}
		answer, askErr := r.ask(ctx, turn, item.ID, call)
		if askErr != nil {
			return "", askErr
		}
		if !answer.Allow {
			return "", fmt.Errorf("permission denied: %s", answer.Message)
		}
		if answer.AllowForSession {
			r.grants[call.Name] = true
		}
	}
	return r.cfg.Tools.Execute(ctx, call)
}
func (r *NativeRuntime) ask(ctx context.Context, turn domain.TurnID, item domain.ItemID, call domain.ModelToolCall) (RequestAnswer, error) {
	id := domain.RequestID(rand.Text())
	payload, _ := json.Marshal(map[string]any{"toolName": call.Name, "input": call.Arguments})
	req := domain.Request{ID: id, SessionID: r.cfg.SessionID, TurnID: turn, ItemID: item, Kind: domain.RequestPermission, Title: "Allow " + call.Name, Payload: payload, State: domain.RequestPending}
	return r.waitRequest(ctx, req)
}
func (r *NativeRuntime) waitRequest(ctx context.Context, req domain.Request) (RequestAnswer, error) {
	id := req.ID
	ch := make(chan RequestAnswer, 1)
	r.mu.Lock()
	r.answers[id] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.answers, id); r.mu.Unlock() }()
	r.Emit(domain.Event{Type: domain.EventRequestOpened, Request: &req})
	select {
	case <-ctx.Done():
		stale := req
		stale.State = domain.RequestStale
		r.Emit(domain.Event{Type: domain.EventRequestResolved, Request: &stale})
		return RequestAnswer{}, ctx.Err()
	case answer := <-ch:
		resolved := req
		resolved.State = domain.RequestResolved
		resolved.Answer, _ = json.Marshal(answer)
		r.Emit(domain.Event{Type: domain.EventRequestResolved, Request: &resolved})
		return answer, nil
	}
}

var _ AgentRuntime = (*NativeRuntime)(nil)

func (r *NativeRuntime) definitions() []domain.ModelTool {
	return append(r.cfg.Tools.Definitions(), planTool, domain.ModelTool{Name: "ask_user", Description: "Ask the user a question and wait for their answer.", Parameters: json.RawMessage(`{"type":"object","properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"required":["question"],"additionalProperties":false}`)})
}
func (r *NativeRuntime) question(ctx context.Context, turn domain.TurnID, item domain.ItemID, call domain.ModelToolCall) (string, error) {
	var input struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	}
	if json.Unmarshal(call.Arguments, &input) != nil || input.Question == "" || len(input.Options) > 20 {
		return "", errors.New("invalid question")
	}
	options := make([]map[string]string, 0, len(input.Options))
	for _, option := range input.Options {
		options = append(options, map[string]string{"label": option})
	}
	payload, _ := json.Marshal(map[string]any{"toolName": "ask_user", "input": map[string]any{"questions": []any{map[string]any{"question": input.Question, "header": "Question", "options": options}}}})
	answer, err := r.waitRequest(ctx, domain.Request{ID: domain.RequestID(rand.Text()), SessionID: r.cfg.SessionID, TurnID: turn, ItemID: item, Kind: domain.RequestQuestion, Title: input.Question, Payload: payload, State: domain.RequestPending})
	if err != nil {
		return "", err
	}
	if !answer.Allow {
		return "User skipped the question: " + answer.Message, nil
	}
	raw, _ := json.Marshal(answer.Answers)
	return string(raw), nil
}
