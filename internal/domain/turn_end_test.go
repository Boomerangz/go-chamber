package domain

import (
	"slices"
	"testing"
)

// A turn that ended leaves nothing running but the work that outlives it
// (a background task and its steps).
func TestLeftByTurnSkipsWhatOutlivesIt(t *testing.T) {
	open := map[ItemID]Item{
		"tool":  {ID: "tool", Kind: ItemCommand, Status: ItemStreaming},
		"sub":   {ID: "sub", Kind: ItemSubagent, Status: ItemStreaming},
		"step":  {ID: "step", ParentItemID: "sub", Kind: ItemToolCall, Status: ItemPending},
		"bg":    {ID: "bg", Kind: ItemSubagent, Status: ItemStreaming, OutlivesTurn: true},
		"bgkid": {ID: "bgkid", ParentItemID: "bg", Kind: ItemCommand, Status: ItemStreaming},
		"done":  {ID: "done", Kind: ItemCommand, Status: ItemCompleted},
		"orph":  {ID: "orph", ParentItemID: "gone", Kind: ItemCommand, Status: ItemStreaming},
	}
	got := LeftByTurn(open)
	ids := make([]ItemID, 0, len(got))
	for _, it := range got {
		if it.Status != ItemStopped {
			t.Fatalf("%s is %s", it.ID, it.Status)
		}
		ids = append(ids, it.ID)
	}
	if want := []ItemID{"orph", "step", "sub", "tool"}; !slices.Equal(ids, want) {
		t.Fatalf("stopped %v, want %v", ids, want)
	}
	if open["tool"].Status != ItemStreaming {
		t.Fatal("the open items were changed in place")
	}
}

// A cycle of parents (a broken log) must not hang the walk.
func TestLeftByTurnSurvivesParentCycle(t *testing.T) {
	open := map[ItemID]Item{
		"a": {ID: "a", ParentItemID: "b", Kind: ItemCommand, Status: ItemStreaming},
		"b": {ID: "b", ParentItemID: "a", Kind: ItemCommand, Status: ItemStreaming},
	}
	if got := LeftByTurn(open); len(got) != 2 {
		t.Fatalf("got %v", got)
	}
}

func TestInterruptedWithRequest(t *testing.T) {
	s := newTestSession(t)
	s.InterruptedWithRequest()
	if s.Interruption().WithRequest {
		t.Fatal("marked a session that was not interrupted")
	}
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	mustNoErr(t, s.TurnInterrupted(ExitCrashed))
	s.InterruptedWithRequest()
	if !s.Interruption().WithRequest || s.Interruption().Reason != ExitCrashed {
		t.Fatal(s.Interruption())
	}
	restored, err := RestoreSession(s.Snapshot())
	mustNoErr(t, err)
	if !restored.Interruption().WithRequest {
		t.Fatal("lost on restore")
	}
	mustNoErr(t, s.TurnStarted())
	if s.Interruption().WithRequest {
		t.Fatal("a new turn keeps the old request mark")
	}
}
