package native

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/app/apptest"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type memory struct {
	mu     sync.Mutex
	values map[string]domain.Conversation
}

func (m *memory) LoadConversation(_ context.Context, id string) (domain.Conversation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[id]
	if !ok {
		return v, app.ErrConversationNotFound
	}
	raw, _ := json.Marshal(v)
	var out domain.Conversation
	_ = json.Unmarshal(raw, &out)
	return out, nil
}
func (m *memory) SaveConversation(_ context.Context, v domain.Conversation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	raw, _ := json.Marshal(v)
	var out domain.Conversation
	_ = json.Unmarshal(raw, &out)
	m.values[v.ID] = out
	return nil
}

type echoModel struct {
	mu       sync.Mutex
	requests []domain.ModelRequest
}

func (e *echoModel) Stream(_ context.Context, r domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.requests = append(e.requests, r)
	return domain.ModelResult{Message: domain.ModelMessage{Role: "assistant", Text: "hello"}}, nil
}
func (e *echoModel) ListModels(context.Context) ([]app.ModelInfo, error) {
	return []app.ModelInfo{{ID: "fresh", Name: "Fresh"}}, nil
}

type noTools struct{}

func (noTools) Definitions() []domain.ModelTool                               { return nil }
func (noTools) NeedsApproval(domain.ModelToolCall) bool                       { return false }
func (noTools) Execute(context.Context, domain.ModelToolCall) (string, error) { return "", nil }
func testFactory(t *testing.T) (*Factory, *echoModel) {
	t.Helper()
	model := &echoModel{}
	f := &Factory{Repo: &memory{values: map[string]domain.Conversation{}}, Providers: map[string]Provider{"codex": {Client: model, Catalog: model}}, Tools: func(string) (app.NativeTools, error) { return noTools{}, nil }}
	t.Cleanup(func() { _ = f.Close() })
	return f, model
}
func endTurn(t *testing.T, r app.AgentRuntime) {
	t.Helper()
	for {
		select {
		case e := <-r.Events():
			if e.Type == domain.EventTurnEnded {
				if e.Result.IsError {
					t.Fatal(e.Result.Error)
				}
				return
			}
		case <-time.After(3 * time.Second):
			t.Fatal("turn timeout")
		}
	}
}
func TestRuntimeContract(t *testing.T) {
	f, _ := testFactory(t)
	r, err := f.Start(context.Background(), app.StartRequest{SessionID: "s", Agent: domain.AgentNative, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	apptest.RuntimeContract(t, r)
}
func TestNativeFactoryResumeForkAndDynamicModels(t *testing.T) {
	f, model := testFactory(t)
	ctx := context.Background()
	cwd := t.TempDir()
	models, err := f.Models(ctx, domain.AgentNative)
	if err != nil || len(models) != 1 || models[0].ID != "codex:fresh" {
		t.Fatalf("%+v %v", models, err)
	}
	r, err := f.Start(ctx, app.StartRequest{SessionID: "s", Agent: domain.AgentNative, Cwd: cwd})
	if err != nil {
		t.Fatal(err)
	}
	if err = r.Send(ctx, "t", "original"); err != nil {
		t.Fatal(err)
	}
	endTurn(t, r)
	id := r.NativeID()
	if err = r.Close(); err != nil {
		t.Fatal(err)
	}
	fork, err := f.Start(ctx, app.StartRequest{SessionID: "fork", Agent: domain.AgentNative, Cwd: cwd, NativeID: id, Fork: true})
	if err != nil {
		t.Fatal(err)
	}
	if fork.NativeID() == id {
		t.Fatal("fork reused journal")
	}
	if err = fork.Send(ctx, "t2", "fork message"); err != nil {
		t.Fatal(err)
	}
	endTurn(t, fork)
	resumed, err := f.Start(ctx, app.StartRequest{SessionID: "s", Agent: domain.AgentNative, Cwd: cwd, NativeID: id})
	if err != nil {
		t.Fatal(err)
	}
	if err = resumed.Send(ctx, "t3", "resume"); err != nil {
		t.Fatal(err)
	}
	endTurn(t, resumed)
	model.mu.Lock()
	defer model.mu.Unlock()
	req := model.requests[len(model.requests)-1]
	if req.Model != "fresh" || len(req.Messages) != 3 || req.Messages[0].Text != "original" || req.Messages[2].Text != "resume" {
		t.Fatalf("wrong resumed context: %+v", req)
	}
}

type changingCatalog struct{ calls int }

func (c *changingCatalog) ListModels(context.Context) ([]app.ModelInfo, error) {
	c.calls++
	return []app.ModelInfo{{ID: fmt.Sprint(c.calls), Name: "Model"}}, nil
}
func TestForceRefreshAndLoginInvalidation(t *testing.T) {
	f, model := testFactory(t)
	c := &changingCatalog{}
	f.Providers["codex"] = Provider{Client: model, Catalog: c}
	ctx := context.Background()
	first, _ := f.Models(ctx, domain.AgentNative)
	cached, _ := f.Models(ctx, domain.AgentNative)
	fresh, err := f.RefreshModels(ctx, domain.AgentNative)
	if err != nil || first[0].ID != cached[0].ID || fresh[0].ID == first[0].ID {
		t.Fatalf("%v %v %v %v", first, cached, fresh, err)
	}
	f.InvalidateModels()
	loggedIn, _ := f.Models(ctx, domain.AgentNative)
	if loggedIn[0].ID == fresh[0].ID {
		t.Fatal("account change retained catalog")
	}
}

type badCatalog struct{}

func (badCatalog) ListModels(context.Context) ([]app.ModelInfo, error) {
	return nil, fmt.Errorf("offline")
}
func TestNativeFactoryRejectsUnavailableAndDuplicateSessions(t *testing.T) {
	ctx := context.Background()
	f, _ := testFactory(t)
	if _, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentClaude}); err == nil {
		t.Fatal("accepted another agent")
	}
	if _, err := f.Models(ctx, domain.AgentClaude); err == nil {
		t.Fatal("listed another agent")
	}
	if _, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, NativeID: "missing"}); err == nil {
		t.Fatal("missing resume accepted")
	}
	if _, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, Model: "codex:removed"}); err == nil {
		t.Fatal("removed model accepted")
	}
	r, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, SessionID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, NativeID: r.NativeID()}); err == nil {
		t.Fatal("duplicate attached")
	}
	passive, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, NativeID: r.NativeID(), Passive: true})
	if err != nil || passive != r {
		t.Fatal("passive lost attached runtime")
	}
	if _, err = f.Account(ctx, domain.AgentNative); err == nil {
		t.Fatal("missing accounts accepted")
	}
	if _, err = f.StartLogin(ctx, domain.AgentNative); err == nil {
		t.Fatal("missing login accepted")
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = f.Start(ctx, app.StartRequest{Agent: domain.AgentNative}); err == nil {
		t.Fatal("closed factory restarted")
	}
	offline, model := testFactory(t)
	offline.Providers["codex"] = Provider{Client: model, Catalog: badCatalog{}}
	if _, err = offline.Start(ctx, app.StartRequest{Agent: domain.AgentNative}); err == nil {
		t.Fatal("picked absent default")
	}
	if _, err = offline.Start(ctx, app.StartRequest{Agent: domain.AgentNative, Model: "unknown:model"}); err == nil {
		t.Fatal("unknown provider accepted")
	}
	// An existing explicit model can continue during a catalog outage.
	if _, err = offline.Start(ctx, app.StartRequest{Agent: domain.AgentNative, SessionID: "known", Model: "codex:known"}); err != nil {
		t.Fatal(err)
	}
	if _, err = (profileClient{}).Stream(ctx, domain.ModelRequest{Model: "bad"}, nil); err == nil {
		t.Fatal("unknown transport accepted")
	}
}

