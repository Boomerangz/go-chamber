package router

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type stubRuntime struct{ name string }

func (s stubRuntime) NativeID() string                                  { return s.name }
func (s stubRuntime) Events() <-chan domain.Event                       { return nil }
func (s stubRuntime) Send(context.Context, domain.TurnID, string) error { return nil }
func (s stubRuntime) Steer(context.Context, string) error               { return nil }
func (s stubRuntime) StopTask(context.Context, string) error            { return nil }
func (s stubRuntime) Interrupt(context.Context) error                   { return nil }
func (s stubRuntime) Respond(context.Context, domain.RequestID, app.RequestAnswer) error {
	return nil
}
func (s stubRuntime) Close() error { return nil }

type stubFactory struct {
	name string
	got  *app.StartRequest
}

func (f *stubFactory) Start(_ context.Context, req app.StartRequest) (app.AgentRuntime, error) {
	f.got = &req
	return stubRuntime{name: f.name}, nil
}

func TestRouterDispatchesByAgent(t *testing.T) {
	claude := &stubFactory{name: "claude"}
	codex := &stubFactory{name: "codex"}
	r := &Router{Claude: claude, Codex: codex}

	rt, err := r.Start(context.Background(), app.StartRequest{Agent: domain.AgentClaude})
	if err != nil || rt.NativeID() != "claude" || claude.got == nil || codex.got != nil {
		t.Fatalf("claude dispatch: %v %v", rt, err)
	}
	rt, err = r.Start(context.Background(), app.StartRequest{Agent: domain.AgentCodex})
	if err != nil || rt.NativeID() != "codex" || codex.got == nil {
		t.Fatalf("codex dispatch: %v %v", rt, err)
	}
}

func TestRouterRejectsUnknownAgent(t *testing.T) {
	r := &Router{}
	if _, err := r.Start(context.Background(), app.StartRequest{Agent: domain.AgentKind("gemini")}); err == nil {
		t.Fatal("want error for unknown agent")
	}
}

func TestRouterReportsMissingFactory(t *testing.T) {
	r := &Router{}
	if _, err := r.Start(context.Background(), app.StartRequest{Agent: domain.AgentClaude}); err == nil {
		t.Fatal("want error without claude factory")
	}
	if _, err := r.Start(context.Background(), app.StartRequest{Agent: domain.AgentCodex}); err == nil {
		t.Fatal("want error without codex factory")
	}
}

type stubAccounts struct {
	info      app.AccountInfo
	challenge app.LoginChallenge
	err       error
}

func (s *stubAccounts) Account(context.Context, domain.AgentKind) (app.AccountInfo, error) {
	return s.info, s.err
}
func (s *stubAccounts) StartLogin(context.Context, domain.AgentKind) (app.LoginChallenge, error) {
	return s.challenge, s.err
}

func TestRouterAccounts(t *testing.T) {
	accounts := &stubAccounts{
		info:      app.AccountInfo{LoggedIn: true, Email: "a@b.c"},
		challenge: app.LoginChallenge{UserCode: "CODE"},
	}
	r := &Router{Accounts: accounts}
	ctx := context.Background()

	if info, err := r.Account(ctx, domain.AgentClaude); err != nil || !info.LoggedIn || info.AuthMode != "cli" {
		t.Fatalf("claude account = %+v, %v", info, err)
	}
	if info, err := r.Account(ctx, domain.AgentCodex); err != nil || info.Email != "a@b.c" {
		t.Fatalf("codex account = %+v, %v", info, err)
	}
	if ch, err := r.StartLogin(ctx, domain.AgentCodex); err != nil || ch.UserCode != "CODE" {
		t.Fatalf("codex login = %+v, %v", ch, err)
	}
	if _, err := r.StartLogin(ctx, domain.AgentClaude); !errors.Is(err, app.ErrAccountsUnsupported) {
		t.Fatalf("claude login err = %v", err)
	}
}

func TestRouterAccountsUnsupported(t *testing.T) {
	r := &Router{}
	if _, err := r.Account(context.Background(), domain.AgentCodex); !errors.Is(err, app.ErrAccountsUnsupported) {
		t.Fatalf("err = %v", err)
	}
	if _, err := r.StartLogin(context.Background(), domain.AgentCodex); !errors.Is(err, app.ErrAccountsUnsupported) {
		t.Fatalf("err = %v", err)
	}
}

type stubQuotas struct{ q domain.QuotaSnapshot }

func (s *stubQuotas) RateLimits(context.Context, domain.AgentKind) (domain.QuotaSnapshot, error) {
	return s.q, nil
}

func TestRouterRateLimits(t *testing.T) {
	r := &Router{Quotas: &stubQuotas{q: domain.QuotaSnapshot{Plan: "plus"}}}
	q, err := r.RateLimits(context.Background(), domain.AgentCodex)
	if err != nil || q.Plan != "plus" {
		t.Fatalf("quota = %+v, %v", q, err)
	}
	if _, err := r.RateLimits(context.Background(), domain.AgentClaude); !errors.Is(err, app.ErrQuotasUnsupported) {
		t.Fatalf("claude err = %v", err)
	}
	if _, err := (&Router{}).RateLimits(context.Background(), domain.AgentCodex); !errors.Is(err, app.ErrQuotasUnsupported) {
		t.Fatalf("no provider err = %v", err)
	}
}
