package app

import (
	"context"
	"github.com/igorzygin/go-chamber/internal/domain"
	"testing"
)

func TestSaveFailureAllowsRetry(t *testing.T) {
	repo := &flakyRepo{memRepo: newMemRepo(), failAt: 2}
	rt := newFakeRuntime("native")
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{runtimes: []*fakeRuntime{rt}}, Bus: newFakeBus()})
	defer m.Close()
	snap, err := m.CreateSession(context.Background(), domain.AgentClaude, "/p")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(context.Background(), snap.ID, "hello"); err == nil {
		t.Fatal("expected save failure")
	}
	if err := m.SendMessage(context.Background(), snap.ID, "retry"); err != nil {
		t.Fatalf("retry permanently blocked: %v", err)
	}
}
