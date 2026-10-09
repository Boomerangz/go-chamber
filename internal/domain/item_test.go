package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestNewItemValidates(t *testing.T) {
	cases := []struct {
		name string
		id   ItemID
		sess SessionID
		kind ItemKind
	}{
		{"empty id", "", "s1", ItemAssistantMessage},
		{"empty session", "i1", "", ItemAssistantMessage},
		{"unknown kind", "i1", "s1", ItemKind("bogus")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewItem(tc.id, tc.sess, "t1", "", tc.kind); !errors.Is(err, ErrInvalidItem) {
				t.Fatalf("want ErrInvalidItem, got %v", err)
			}
		})
	}
}

func TestNewItemDefaultsToPending(t *testing.T) {
	it, err := NewItem("i1", "s1", "t1", "", ItemToolCall)
	if err != nil {
		t.Fatal(err)
	}
	if it.Status != ItemPending {
		t.Fatalf("status = %s, want pending", it.Status)
	}
	if it.Kind != ItemToolCall || it.ID != "i1" || it.SessionID != "s1" || it.TurnID != "t1" {
		t.Fatalf("item = %+v", it)
	}
}

func TestItemTransitions(t *testing.T) {
	it, _ := NewItem("i1", "s1", "t1", "", ItemAssistantMessage)
	if err := it.SetStatus(ItemStreaming); err != nil {
		t.Fatalf("pending->streaming: %v", err)
	}
	if err := it.SetStatus(ItemCompleted); err != nil {
		t.Fatalf("streaming->completed: %v", err)
	}
	if !it.Status.Terminal() {
		t.Fatal("completed must be terminal")
	}
	if err := it.SetStatus(ItemStreaming); !errors.Is(err, ErrInvalidItemTransition) {
		t.Fatalf("completed->streaming: want ErrInvalidItemTransition, got %v", err)
	}
}

func TestItemCannotFailBeforePending(t *testing.T) {
	it, _ := NewItem("i1", "s1", "t1", "", ItemError)
	if err := it.SetStatus(ItemFailed); err != nil {
		t.Fatalf("pending->failed: %v", err)
	}
	if it.Status != ItemFailed {
		t.Fatalf("status = %s", it.Status)
	}
}

func TestItemKindValid(t *testing.T) {
	valid := []ItemKind{
		ItemUserMessage, ItemAssistantMessage, ItemReasoning, ItemToolCall,
		ItemCommand, ItemFileChange, ItemSubagent, ItemPlan, ItemError, ItemHook, ItemDecision,
	}
	for _, k := range valid {
		if !k.Valid() {
			t.Errorf("%s should be valid", k)
		}
	}
	if ItemKind("nope").Valid() {
		t.Error("unknown kind must be invalid")
	}
}

func TestAppendTextAndDelta(t *testing.T) {
	it, _ := NewItem("i1", "s1", "t1", "", ItemAssistantMessage)
	it.AppendText("hello ")
	it.AppendText("world")
	if it.Text != "hello world" {
		t.Fatalf("text = %q", it.Text)
	}
	d := Delta{ItemID: "i1", Text: "chunk"}
	if err := d.Valid(); err != nil {
		t.Fatalf("delta should be valid: %v", err)
	}
	if err := (Delta{Text: "x"}).Valid(); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("delta without item id: want ErrInvalidItem, got %v", err)
	}
}

func TestHookItems(t *testing.T) {
	if !ItemHook.Valid() {
		t.Fatal("hook kind must be valid")
	}
	for _, o := range []HookOutcome{HookSuccess, HookBlocked, HookError} {
		if !o.Valid() {
			t.Fatalf("%q invalid", o)
		}
	}
	if HookOutcome("meh").Valid() || HookOutcome("").Valid() {
		t.Fatal("unknown outcome accepted")
	}
	item := Item{ID: "h", Kind: ItemHook, Name: "Stop", Outcome: HookBlocked}
	raw, _ := json.Marshal(item)
	if !strings.Contains(string(raw), `"outcome":"blocked"`) {
		t.Fatalf("json = %s", raw)
	}
	raw, _ = json.Marshal(Item{ID: "x", Kind: ItemCommand})
	if strings.Contains(string(raw), "outcome") {
		t.Fatalf("empty outcome serialized: %s", raw)
	}
}

func TestDecisionFor(t *testing.T) {
	cases := []struct {
		kind  RequestKind
		allow bool
		want  Decision
	}{
		{RequestPermission, true, DecisionApproved},
		{RequestPermission, false, DecisionDenied},
		{RequestQuestion, true, DecisionAnswered},
		{RequestQuestion, false, DecisionDenied},
		{RequestElicitation, true, DecisionAnswered},
	}
	for _, c := range cases {
		if got := DecisionFor(c.kind, c.allow); got != c.want {
			t.Errorf("DecisionFor(%s, %v) = %s, want %s", c.kind, c.allow, got, c.want)
		}
	}
}

func TestDecisionValid(t *testing.T) {
	for _, d := range []Decision{DecisionApproved, DecisionDenied, DecisionAnswered} {
		if !d.Valid() {
			t.Errorf("%s should be valid", d)
		}
	}
	if Decision("maybe").Valid() {
		t.Error("unknown decision must be invalid")
	}
}

func TestItemStoppedIsTerminal(t *testing.T) {
	it, _ := NewItem("i1", "s1", "t1", "", ItemSubagent)
	_ = it.SetStatus(ItemStreaming)
	if err := it.SetStatus(ItemStopped); err != nil {
		t.Fatalf("streaming->stopped: %v", err)
	}
	if !it.Status.Terminal() {
		t.Fatal("stopped must be terminal")
	}
	if err := it.SetStatus(ItemCompleted); !errors.Is(err, ErrInvalidItemTransition) {
		t.Fatalf("stopped->completed: want ErrInvalidItemTransition, got %v", err)
	}
}

func TestItemOriginSurvivesJSON(t *testing.T) {
	it, err := NewItem("i1", "s1", "t1", "", ItemUserMessage)
	if err != nil {
		t.Fatal(err)
	}
	it.Origin = OriginMCP
	raw, err := json.Marshal(it)
	if err != nil {
		t.Fatal(err)
	}
	var back Item
	if err := json.Unmarshal(raw, &back); err != nil || back.Origin != OriginMCP || !strings.Contains(string(raw), `"origin":"mcp"`) {
		t.Fatalf("raw %s, back %+v, %v", raw, back, err)
	}
}
