package app

import (
	"context"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestIdleCodexDetachesAndResumesSameThread(t *testing.T) {
	m, repo, factory := newIdleManager(t, 0)
	m.cfg.CodexIdleTimeout = 20 * time.Millisecond
	t.Cleanup(m.Close)
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	first, second := newFakeRuntime("thread-1"), newFakeRuntime("thread-1")
	factory.runtimes = []*fakeRuntime{first, second}
	if err = m.SendMessage(ctx, snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	first.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle Codex released", func() bool {
		s, _ := repo.Get(ctx, snap.ID)
		return first.isClosed() && s.Status == domain.StatusDetached
	})
	if err = m.SendMessage(ctx, snap.ID, "two"); err != nil {
		t.Fatal(err)
	}
	reqs := factory.requests()
	if len(reqs) != 2 || reqs[1].NativeID != "thread-1" {
		t.Fatalf("resume requests: %+v", reqs)
	}
}

func TestIdleCodexWaitsForChild(t *testing.T) {
	m, repo, factory := newIdleManager(t, 0)
	m.cfg.CodexIdleTimeout = 20 * time.Millisecond
	t.Cleanup(m.Close)
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	parent, child := newFakeRuntime("parent"), newFakeRuntime("child")
	factory.runtimes = []*fakeRuntime{parent, child}
	if err := m.SendMessage(ctx, snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	parent.events <- domain.Event{SessionID: snap.ID, Type: domain.EventSubagentSpawned, Subagent: &domain.SubagentSpawn{ThreadID: "child"}}
	var childID domain.SessionID
	eventually(t, "child attached", func() bool {
		sessions, _ := repo.List(ctx)
		for _, s := range sessions {
			if s.ParentID == snap.ID && s.NativeID == "child" {
				childID = s.ID
				return true
			}
		}
		return false
	})
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnStarted}
	eventually(t, "child running", func() bool { s, _ := repo.Get(ctx, childID); return s.Status == domain.StatusRunning })
	parent.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	time.Sleep(80 * time.Millisecond)
	if parent.isClosed() || child.isClosed() {
		t.Fatal("unloaded a working family")
	}
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnEnded}
	eventually(t, "idle family released", func() bool { return parent.isClosed() && child.isClosed() })
}

func startCodexFamily(t *testing.T, m *Manager, repo *memRepo, factory *fakeFactory, parent, child *fakeRuntime) (domain.SessionID, domain.SessionID) {
	t.Helper()
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentCodex, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	factory.runtimes = append(factory.runtimes, parent, child)
	if err := m.SendMessage(ctx, snap.ID, "one"); err != nil {
		t.Fatal(err)
	}
	parent.events <- domain.Event{SessionID: snap.ID, Type: domain.EventSubagentSpawned, Subagent: &domain.SubagentSpawn{ThreadID: "child"}}
	var childID domain.SessionID
	eventually(t, "child attached", func() bool {
		sessions, _ := repo.List(ctx)
		for _, s := range sessions {
			if s.ParentID == snap.ID && s.NativeID == "child" {
				childID = s.ID
				return true
			}
		}
		return false
	})
	return snap.ID, childID
}

func TestChildTurnStartsAfterInterruption(t *testing.T) {
	m, repo, factory := newIdleManager(t, 0)
	t.Cleanup(m.Close)
	ctx := context.Background()
	parent, child := newFakeRuntime("parent"), newFakeRuntime("child")
	_, childID := startCodexFamily(t, m, repo, factory, parent, child)
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnStarted}
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnEnded, Result: &domain.TurnResult{InterruptionReason: domain.ExitCrashed}}
	eventually(t, "child interrupted", func() bool { s, _ := repo.Get(ctx, childID); return s.Status == domain.StatusInterrupted })
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnStarted}
	eventually(t, "child running again", func() bool { s, _ := repo.Get(ctx, childID); return s.Status == domain.StatusRunning })
}

func TestIdleCodexChildIsReattachedWhenRootResumes(t *testing.T) {
	m, repo, factory := newIdleManager(t, 0)
	m.cfg.CodexIdleTimeout = 20 * time.Millisecond
	t.Cleanup(m.Close)
	ctx := context.Background()
	parent, child := newFakeRuntime("parent"), newFakeRuntime("child")
	rootID, childID := startCodexFamily(t, m, repo, factory, parent, child)
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnStarted}
	child.events <- domain.Event{SessionID: childID, Type: domain.EventTurnEnded}
	time.Sleep(60 * time.Millisecond)
	if child.isClosed() && !parent.isClosed() {
		t.Fatal("child unloaded while its root stayed loaded")
	}
	parent.events <- domain.Event{SessionID: rootID, Type: domain.EventTurnEnded}
	eventually(t, "family released", func() bool { return parent.isClosed() && child.isClosed() })

	resumed, reattached := newFakeRuntime("parent"), newFakeRuntime("child")
	factory.runtimes = append(factory.runtimes, resumed, reattached)
	if err := m.SendMessage(ctx, rootID, "two"); err != nil {
		t.Fatal(err)
	}
	resumed.events <- domain.Event{SessionID: rootID, Type: domain.EventSubagentSpawned, Subagent: &domain.SubagentSpawn{ThreadID: "child"}}
	eventually(t, "same child reattached", func() bool {
		s, _ := repo.Get(ctx, childID)
		return s.Status != domain.StatusDetached
	})
	sessions, _ := repo.List(ctx)
	if len(sessions) != 2 {
		t.Fatalf("sessions = %+v", sessions)
	}
}
