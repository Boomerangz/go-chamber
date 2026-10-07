package app

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func itemEvent(session domain.SessionID, id domain.ItemID, kind domain.ItemKind, status domain.ItemStatus) domain.Event {
	return domain.Event{SessionID: session, Type: domain.EventItemUpdated, Item: &domain.Item{ID: id, SessionID: session, Kind: kind, Status: status}}
}

// stoppedItems lists the item ids published as stopped, in order, and
// whether each came before the turn's end.
func stoppedItems(bus *fakeBus) (ids []domain.ItemID, beforeEnd bool) {
	beforeEnd = true
	ended := false
	for _, ev := range bus.snapshot() {
		switch {
		case ev.Type == domain.EventTurnEnded:
			ended = true
		case ev.Type == domain.EventItemUpdated && ev.Item.Status == domain.ItemStopped:
			ids = append(ids, ev.Item.ID)
			beforeEnd = beforeEnd && !ended
		}
	}
	return ids, beforeEnd
}

func runTurn(t *testing.T, agent domain.AgentKind) (*Manager, *fakeBus, *fakeRuntime, domain.SessionID) {
	t.Helper()
	m, _, bus, factory, _ := newTestManager(t)
	t.Cleanup(m.Close)
	snap, err := m.CreateSession(context.Background(), agent, "/p")
	if err != nil {
		t.Fatal(err)
	}
	rt := newFakeRuntime("native")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(context.Background(), snap.ID, "go"); err != nil {
		t.Fatal(err)
	}
	return m, bus, rt, snap.ID
}

// A turn cut short (stopped, interrupted, failed) leaves no tool or
// subagent reading "running": the app stops them, whichever agent ran it,
// before the turn's end is published. Background work keeps running.
func TestTurnEndStopsWhatItLeftRunning(t *testing.T) {
	for name, result := range map[string]*domain.TurnResult{
		"interrupted": {InterruptionReason: domain.ExitCrashed, IsError: true},
		"failed":      {IsError: true, Error: "boom"},
		"stopped":     {Stopped: true},
	} {
		t.Run(name, func(t *testing.T) {
			m, bus, rt, id := runTurn(t, domain.AgentCodex)
			rt.events <- itemEvent(id, "sub", domain.ItemSubagent, domain.ItemStreaming)
			rt.events <- itemEvent(id, "tool", domain.ItemCommand, domain.ItemStreaming)
			rt.events <- itemEvent(id, "done", domain.ItemCommand, domain.ItemStreaming)
			rt.events <- itemEvent(id, "done", domain.ItemCommand, domain.ItemCompleted)
			bg := itemEvent(id, "bg", domain.ItemSubagent, domain.ItemStreaming)
			bg.Item.OutlivesTurn = true
			rt.events <- bg
			rt.events <- domain.Event{SessionID: id, Type: domain.EventTurnEnded, Result: result}
			eventually(t, "turn ended", func() bool { return currentStatus(m, id) != domain.StatusRunning })
			ids, before := stoppedItems(bus)
			if len(ids) != 2 || ids[0] != "sub" || ids[1] != "tool" || !before {
				t.Fatalf("stopped %v (before end: %v)", ids, before)
			}
		})
	}
}

// A turn that completed normally is left as the agent reported it.
func TestCompletedTurnLeavesItems(t *testing.T) {
	m, bus, rt, id := runTurn(t, domain.AgentCodex)
	rt.events <- itemEvent(id, "tool", domain.ItemCommand, domain.ItemStreaming)
	rt.events <- domain.Event{SessionID: id, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: "ok"}}
	eventually(t, "turn ended", func() bool { return currentStatus(m, id) != domain.StatusRunning })
	if ids, _ := stoppedItems(bus); len(ids) != 0 {
		t.Fatalf("stopped %v", ids)
	}
}

