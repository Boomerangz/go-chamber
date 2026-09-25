package domain

import (
	"errors"
	"testing"
)

func TestEventValidates(t *testing.T) {
	item, _ := NewItem("i1", "s1", "t1", "", ItemAssistantMessage)
	snap := SessionSnapshot{ID: "s1", Agent: AgentClaude, Cwd: "/p"}
	req := &Request{ID: "r1", SessionID: "s1", Kind: RequestPermission, State: RequestPending}

	cases := []struct {
		name string
		ev   Event
	}{
		{"empty session", Event{Type: EventItemUpdated, Item: item}},
		{"unknown type", Event{SessionID: "s1", Type: EventType("nope")}},
		{"item event without item", Event{SessionID: "s1", Type: EventItemUpdated}},
		{"delta event without delta", Event{SessionID: "s1", Type: EventTextDelta}},
		{"session event without snapshot", Event{SessionID: "s1", Type: EventSessionState}},
		{"request event without request", Event{SessionID: "s1", Type: EventRequestOpened}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.ev.Valid(); !errors.Is(err, ErrInvalidEvent) {
				t.Fatalf("want ErrInvalidEvent, got %v", err)
			}
		})
	}

	valid := []Event{
		{SessionID: "s1", Type: EventItemUpdated, Item: item},
		{SessionID: "s1", Type: EventTextDelta, Delta: &Delta{ItemID: "i1", Text: "x"}},
		{SessionID: "s1", Type: EventSessionState, Session: &snap},
		{SessionID: "s1", Type: EventRequestOpened, Request: req},
		{SessionID: "s1", Type: EventTurnStarted},
		{SessionID: "s1", Type: EventTurnEnded},
	}
	for _, ev := range valid {
		if err := ev.Valid(); err != nil {
			t.Errorf("%s should be valid: %v", ev.Type, err)
		}
	}
}

func TestEventPayloadsRejectsEmptyDelta(t *testing.T) {
	if err := (Event{SessionID: "s1", Type: EventTextDelta, Delta: &Delta{}}).Valid(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("want ErrInvalidEvent, got %v", err)
	}
}

func TestDetachItemsCopiesItems(t *testing.T) {
	code := 1
	item := &Item{ID: "i", Text: "a", Input: []byte(`{}`), ExitCode: &code}
	events := DetachItems([]Event{{Type: EventItemUpdated, Item: item}, {Type: EventTurnEnded}})
	item.Text = "changed"
	item.Input[0] = 'x'
	code = 2
	got := events[0].Item
	if got == item || got.Text != "a" || string(got.Input) != "{}" || *got.ExitCode != 1 {
		t.Fatalf("detached item = %+v", got)
	}
	if events[1].Item != nil {
		t.Fatal("event without item got one")
	}
	if got := DetachItems([]Event{{Item: &Item{ID: "n"}}}); got[0].Item.ExitCode != nil {
		t.Fatal("nil exit code became non-nil")
	}
}
