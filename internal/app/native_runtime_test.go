package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type nativeMemory struct {
	mu    sync.Mutex
	value domain.Conversation
	fail  bool
}

func (s *nativeMemory) SaveConversation(_ context.Context, v domain.Conversation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("disk failed")
	}
	b, _ := json.Marshal(v)
	_ = json.Unmarshal(b, &s.value)
	return nil
}
func (s *nativeMemory) LoadConversation(context.Context, string) (domain.Conversation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, _ := json.Marshal(s.value)
	var v domain.Conversation
	_ = json.Unmarshal(b, &v)
	return v, nil
}

type nativeModelFunc func(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error)

func (f nativeModelFunc) Stream(c context.Context, r domain.ModelRequest, e func(domain.ModelDelta) error) (domain.ModelResult, error) {
	return f(c, r, e)
}

type nativeTestTools struct {
	calls      int
	permission bool
	exec       func(context.Context, domain.ModelToolCall) (string, error)
}

func (t *nativeTestTools) Definitions() []domain.ModelTool {
	return []domain.ModelTool{{Name: "write", Parameters: json.RawMessage(`{"type":"object"}`)}}
}
func (t *nativeTestTools) NeedsApproval(domain.ModelToolCall) bool { return t.permission }
func (t *nativeTestTools) Execute(ctx context.Context, c domain.ModelToolCall) (string, error) {
	t.calls++
	if t.exec != nil {
		return t.exec(ctx, c)
	}
	return "written", nil
}
func nativeTestRuntime(t *testing.T, model ModelClient, tools NativeTools, repo *nativeMemory) *NativeRuntime {
	t.Helper()
	r := NewNativeRuntime(NativeRuntimeConfig{SessionID: "s", Conversation: domain.Conversation{ID: "native", Model: "test"}, Model: model, Tools: tools, Repo: repo, Instructions: "system"})
	t.Cleanup(func() { _ = r.Close() })
	return r
}
func nativeEnd(t *testing.T, r *NativeRuntime) []domain.Event {
	t.Helper()
	var events []domain.Event
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case ev := <-r.Events():
			events = append(events, ev)
			if ev.Type == domain.EventTurnEnded {
				return events
			}
		case <-timer.C:
			t.Fatal("turn did not end")
			return nil
		}
	}
}
func TestNativeLoopJournalsToolBatchBeforeExecution(t *testing.T) {
	repo := &nativeMemory{}
	tools := &nativeTestTools{}
	requests := 0
	tools.exec = func(_ context.Context, c domain.ModelToolCall) (string, error) {
		saved, _ := repo.LoadConversation(context.Background(), "native")
		if len(saved.Messages) != 4 || saved.Messages[2].CallID != "one" || saved.Messages[3].CallID != "two" {
			t.Errorf("missing durable tool outcomes: %+v", saved.Messages)
		}
		return c.ID, nil
	}
	model := nativeModelFunc(func(_ context.Context, req domain.ModelRequest, emit func(domain.ModelDelta) error) (domain.ModelResult, error) {
		requests++
		if requests == 1 {
			return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", ToolCalls: []domain.ModelToolCall{{ID: "one", Name: "write", Arguments: json.RawMessage(`{}`)}, {ID: "two", Name: "write", Arguments: json.RawMessage(`{}`)}}}}, nil
		}
		if len(req.Messages) != 4 || req.Messages[2].Text != "one" || req.Messages[3].Text != "two" {
			t.Errorf("bad continuation %+v", req.Messages)
		}
		if err := emit(domain.ModelDelta{Text: "done"}); err != nil {
			return domain.ModelResult{}, err
		}
		return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", Text: "done"}, Usage: domain.ModelUsage{Input: 12, Output: 3}}, nil
	})
	r := nativeTestRuntime(t, model, tools, repo)
	if err := r.Send(context.Background(), "turn", "hello"); err != nil {
		t.Fatal(err)
	}
	events := nativeEnd(t, r)
	if events[len(events)-1].Result.IsError || tools.calls != 2 || requests != 2 {
		t.Fatalf("events=%+v", events)
	}
	saved, _ := repo.LoadConversation(context.Background(), "native")
	if len(saved.Messages) != 5 {
		t.Fatal("final response not persisted")
	}
}
func TestNativeFailedStreamNeverExecutesTools(t *testing.T) {
	tools := &nativeTestTools{}
	repo := &nativeMemory{}
	model := nativeModelFunc(func(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error) {
		return domain.ModelResult{Message: domain.ModelMessage{ToolCalls: []domain.ModelToolCall{{ID: "call", Name: "write"}}}}, errors.New("truncated")
	})
	r := nativeTestRuntime(t, model, tools, repo)
	if err := r.Send(context.Background(), "turn", "hi"); err != nil {
		t.Fatal(err)
	}
	events := nativeEnd(t, r)
	if !events[len(events)-1].Result.IsError || tools.calls != 0 {
		t.Fatal("failed response executed tools")
	}
}
func TestNativePermissionAndSteeringAtBatchBoundary(t *testing.T) {
	tools := &nativeTestTools{permission: true}
	repo := &nativeMemory{}
	requests := 0
	model := nativeModelFunc(func(_ context.Context, req domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
		requests++
		if requests == 1 {
			return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", ToolCalls: []domain.ModelToolCall{{ID: "call", Name: "write", Arguments: json.RawMessage(`{}`)}}}}, nil
		}
		if req.Messages[len(req.Messages)-1].Text != "also check" {
			t.Errorf("steering lost: %+v", req.Messages)
		}
		return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", Text: "done"}}, nil
	})
	r := nativeTestRuntime(t, model, tools, repo)
	if err := r.Send(context.Background(), "turn", "hi"); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case ev := <-r.Events():
			if ev.Type != domain.EventRequestOpened {
				continue
			}
			if tools.calls != 0 {
				t.Fatal("tool ran before approval")
			}
			if err := r.Steer(context.Background(), "also check"); err != nil {
				t.Fatal(err)
			}
			if err := r.Respond(context.Background(), ev.Request.ID, RequestAnswer{Allow: true}); err != nil {
				t.Fatal(err)
			}
			nativeEnd(t, r)
			if tools.calls != 1 {
				t.Fatal("approved tool not called")
			}
			return
		case <-timer.C:
			t.Fatal("missing permission")
		}
	}
}
func TestNativeCancellationAnswersEntireToolBatch(t *testing.T) {
	repo := &nativeMemory{}
	tools := &nativeTestTools{}
	started := make(chan struct{})
	tools.exec = func(ctx context.Context, _ domain.ModelToolCall) (string, error) {
		close(started)
		<-ctx.Done()
		return "", ctx.Err()
	}
	model := nativeModelFunc(func(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error) {
		return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", ToolCalls: []domain.ModelToolCall{{ID: "one", Name: "write", Arguments: json.RawMessage(`{}`)}, {ID: "two", Name: "write", Arguments: json.RawMessage(`{}`)}}}}, nil
	})
	r := nativeTestRuntime(t, model, tools, repo)
	if err := r.Send(context.Background(), "turn", "hi"); err != nil {
		t.Fatal(err)
	}
	<-started
	if err := r.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	events := nativeEnd(t, r)
	if !events[len(events)-1].Result.Stopped || tools.calls != 1 {
		t.Fatal("interrupted batch continued")
	}
	saved, _ := repo.LoadConversation(context.Background(), "native")
	if len(saved.Messages) != 4 || saved.Messages[2].CallID != "one" || saved.Messages[3].CallID != "two" {
		t.Fatalf("orphaned calls: %+v", saved.Messages)
	}
}

