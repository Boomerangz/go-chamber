// Package native binds the native agent loop to provider and workspace ports.
package native

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type Provider struct {
	Client  app.ModelClient
	Catalog app.InferenceModelCatalog
}
type Factory struct {
	Repo         app.ConversationRepo
	Providers    map[string]Provider
	Tools        func(string) (app.NativeTools, error)
	Instructions func(string) (string, error)
	Accounts     app.AccountManager
	LoadImages   func(context.Context, []app.Image) ([]domain.ModelImage, error)
	mu           sync.Mutex
	caches       map[string]*app.ModelCache
	runtimes     map[string]*app.NativeRuntime
	closed       bool
	taskMu       sync.Mutex
	startMu      sync.Mutex
	tasks        map[string]string
}

func (f *Factory) Models(ctx context.Context, agent domain.AgentKind) ([]app.ModelInfo, error) {
	return f.models(ctx, agent, false)
}
func (f *Factory) RefreshModels(ctx context.Context, agent domain.AgentKind) ([]app.ModelInfo, error) {
	return f.models(ctx, agent, true)
}
func (f *Factory) InvalidateModels() { f.mu.Lock(); f.caches = nil; f.mu.Unlock() }
func (f *Factory) models(ctx context.Context, agent domain.AgentKind, force bool) ([]app.ModelInfo, error) {
	if agent != domain.AgentNative {
		return nil, app.ErrModelsUnsupported
	}
	f.mu.Lock()
	if f.caches == nil {
		f.caches = map[string]*app.ModelCache{}
		for name, p := range f.Providers {
			f.caches[name] = app.NewModelCache(p.Catalog, 0, nil)
		}
	}
	caches := f.caches
	f.mu.Unlock()
	names := make([]string, 0, len(caches))
	for name := range caches {
		names = append(names, name)
	}
	sort.Strings(names)
	var models []app.ModelInfo
	var failures []error
	for _, name := range names {
		snapshot, err := caches[name].List(ctx, force)
		if err != nil {
			failures = append(failures, err)
		}
		for _, m := range snapshot.Models {
			m.ID = name + ":" + m.ID
			m.Provider = name
			m.Stale = snapshot.Stale
			m.CatalogUpdatedAt = snapshot.UpdatedAt
			models = append(models, m)
		}
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("no native models available: %w", errors.Join(failures...))
	}
	return models, nil
}
func (f *Factory) Start(ctx context.Context, req app.StartRequest) (app.AgentRuntime, error) {
	f.startMu.Lock()
	defer f.startMu.Unlock()
	if req.Agent != domain.AgentNative {
		return nil, errors.New("native factory received another agent")
	}
	f.mu.Lock()
	existing := f.runtimes[req.NativeID]
	closed := f.closed
	f.mu.Unlock()
	if closed {
		return nil, errors.New("native factory closed")
	}
	if existing != nil && !req.Fork {
		if req.Passive {
			return existing, nil
		}
		return nil, errors.New("native conversation already attached")
	}
	conversation := domain.Conversation{ID: rand.Text()}
	if req.NativeID != "" {
		var err error
		conversation, err = f.Repo.LoadConversation(ctx, req.NativeID)
		if err != nil {
			return nil, err
		}
		if req.Fork {
			conversation.ID = rand.Text()
			conversation.Parent = ""
			conversation.Depth = 0
			conversation.PendingPrompt = ""
			conversation.Busy = false
		}
	}
	selected := req.Model
	if selected == "" && req.Passive {
		selected = conversation.Model
	}
	models, catalogErr := f.Models(ctx, domain.AgentNative)
	if selected == "" {
		if catalogErr != nil {
			return nil, catalogErr
		}
		selected = models[0].ID
	}

	window := 0
	for _, m := range models {
		if m.ID == selected {
			window = m.ContextWindow
			break
		}
	}
	provider, model, ok := strings.Cut(selected, ":")
	if !ok || model == "" || f.Providers[provider].Client == nil {
		return nil, errors.New("native model must name a configured provider and model")
	}
	// Validate against the selected provider only. A different provider's healthy
	// catalog cannot prove this provider removed a model during its own outage.
	f.mu.Lock()
	cache := f.caches[provider]
	f.mu.Unlock()
	if cache != nil {
		snapshot, err := cache.List(ctx, false)
		if err == nil {
			found := false
			for _, m := range snapshot.Models {
				if m.ID == model {
					found = true
					break
				}
			}
			if !found {
				return nil, errors.New("selected model is no longer listed; choose another model")
			}
		}
	}

	if conversation.Model != "" && conversation.Model != selected {
		for i := range conversation.Messages {
			conversation.Messages[i].Replay = domain.ModelReplay{}
		}
	}
	conversation.Model = selected
	if !req.Passive {
		conversation.PermissionMode = req.PermissionMode
	}
	if !req.Passive || req.Effort != "" {
		conversation.Effort = req.Effort
	}
	tools, err := f.Tools(req.Cwd)
	if err != nil {
		return nil, err
	}
	attached := false
	defer func() {
		if !attached {
			if closer, ok := tools.(io.Closer); ok {
				_ = closer.Close()
			}
		}
	}()
	instructions := "You are a coding assistant working in the user's workspace. Use tools to inspect files before editing. Respect AGENTS.md and user permissions. Never retry an unknown tool outcome without inspecting state."
	if f.Instructions != nil {
		extra, loadErr := f.Instructions(req.Cwd)
		if loadErr != nil {
			return nil, loadErr
		}
		instructions += "\n\n" + extra
	}
	if conversation.Busy && !req.Passive {
		conversation.Busy = false
		conversation.PendingPrompt = ""
		conversation.LastError = "Previous turn was interrupted; inspect unknown tool outcomes before retrying."
	}
	if err = f.Repo.SaveConversation(ctx, conversation); err != nil {
		return nil, err
	}
	if conversation.Parent != "" {
		f.taskMu.Lock()
		if f.tasks == nil {
			f.tasks = map[string]string{}
		}
		f.tasks[conversation.ID] = conversation.Parent
		f.taskMu.Unlock()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil, errors.New("native factory closed")
	}
	if f.runtimes == nil {
		f.runtimes = map[string]*app.NativeRuntime{}
	}
	if f.runtimes[conversation.ID] != nil {
		return nil, errors.New("native conversation already attached")
	}
	id := conversation.ID
	metadata := conversation
	metadata.Messages = nil
	wrapped := &taskTools{base: tools, factory: f, parent: metadata, cwd: req.Cwd}
	pending := conversation.PendingPrompt
	conversation.PendingPrompt = ""
	runtime := app.NewNativeRuntime(app.NativeRuntimeConfig{SessionID: req.SessionID, Conversation: conversation, Model: profileClient{f.Providers}, Tools: wrapped, Repo: f.Repo, Instructions: instructions, ContextWindow: window, LoadImages: f.LoadImages, PermissionMode: conversation.PermissionMode, OnInterrupt: func() { f.interruptChildren(id) }, StopTask: func(ctx context.Context, child string) error {
		args, _ := json.Marshal(map[string]string{"id": child})
		_, err := wrapped.Execute(ctx, domain.ModelToolCall{Name: "stop_agent", Arguments: args})
		return err
	}, OnClose: func() {
		f.mu.Lock()
		delete(f.runtimes, id)
		f.mu.Unlock()
		if closer, ok := tools.(io.Closer); ok {
			_ = closer.Close()
		}
	}})
	f.runtimes[id] = runtime
	wrapped.emit = runtime.Emit
	if req.Passive && pending != "" {
		turn := domain.TurnID(rand.Text())
		runtime.Emit(domain.Event{Type: domain.EventItemUpdated, Item: &domain.Item{ID: domain.ItemID(rand.Text()), SessionID: req.SessionID, TurnID: turn, Kind: domain.ItemUserMessage, Status: domain.ItemCompleted, Text: pending}})
		if err := runtime.Send(ctx, turn, pending); err != nil {
			delete(f.runtimes, id)
			return nil, err
		}
	}
	attached = true
	return runtime, nil
}
func (f *Factory) Close() error {
	f.mu.Lock()
	f.closed = true
	runtimes := make([]*app.NativeRuntime, 0, len(f.runtimes))
	for _, r := range f.runtimes {
		runtimes = append(runtimes, r)
	}
	f.mu.Unlock()
	for _, r := range runtimes {
		_ = r.Close()
	}
	return nil
}
func (f *Factory) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	if f.Accounts == nil {
		return app.AccountInfo{Agent: agent}, app.ErrAccountsUnsupported
	}
	return f.Accounts.Account(ctx, agent)
}
func (f *Factory) StartLogin(ctx context.Context, agent domain.AgentKind) (app.LoginChallenge, error) {
	if f.Accounts == nil {
		return app.LoginChallenge{}, app.ErrAccountsUnsupported
	}
	return f.Accounts.StartLogin(ctx, agent)
}

type profileClient struct{ providers map[string]Provider }

func (p profileClient) Stream(ctx context.Context, request domain.ModelRequest, emit func(domain.ModelDelta) error) (domain.ModelResult, error) {
	name, model, ok := strings.Cut(request.Model, ":")
	provider := p.providers[name]
	if !ok || provider.Client == nil {
		return domain.ModelResult{}, errors.New("native provider not configured")
	}
	request.Model = model
	return provider.Client.Stream(ctx, request, emit)
}

var _ app.RuntimeFactory = (*Factory)(nil)
var _ app.ModelCatalog = (*Factory)(nil)

func (f *Factory) Commands(ctx context.Context, agent domain.AgentKind, _ string) ([]app.Command, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if agent != domain.AgentNative {
		return nil, app.ErrCommandsUnsupported
	}
	return []app.Command{{Name: "compact", Insert: "/compact", Description: "Summarize earlier context while preserving recent tool results"}}, nil
}