// The turn the owner stopped says so in its result, even when the agent's
// own result doesn't (Claude ends it like any other); its items stop.
func TestOwnerStopMarksTheTurn(t *testing.T) {
	m, bus, rt, id := runTurn(t, domain.AgentClaude)
	rt.events <- itemEvent(id, "tool", domain.ItemCommand, domain.ItemStreaming)
	eventually(t, "item seen", func() bool { return len(bus.snapshot()) >= 3 })
	if err := m.Interrupt(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: id, Type: domain.EventTurnEnded, Result: &domain.TurnResult{Text: ""}}
	eventually(t, "turn ended", func() bool { return currentStatus(m, id) != domain.StatusRunning })
	var result *domain.TurnResult
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventTurnEnded {
			result = ev.Result
		}
	}
	if result == nil || !result.Stopped {
		t.Fatalf("result = %+v", result)
	}
	if ids, _ := stoppedItems(bus); len(ids) != 1 || ids[0] != "tool" {
		t.Fatalf("stopped %v", ids)
	}
	// The next turn is not "stopped" by the old request.
	if err := m.SendMessage(context.Background(), id, "again"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: id, Type: domain.EventTurnEnded}
	eventually(t, "second turn ended", func() bool {
		n := 0
		for _, ev := range bus.snapshot() {
			if ev.Type == domain.EventTurnEnded {
				n++
				result = ev.Result
			}
		}
		return n == 2
	})
	if result != nil && result.Stopped {
		t.Fatal("the next turn inherited the stop")
	}
}

// A runtime that died with a question open leaves an interrupted turn the
// owner still owes an answer to.
func TestCrashWithOpenRequestIsMarked(t *testing.T) {
	m, _, rt, id := runTurn(t, domain.AgentClaude)
	ev := requestEvent(id, "r1")
	ev.Request.Title = "Run tests"
	rt.events <- ev
	eventually(t, "request pending", func() bool { return len(m.PendingRequests(context.Background())) == 1 })
	_ = rt.Close()
	eventually(t, "interrupted", func() bool { return currentStatus(m, id) == domain.StatusInterrupted })
	snap, _ := m.GetSession(context.Background(), id)
	if !snap.Interruption.WithRequest || snap.Interruption.Request != "Run tests" {
		t.Fatalf("interruption = %+v", snap.Interruption)
	}
}

// After a restart, the turn that was running stops what it left running in
// the log, and remembers it was waiting for the owner.
func TestRestoreStopsLeftoverItems(t *testing.T) {
	repo, bus := newMemRepo(), newFakeBus()
	seq := domain.Seq(0)
	at := func(ev domain.Event) domain.Event { seq++; ev.Seq = seq; return ev }
	tool := at(itemEvent("run", "tool", domain.ItemCommand, domain.ItemStreaming))
	done := at(itemEvent("run", "done", domain.ItemCommand, domain.ItemStreaming))
	doneEnd := at(itemEvent("run", "done", domain.ItemCommand, domain.ItemCompleted))
	question := at(requestEvent("run", "q1"))
	question.Request.Prompt = "Which branch?"
	history := fakeHistory{"run": {tool, done, doneEnd, question}, "idle": {at(itemEvent("idle", "x", domain.ItemCommand, domain.ItemStreaming))}}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: bus, History: history})
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "run", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusRunning})
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "idle", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n", Status: domain.StatusDetached})
	snaps, err := m.Restore(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ids, _ := stoppedItems(bus)
	if len(ids) != 1 || ids[0] != "tool" {
		t.Fatalf("stopped %v", ids)
	}
	for _, s := range snaps {
		if s.ID == "run" && !s.Interruption.WithRequest {
			t.Fatalf("run: %+v", s.Interruption)
		}
	}
	stored, _ := repo.Get(ctx, "run")
	if !stored.Interruption.WithRequest || stored.Interruption.Reason != domain.ExitServerRestart || stored.Interruption.Request != "Which branch?" {
		t.Fatalf("stored %+v", stored.Interruption)
	}
}