type flakyCatalog struct{ fail bool }

func (c *flakyCatalog) ListModels(context.Context) ([]app.ModelInfo, error) {
	if c.fail {
		return nil, fmt.Errorf("offline")
	}
	return []app.ModelInfo{{ID: "model", Name: "Model"}}, nil
}
func TestNativeCatalogLabelsStaleSnapshot(t *testing.T) {
	f, model := testFactory(t)
	source := &flakyCatalog{}
	f.Providers["codex"] = Provider{Client: model, Catalog: source}
	fresh, err := f.Models(context.Background(), domain.AgentNative)
	if err != nil || fresh[0].Stale || fresh[0].CatalogUpdatedAt.IsZero() {
		t.Fatal("fresh catalog lacks timestamp", err)
	}
	source.fail = true
	stale, err := f.RefreshModels(context.Background(), domain.AgentNative)
	if err != nil || !stale[0].Stale || stale[0].CatalogUpdatedAt != fresh[0].CatalogUpdatedAt {
		t.Fatal("stale catalog presented as fresh", err)
	}
}

func TestNativeCommandsAdvertiseCompaction(t *testing.T) {
	f, _ := testFactory(t)
	commands, err := f.Commands(context.Background(), domain.AgentNative, "")
	if err != nil || len(commands) != 1 || commands[0].Insert != "/compact" {
		t.Fatalf("%v %v", commands, err)
	}
}