func TestNativeQuestionIsShownAndAnswerReturnsToModel(t *testing.T) {
	repo := &nativeMemory{}
	steps := 0
	model := nativeModelFunc(func(_ context.Context, req domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
		steps++
		if steps == 1 {
			return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", ToolCalls: []domain.ModelToolCall{{ID: "q", Name: "ask_user", Arguments: json.RawMessage(`{"question":"Which option?","options":["A","B"]}`)}}}}, nil
		}
		if !strings.Contains(req.Messages[len(req.Messages)-1].Text, "B") {
			t.Errorf("answer missing: %+v", req.Messages)
		}
		return domain.ModelResult{Message: domain.ModelMessage{Text: "answered"}}, nil
	})
	r := nativeTestRuntime(t, model, &nativeTestTools{}, repo)
	if err := r.Send(context.Background(), "t", "ask"); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case ev := <-r.Events():
			if ev.Type != domain.EventRequestOpened {
				continue
			}
			if ev.Request.Kind != domain.RequestQuestion {
				t.Fatal("not a question")
			}
			if err := r.Respond(context.Background(), ev.Request.ID, RequestAnswer{Allow: true, Answers: map[string][]string{"Which option?": {"B"}}}); err != nil {
				t.Fatal(err)
			}
			nativeEnd(t, r)
			return
		case <-time.After(time.Second):
			t.Fatal("question not shown")
		}
	}
}

