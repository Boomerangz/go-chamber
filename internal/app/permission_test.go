package app

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// modeRuntime is a runtime that can switch the permission mode live.
type modeRuntime struct {
	*fakeRuntime
	mu    sync.Mutex
	modes []string
	err   error
}

func (r *modeRuntime) SetPermissionMode(_ context.Context, mode string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.modes = append(r.modes, mode)
	return r.err
}

func (r *modeRuntime) calls() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.modes...)
}

func TestSetPermissionModeIsSavedPublishedAndUsedOnStart(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	got, err := m.SetPermissionMode(ctx, snap.ID, "plan")
	if err != nil || got.PermissionMode != "plan" {
		t.Fatalf("SetPermissionMode = %+v, %v", got, err)
	}
	if stored, _ := repo.Get(ctx, snap.ID); stored.PermissionMode != "plan" {
		t.Fatalf("stored = %+v", stored)
	}
	if last := bus.snapshot(); last[len(last)-1].Session.PermissionMode != "plan" {
		t.Fatalf("last event = %+v", last[len(last)-1])
	}
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if req := factory.requests()[0]; req.PermissionMode != "plan" {
		t.Fatalf("start request = %+v", req)
	}
}

func TestSetPermissionModeRejectsModesOfAnotherAgent(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	snap := createClaude(t, m)
	if _, err := m.SetPermissionMode(context.Background(), snap.ID, "full-access"); !errors.Is(err, domain.ErrInvalidPermissionMode) {
		t.Fatalf("err = %v", err)
	}
	if _, err := m.SetPermissionMode(context.Background(), "nope", "plan"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unknown session err = %v", err)
	}
}

func TestSetPermissionModeSwitchesLive(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := &modeRuntime{fakeRuntime: newFakeRuntime("n1")}
	startWith(t, m, factory, snap.ID, rt)
	if _, err := m.SetPermissionMode(context.Background(), snap.ID, "acceptEdits"); err != nil {
		t.Fatal(err)
	}
	if calls := rt.calls(); len(calls) != 1 || calls[0] != "acceptEdits" {
		t.Fatalf("calls = %v", calls)
	}
	if rt.isClosed() {
		t.Fatal("runtime restarted although it switched live")
	}
}

func TestSetPermissionModeKeepsTheOldModeWhenTheAgentRefuses(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	boom := errors.New("refused")
	startWith(t, m, factory, snap.ID, &modeRuntime{fakeRuntime: newFakeRuntime("n1"), err: boom})
	if _, err := m.SetPermissionMode(context.Background(), snap.ID, "plan"); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if s, _ := m.GetSession(context.Background(), snap.ID); s.PermissionMode != "" {
		t.Fatalf("mode = %q after a refused switch", s.PermissionMode)
	}
}

func TestSetPermissionModeRestartsARuntimeThatCannotSwitch(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first := &modeRuntime{fakeRuntime: newFakeRuntime("n1"), err: ErrRestartRequired}
	startWith(t, m, factory, snap.ID, first)
	endTurn(t, m, first.fakeRuntime, snap.ID)

	if _, err := m.SetPermissionMode(context.Background(), snap.ID, "bypassPermissions"); err != nil {
		t.Fatal(err)
	}
	eventually(t, "idle runtime closed", first.isClosed)
	startWith(t, m, factory, snap.ID, newFakeRuntime("n1"))
	reqs := factory.requests()
	if last := reqs[len(reqs)-1]; last.NativeID != "n1" || last.PermissionMode != "bypassPermissions" {
		t.Fatalf("restart request = %+v", last)
	}
}