func TestNativeResumeCanClearReasoningEffort(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	r, err := f.Start(ctx, app.StartRequest{SessionID: "s", Agent: domain.AgentNative, Model: "codex:fresh", Effort: "high"})
	if err != nil {
		t.Fatal(err)
	}
	id := r.NativeID()
	if err = r.Close(); err != nil {
		t.Fatal(err)
	}
	resumed, err := f.Start(ctx, app.StartRequest{SessionID: "s", Agent: domain.AgentNative, NativeID: id, Model: "codex:fresh", Effort: ""})
	if err != nil {
		t.Fatal(err)
	}
	_, effort, _ := resumed.(app.RuntimeSettings).SelectedSettings()
	if effort != "" {
		t.Fatal("default effort retained previous override")
	}
}

func TestForkOfChildBecomesIndependentConversation(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	if err := f.Repo.SaveConversation(ctx, domain.Conversation{ID: "child", Model: "codex:fresh", Parent: "parent", Depth: 2, PendingPrompt: "old task", Busy: true}); err != nil {
		t.Fatal(err)
	}
	fork, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, SessionID: "fork", NativeID: "child", Fork: true})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := f.Repo.LoadConversation(ctx, fork.NativeID())
	if err != nil || saved.Parent != "" || saved.Depth != 0 || saved.PendingPrompt != "" || saved.Busy {
		t.Fatalf("fork retained child ownership: %+v %v", saved, err)
	}
}

func TestOneProviderOutageDoesNotInvalidateAnotherProvidersSavedModel(t *testing.T) {
	f, model := testFactory(t)
	f.Providers["codex"] = Provider{Client: model, Catalog: badCatalog{}}
	f.Providers["openrouter"] = Provider{Client: model, Catalog: model}
	r, err := f.Start(context.Background(), app.StartRequest{Agent: domain.AgentNative, SessionID: "s", Model: "codex:known"})
	if err != nil || r == nil {
		t.Fatal("partial catalog outage invalidated explicit model", err)
	}
}

func TestNativeDefaultChoiceReselectsProviderDefault(t *testing.T) {
	f, model := testFactory(t)
	f.Providers["openrouter"] = Provider{Client: model, Catalog: model}
	ctx := context.Background()
	r, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, SessionID: "s", Model: "openrouter:fresh"})
	if err != nil {
		t.Fatal(err)
	}
	id := r.NativeID()
	if err = r.Close(); err != nil {
		t.Fatal(err)
	}
	r, err = f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, SessionID: "s", NativeID: id})
	if err != nil {
		t.Fatal(err)
	}
	selected, _, _ := r.(app.RuntimeSettings).SelectedSettings()
	if selected != "codex:fresh" {
		t.Fatal("Default kept the previous explicit choice", selected)
	}
}
