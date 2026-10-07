// Package router dispatches a session's StartRequest to the AgentRuntime
// factory for its agent, keeping app and cmd free of agent-selection logic.
package router

import (
	"context"
	"fmt"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Router is an app.RuntimeFactory that delegates by agent kind.
type Router struct {
	Claude   app.RuntimeFactory
	Codex    app.RuntimeFactory
	OpenCode app.RuntimeFactory
	// Accounts handles login for agents that support it (Codex). Claude
	// manages its own login through `claude login`.
	Accounts app.AccountManager
	// Quotas fetches live rate limits for agents that expose them (Codex).
	Quotas app.QuotaProvider
}

// RateLimits implements app.QuotaProvider.
func (r *Router) RateLimits(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, error) {
	if agent == domain.AgentCodex && r.Quotas != nil {
		return r.Quotas.RateLimits(ctx, agent)
	}
	return domain.QuotaSnapshot{}, app.ErrQuotasUnsupported
}

// Account implements app.AccountManager.
func (r *Router) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	if agent == domain.AgentOpenCode {
		if accounts, ok := r.OpenCode.(app.AccountManager); ok {
			return accounts.Account(ctx, agent)
		}
		return app.AccountInfo{}, app.ErrAccountsUnsupported
	}
	if agent == domain.AgentCodex {
		if r.Accounts == nil {
			return app.AccountInfo{}, app.ErrAccountsUnsupported
		}
		return r.Accounts.Account(ctx, agent)
	}
	return app.AccountInfo{Agent: agent, LoggedIn: true, AuthMode: "cli"}, nil
}

// StartLogin implements app.AccountManager.
func (r *Router) StartLogin(ctx context.Context, agent domain.AgentKind) (app.LoginChallenge, error) {
	if agent == domain.AgentCodex && r.Accounts != nil {
		return r.Accounts.StartLogin(ctx, agent)
	}
	return app.LoginChallenge{}, app.ErrAccountsUnsupported
}

// Models asks the agent's runtime factory for its model catalog.
func (r *Router) Models(ctx context.Context, agent domain.AgentKind) ([]app.ModelInfo, error) {
	if catalog, ok := r.factory(agent).(app.ModelCatalog); ok {
		return catalog.Models(ctx, agent)
	}
	return nil, app.ErrModelsUnsupported
}

// Commands asks the agent's runtime factory for its composer commands.
func (r *Router) Commands(ctx context.Context, agent domain.AgentKind, cwd string) ([]app.Command, error) {
	if catalog, ok := r.factory(agent).(app.CommandCatalog); ok {
		return catalog.Commands(ctx, agent, cwd)
	}
	return nil, app.ErrCommandsUnsupported
}

func (r *Router) factory(agent domain.AgentKind) app.RuntimeFactory {
	switch agent {
	case domain.AgentClaude:
		return r.Claude
	case domain.AgentCodex:
		return r.Codex
	case domain.AgentOpenCode:
		return r.OpenCode
	}
	return nil
}

func (r *Router) Start(ctx context.Context, req app.StartRequest) (app.AgentRuntime, error) {
	if !req.Agent.Valid() {
		return nil, fmt.Errorf("router: unknown agent %q", req.Agent)
	}
	factory := r.factory(req.Agent)
	if factory == nil {
		return nil, fmt.Errorf("router: no runtime for %s", req.Agent)
	}
	return factory.Start(ctx, req)
}

var _ app.RuntimeFactory = (*Router)(nil)
var _ app.AccountManager = (*Router)(nil)
var _ app.QuotaProvider = (*Router)(nil)
var _ app.CommandCatalog = (*Router)(nil)

func (r *Router) ModelsInFolder(ctx context.Context, agent domain.AgentKind, cwd string) ([]app.ModelInfo, error) {
	if catalog, ok := r.factory(agent).(app.FolderModelCatalog); ok {
		return catalog.ModelsInFolder(ctx, agent, cwd)
	}
	return r.Models(ctx, agent)
}
