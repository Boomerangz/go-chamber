package app

import (
	"context"
	"testing"
	"time"
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
