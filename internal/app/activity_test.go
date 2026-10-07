package app

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestSessionsRecordCreationAndLastActivity(t *testing.T) {
	clock := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	repo, factory := newMemRepo(), &fakeFactory{}
	ids := &counter{}
	m := NewManager(ManagerConfig{
		Repo: repo, Runtimes: factory, Bus: newFakeBus(),
		NewID: ids.next, Now: func() time.Time { return clock },
	})
	snap, err := m.CreateSession(context.Background(), "claude", "/p")
	if err != nil {
		t.Fatal(err)
	}
	if !snap.CreatedAt.Equal(clock) || !snap.ActiveAt.Equal(clock) {
		t.Fatalf("created snapshot = %+v", snap)
	}
	clock = clock.Add(time.Hour)
	factory.runtimes = []*fakeRuntime{newFakeRuntime("native-1")}
	if err := m.SendMessage(context.Background(), snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	saved, _ := repo.Get(context.Background(), snap.ID)
	if !saved.CreatedAt.Equal(snap.CreatedAt) || !saved.ActiveAt.Equal(clock) {
		t.Fatalf("saved after send = %+v", saved)
	}
}

func TestManagerDefaultsToWallClock(t *testing.T) {
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus()})
	snap, err := m.CreateSession(context.Background(), "claude", "/p")
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(snap.CreatedAt) > time.Minute {
		t.Fatalf("created at %v", snap.CreatedAt)
	}
}

func TestFirstMessageTitlesTheSession(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	factory.runtimes = []*fakeRuntime{newFakeRuntime("native-1")}
	long := "  Fix the folder picker:\n it submits the surrounding form when you press Enter in the filter  "
	if err := m.SendMessage(context.Background(), snap.ID, long); err != nil {
		t.Fatal(err)
	}
	saved, _ := repo.Get(context.Background(), snap.ID)
	want := "Fix the folder picker: it submits the surrounding form when…"
	if saved.Title != want {
		t.Fatalf("title = %q, want %q", saved.Title, want)
	}
}

func TestTitleFromText(t *testing.T) {
	cases := map[string]string{
		"short":                 "short",
		"  a \n\t b ":           "a b",
		"":                      "",
		"привет мир":            "привет мир",
		strings.Repeat("я", 70): strings.Repeat("я", 59) + "…",
		// a title reads as the message reads, not as it was written
		"Plan the **auth refactor** in `internal/app`":         "Plan the auth refactor in internal/app",
		"# Fix [the bug](https://x.test/1)\n- keep snake_case": "Fix the bug keep snake_case",
		// nothing but syntax: the words as typed
		"```": "```",
	}
	for in, want := range cases {
		if got := titleFromText(in); got != want {
			t.Errorf("titleFromText(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExistingTitleIsKept(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "first"); err != nil {
		t.Fatal(err)
	}
	rt.events <- domain.Event{SessionID: snap.ID, Type: domain.EventTurnEnded}
	eventually(t, "idle session", func() bool {
		s, _ := repo.Get(ctx, snap.ID)
		return s.Status == domain.StatusIdle
	})
	if err := m.SendMessage(ctx, snap.ID, "second"); err != nil {
		t.Fatal(err)
	}
	saved, _ := repo.Get(ctx, snap.ID)
	if saved.Title != "first" {
		t.Fatalf("title = %q", saved.Title)
	}
}

func TestRestorePublishesNormalizedStatus(t *testing.T) {
	repo, bus := newMemRepo(), newFakeBus()
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "run", Agent: domain.AgentClaude, Cwd: "/p", Status: domain.StatusRunning})
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "idle", Agent: domain.AgentClaude, Cwd: "/p", Status: domain.StatusIdle})
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "same", Agent: domain.AgentClaude, Cwd: "/p", Status: domain.StatusDetached})
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: bus})
	if _, err := m.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	got := map[domain.SessionID]domain.SessionStatus{}
	for _, ev := range bus.snapshot() {
		if ev.Type == domain.EventSessionState && ev.Session != nil {
			got[ev.SessionID] = ev.Session.Status
		}
	}
	want := map[domain.SessionID]domain.SessionStatus{"run": domain.StatusInterrupted, "idle": domain.StatusDetached}
	if len(got) != len(want) || got["run"] != want["run"] || got["idle"] != want["idle"] {
		t.Fatalf("published = %v", got)
	}
}