type finishingRepo struct {
	nativeMemory
	finishing chan struct{}
	release   chan struct{}
}

func (s *finishingRepo) SaveConversation(ctx context.Context, v domain.Conversation) error {
	if !v.Busy {
		close(s.finishing)
		<-s.release
	}
	return s.nativeMemory.SaveConversation(ctx, v)
}
func TestNativeRejectsSteeringAfterFinalBoundary(t *testing.T) {
	repo := &finishingRepo{finishing: make(chan struct{}), release: make(chan struct{})}
	model := nativeModelFunc(func(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error) {
		return domain.ModelResult{Message: domain.ModelMessage{Text: "done"}}, nil
	})
	r := NewNativeRuntime(NativeRuntimeConfig{SessionID: "s", Conversation: domain.Conversation{ID: "n"}, Model: model, Tools: &nativeTestTools{}, Repo: repo})
	defer func() { _ = r.Close() }()
	if err := r.Send(context.Background(), "t", "hello"); err != nil {
		t.Fatal(err)
	}
	<-repo.finishing
	err := r.Steer(context.Background(), "late input")
	close(repo.release)
	nativeEnd(t, r)
	if err == nil {
		t.Fatal("accepted steering after final history snapshot")
	}
}

func TestNativeEmitAfterCloseIsSafe(t *testing.T) {
	r := nativeTestRuntime(t, nil, &nativeTestTools{}, &nativeMemory{})
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	r.Emit(domain.Event{Type: domain.EventTurnStarted})
}

func TestNativeImagesAreLoadedBeforeSendingAndPersisted(t *testing.T) {
	repo := &nativeMemory{}
	model := nativeModelFunc(func(_ context.Context, r domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
		if len(r.Messages[0].Images) != 1 {
			t.Error("image missing")
		}
		return domain.ModelResult{Message: domain.ModelMessage{Text: "picture"}}, nil
	})
	r := NewNativeRuntime(NativeRuntimeConfig{SessionID: "s", Conversation: domain.Conversation{ID: "n"}, Tools: &nativeTestTools{}, Repo: repo, Model: model, LoadImages: func(context.Context, []Image) ([]domain.ModelImage, error) {
		return []domain.ModelImage{{URL: "data:image/png;base64,YQ=="}}, nil
	}})
	defer func() { _ = r.Close() }()
	if err := r.SendImages(context.Background(), "t", "look", []Image{{ID: "i"}}); err != nil {
		t.Fatal(err)
	}
	nativeEnd(t, r)
	saved, _ := repo.LoadConversation(context.Background(), "n")
	if len(saved.Messages[0].Images) != 1 {
		t.Fatal("image not persisted")
	}
}

func TestNativeInterruptMakesPendingApprovalStale(t *testing.T) {
	model := nativeModelFunc(func(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error) {
		return domain.ModelResult{Message: domain.ModelMessage{ToolCalls: []domain.ModelToolCall{{ID: "call", Name: "write", Arguments: []byte(`{}`)}}}}, nil
	})
	tools := &nativeTestTools{permission: true}
	r := nativeTestRuntime(t, model, tools, &nativeMemory{})
	if err := r.Send(context.Background(), "t", "work"); err != nil {
		t.Fatal(err)
	}
	for ev := range r.Events() {
		if ev.Type == domain.EventRequestOpened {
			break
		}
	}
	if err := r.Interrupt(context.Background()); err != nil {
		t.Fatal(err)
	}
	events := nativeEnd(t, r)
	for _, ev := range events {
		if ev.Type == domain.EventRequestResolved && ev.Request.State == domain.RequestStale {
			if tools.calls != 0 {
				t.Fatal("cancelled approval ran tool")
			}
			return
		}
	}
	t.Fatal("interrupted approval stayed pending")
}
