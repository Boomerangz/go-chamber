package openai

import (
	"context"
	"crypto/rand"
	"errors"
	"sync"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type NativeAccounts struct {
	Auth       *CodexAuth
	OpenRouter CredentialSource
	Context    context.Context
	OnLogin    func()
	mu         sync.Mutex
	cancel     context.CancelFunc
}

func (a *NativeAccounts) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	info := app.AccountInfo{Agent: agent, AuthMode: "Codex subscription"}
	if agent != domain.AgentNative {
		return info, app.ErrAccountsUnsupported
	}
	if a.OpenRouter != nil {
		if credential, err := a.OpenRouter.Credential(ctx); err == nil && credential.Token != "" {
			info.Providers = append(info.Providers, "openrouter")
		}
	}
	if a.Auth == nil {
		return info, nil
	}
	_, err := a.Auth.Credential(ctx)
	if errors.Is(err, ErrNotLoggedIn) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	info.LoggedIn = true
	info.Providers = append(info.Providers, "codex")
	return info, nil
}
func (a *NativeAccounts) StartLogin(ctx context.Context, agent domain.AgentKind) (app.LoginChallenge, error) {
	if agent != domain.AgentNative || a.Auth == nil {
		return app.LoginChallenge{}, app.ErrAccountsUnsupported
	}
	challenge, err := a.Auth.Begin(ctx)
	if err != nil {
		return app.LoginChallenge{}, err
	}
	lifecycle := a.Context
	if lifecycle == nil {
		lifecycle = context.Background()
	}
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
	}
	background, cancel := context.WithCancel(lifecycle)
	a.cancel = cancel
	a.mu.Unlock()
	go func() {
		defer cancel()
		if err := a.Auth.Complete(background, challenge); err == nil && a.OnLogin != nil {
			a.OnLogin()
		}
	}()
	return app.LoginChallenge{LoginID: rand.Text(), UserCode: challenge.UserCode, URL: challenge.URL}, nil
}
