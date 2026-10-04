package app

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestAttachFailureAllowsRetry(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	defer m.Close()
	snap := createClaude(t, m)
	first := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{first}
	if err := m.SendMessage(context.Background(), snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle", func() bool { return currentStatus(m, snap.ID) == domain.StatusIdle })
	_ = first.Close()
	eventually(t, "detached", func() bool { return currentStatus(m, snap.ID) == domain.StatusDetached })
	factory.runtimes = []*fakeRuntime{newFakeRuntime("wrong"), newFakeRuntime("native-1")}
	if err := m.SendMessage(context.Background(), snap.ID, "two"); err == nil {
		t.Fatal("expected native mismatch")
	}
	if err := m.SendMessage(context.Background(), snap.ID, "retry"); err != nil {
		t.Fatalf("retry blocked by closed runtime: %v", err)
	}
}
