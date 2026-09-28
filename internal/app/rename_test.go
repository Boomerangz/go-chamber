package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestRenameSessionSavesAndPublishes(t *testing.T) {
	m, repo, bus, _, _ := newTestManager(t)
	ctx := context.Background()
	snap, err := m.CreateSession(ctx, domain.AgentClaude, "/tmp/proj")
	if err != nil {
		t.Fatal(err)
	}
	got, err := m.RenameSession(ctx, snap.ID, "  Release notes  ")
	if err != nil || got.Title != "Release notes" {
		t.Fatalf("rename = %+v, %v", got, err)
	}
	if saved, _ := repo.Get(ctx, snap.ID); saved.Title != "Release notes" {
		t.Fatalf("saved title %q", saved.Title)
	}
	events := bus.snapshot()
	last := events[len(events)-1]
	if last.Type != domain.EventSessionState || last.Session.Title != "Release notes" {
		t.Fatalf("last event %+v", last)
	}
	if _, err := m.RenameSession(ctx, snap.ID, strings.Repeat("я", 201)); !errors.Is(err, ErrTitleTooLong) {
		t.Fatalf("long title err = %v", err)
	}
	if got, _ := m.RenameSession(ctx, snap.ID, " "); got.Title != "" {
		t.Fatalf("blank rename should clear, got %q", got.Title)
	}
}

func TestRenamedSessionKeepsItsTitleOnFirstMessage(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}
	ctx := context.Background()
	snap, _ := m.CreateSession(ctx, domain.AgentClaude, "/tmp/proj")
	if _, err := m.RenameSession(ctx, snap.ID, "Mine"); err != nil {
		t.Fatal(err)
	}
	if err := m.SendMessage(ctx, snap.ID, "hello there"); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.GetSession(ctx, snap.ID); got.Title != "Mine" {
		t.Fatalf("title %q", got.Title)
	}
}

func TestRenameTerminal(t *testing.T) {
	f := newTermFixture(t)
	term, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "/srv/app"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.terms.Rename(term.ID, " logs ")
	if err != nil || got.Title != "logs" {
		t.Fatalf("rename = %+v, %v", got, err)
	}
	if listed, _ := f.terms.Get(term.ID); listed.Title != "logs" {
		t.Fatalf("get title %q", listed.Title)
	}
	if got, _ := f.terms.Rename(term.ID, ""); got.Title != "app" {
		t.Fatalf("blank rename should restore the folder name, got %q", got.Title)
	}
	if _, err := f.terms.Rename(term.ID, strings.Repeat("x", 201)); !errors.Is(err, ErrTitleTooLong) {
		t.Fatalf("long title err = %v", err)
	}
	if _, err := f.terms.Rename("nope", "x"); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("missing terminal err = %v", err)
	}
}
