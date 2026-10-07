package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// cliFinder knows which agents' CLIs are installed, and where.
type cliFinder map[domain.AgentKind]string

func (f cliFinder) FindCLI(agent domain.AgentKind) (string, bool) {
	p, ok := f[agent]
	return p, ok
}

type countingAccounts struct{ calls int }

func (a *countingAccounts) Account(_ context.Context, agent domain.AgentKind) (AccountInfo, error) {
	a.calls++
	return AccountInfo{Agent: agent, LoggedIn: true}, nil
}

func (a *countingAccounts) StartLogin(context.Context, domain.AgentKind) (LoginChallenge, error) {
	a.calls++
	return LoginChallenge{}, nil
}

func TestCLIsReportsEachAgent(t *testing.T) {
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		CLIs: cliFinder{domain.AgentClaude: "/usr/local/bin/claude"}})
	got := m.CLIs()
	want := []CLIStatus{
		{Agent: domain.AgentClaude, Found: true, Path: "/usr/local/bin/claude"},
		{Agent: domain.AgentCodex, Found: false, Hint: "npm install -g @openai/codex"},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("CLIs = %+v, want %+v", got, want)
	}
}

func TestCLIsWithoutAFinderAssumesInstalled(t *testing.T) {
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus()})
	all := m.CLIs()
	if len(all) != 2 {
		t.Fatalf("CLIs = %+v, want both agents", all)
	}
	for _, s := range all {
		if !s.Found {
			t.Fatalf("%s reported missing without a finder", s.Agent)
		}
	}
}

func TestCreateSessionRefusesAnAgentWithoutItsCLI(t *testing.T) {
	repo := newMemRepo()
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		CLIs: cliFinder{domain.AgentClaude: "/bin/claude"}})
	ctx := context.Background()
	if _, err := m.CreateSession(ctx, domain.AgentCodex, "/tmp/x"); !errors.Is(err, domain.ErrCLIMissing) {
		t.Fatalf("err = %v", err)
	}
	if all, _ := repo.List(ctx); len(all) != 0 {
		t.Fatalf("a session without its CLI was kept: %+v", all)
	}
	if _, err := m.CreateSession(ctx, domain.AgentClaude, "/tmp/x"); err != nil {
		t.Fatalf("installed CLI: %v", err)
	}
}

func TestSendToASessionWhoseCLIIsGoneSaysSo(t *testing.T) {
	finder := cliFinder{domain.AgentCodex: "/bin/codex"}
	factory := &fakeFactory{}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: factory, Bus: newFakeBus(), CLIs: finder})
	ctx := context.Background()
	s, err := m.CreateSession(ctx, domain.AgentCodex, "/tmp/x")
	if err != nil {
		t.Fatal(err)
	}
	delete(finder, domain.AgentCodex)
	err = m.SendMessage(ctx, s.ID, "hi")
	if !errors.Is(err, domain.ErrCLIMissing) || err.Error() != domain.CLIMissing(domain.AgentCodex).Error() {
		t.Fatalf("err = %v", err)
	}
	factory.mu.Lock()
	defer factory.mu.Unlock()
	if len(factory.reqs) != 0 {
		t.Fatalf("a runtime was started without its CLI: %+v", factory.reqs)
	}
}

func TestModelsAndQuotaRefreshOfAnAgentWithoutItsCLISaySo(t *testing.T) {
	catalog := &fakeCatalog{}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(), Models: catalog,
		QuotaProvider: &fakeQuotaProvider{}, Quotas: &fakeQuotaRepo{}, CLIs: cliFinder{}})
	ctx := context.Background()
	if _, err := m.Models(ctx, domain.AgentCodex); !errors.Is(err, domain.ErrCLIMissing) {
		t.Fatalf("Models err = %v", err)
	}
	if catalog.agent != "" {
		t.Fatal("the catalog was asked without the CLI")
	}
	if _, err := m.RefreshQuota(ctx, domain.AgentCodex); !errors.Is(err, domain.ErrCLIMissing) {
		t.Fatalf("RefreshQuota err = %v", err)
	}
}

func TestAccountOfAnAgentWithoutItsCLISaysItIsMissing(t *testing.T) {
	accounts := &countingAccounts{}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		Accounts: accounts, CLIs: cliFinder{domain.AgentClaude: "/bin/claude"}})
	ctx := context.Background()
	info, err := m.Account(ctx, domain.AgentCodex)
	if err != nil || info != (AccountInfo{Agent: domain.AgentCodex, CLIMissing: true}) {
		t.Fatalf("Account = %+v, %v", info, err)
	}
	if _, err := m.StartLogin(ctx, domain.AgentCodex); !errors.Is(err, domain.ErrCLIMissing) {
		t.Fatalf("StartLogin err = %v", err)
	}
	if accounts.calls != 0 {
		t.Fatalf("the agent was asked %d times without its CLI", accounts.calls)
	}
	if info, err := m.Account(ctx, domain.AgentClaude); err != nil || !info.LoggedIn {
		t.Fatalf("installed Account = %+v, %v", info, err)
	}
}
