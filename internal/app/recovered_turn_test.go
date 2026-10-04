package app

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestRecoveredCodexTurnContinuable(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	defer m.Close()
	snap, err := m.CreateSession(context.Background(), domain.AgentCodex, "/p")
	if err != nil {
		t.Fatal(err)
	}
	rt := newFakeRuntime("native")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{InterruptionReason: domain.ExitCrashed, IsError: true, Error: "codex app-server restarted; the turn was interrupted"}}
	eventually(t, "turn ended", func() bool { return currentStatus(m, snap.ID) != domain.StatusRunning })
	if err := m.Continue(context.Background(), snap.ID); err != nil {
		t.Fatalf("interrupted turn cannot continue: %v", err)
	}
}
