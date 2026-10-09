package app

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func userItems(bus *fakeBus, kind domain.ItemKind) []domain.Item {
	var out []domain.Item
	for _, ev := range bus.snapshot() {
		if ev.Item != nil && ev.Item.Kind == kind {
			out = append(out, *ev.Item)
		}
	}
	return out
}

func TestMessageFromMCPIsMarkedAndNotSeen(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	ctx := WithOrigin(context.Background(), domain.OriginMCP)
	snap := createClaude(t, m)
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}

	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if err := m.Steer(ctx, snap.ID, "more"); err != nil {
		t.Fatal(err)
	}
	items := userItems(bus, domain.ItemUserMessage)
	if len(items) != 2 || items[0].Origin != domain.OriginMCP || items[1].Origin != domain.OriginMCP {
		t.Fatalf("items = %+v", items)
	}
	// The owner did not write it, so they have not looked either.
	if got, _ := m.GetSession(ctx, snap.ID); !got.Seen.At.IsZero() {
		t.Fatalf("seen = %+v", got.Seen)
	}
}

func TestOwnMessageHasNoOrigin(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}

	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if items := userItems(bus, domain.ItemUserMessage); len(items) != 1 || items[0].Origin != "" {
		t.Fatalf("items = %+v", items)
	}
	if got, _ := m.GetSession(ctx, snap.ID); got.Seen.At.IsZero() {
		t.Fatal("own message should mark the session seen")
	}
}

func TestDecisionFromMCPIsMarked(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	ctx := context.Background()
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	rt.events <- requestEvent(snap.ID, "r1")
	eventually(t, "pending", func() bool { return len(m.PendingRequests(ctx)) == 1 })

	before, _ := m.GetSession(ctx, snap.ID)
	if err := m.RespondRequest(WithOrigin(ctx, domain.OriginMCP), snap.ID, "r1", RequestAnswer{Message: "no"}); err != nil {
		t.Fatal(err)
	}
	if items := userItems(bus, domain.ItemDecision); len(items) != 1 || items[0].Origin != domain.OriginMCP {
		t.Fatalf("decisions = %+v", items)
	}
	if got, _ := m.GetSession(ctx, snap.ID); got.Seen != before.Seen {
		t.Fatalf("an MCP answer marked the session seen: %+v", got.Seen)
	}
}
