package sqlite

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestHistoryPageStartsAtTailAndReconstructsSplitMessage(t *testing.T) {
	s := openTest(t)
	log := eventLog{s.db}
	ctx := context.Background()
	events := []domain.Event{
		{Seq: 1, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "parent", Kind: domain.ItemSubagent}},
		{Seq: 2, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "text", ParentItemID: "parent", Kind: domain.ItemAssistantMessage, Text: "start"}},
		{Seq: 3, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "text", Text: " middle"}},
		{Seq: 4, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "text", Text: " end"}},
		{Seq: 5, Type: domain.EventTurnEnded, Result: &domain.TurnResult{}},
	}
	for _, ev := range events {
		ev.SessionID = "s"
		if err := log.Append(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}
	page, err := log.HistoryPage(ctx, "s", 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !page.HasMore || page.Before != 4 || page.LastSeq != 5 {
		t.Fatalf("page=%+v", page)
	}
	var text string
	var parent bool
	for _, ev := range page.Events {
		if ev.Item != nil && ev.Item.ID == "text" {
			text = ev.Item.Text
		}
		if ev.Item != nil && ev.Item.ID == "parent" {
			parent = true
		}
		if ev.Delta != nil && ev.Delta.ItemID == "text" {
			text += ev.Delta.Text
		}
	}
	if text != "start middle end" || !parent {
		t.Fatalf("text=%q parent=%v", text, parent)
	}
	older, err := log.HistoryPage(ctx, "s", page.Before, 2)
	if err != nil || older.Before != 2 || !older.HasMore {
		t.Fatalf("older=%+v err=%v", older, err)
	}
	oldest, err := log.HistoryPage(ctx, "s", older.Before, 2)
	if err != nil || oldest.HasMore || oldest.Before != 1 {
		t.Fatalf("oldest=%+v err=%v", oldest, err)
	}
	empty, err := log.HistoryPage(ctx, "missing", 0, 2)
	if err != nil || empty.HasMore || len(empty.Events) != 0 {
		t.Fatalf("empty=%+v err=%v", empty, err)
	}
}

func TestHistoryPageRestoresStateAndOpenRequestsBeforeTheTail(t *testing.T) {
	s := openTest(t)
	log := eventLog{s.db}
	ctx := context.Background()
	request := &domain.Request{ID: "r", SessionID: "s"}
	for _, ev := range []domain.Event{
		{Seq: 1, Type: domain.EventTurnStarted},
		{Seq: 2, Type: domain.EventRequestOpened, Request: request},
		{Seq: 3, Type: domain.EventSessionState, Session: &domain.SessionSnapshot{ID: "s", Status: domain.StatusRunning}},
		{Seq: 4, Type: domain.EventUsage, Usage: &domain.Usage{TotalTokens: 123}},
		{Seq: 5, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "other", Text: "large old payload"}},
		{Seq: 6, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "tail"}},
	} {
		ev.SessionID = "s"
		if err := log.Append(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}
	page, err := log.HistoryPage(ctx, "s", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.Before != 6 || len(page.Events) != 5 || !page.HasMore {
		t.Fatalf("page=%+v", page)
	}
	for _, ev := range page.Events {
		if ev.Item != nil && ev.Item.ID == "other" {
			t.Fatal("loaded unrelated old payload")
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := log.HistoryPage(ctx, "s", 0, 1); err == nil {
		t.Fatal("ignored canceled request")
	}
}

func TestHistoryPageDoesNotLetQuotaPollingHideTheLatestMessage(t *testing.T) {
	s := openTest(t)
	log := eventLog{s.db}
	ctx := context.Background()
	if err := log.Append(ctx, domain.Event{SessionID: "s", Seq: 1, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "latest", Text: "answer"}}); err != nil {
		t.Fatal(err)
	}
	for seq := domain.Seq(2); seq <= 10; seq++ {
		if err := log.Append(ctx, domain.Event{SessionID: "s", Seq: seq, Type: domain.EventQuota}); err != nil {
			t.Fatal(err)
		}
	}
	if err := log.Append(ctx, domain.Event{SessionID: "s", Seq: 11, Type: domain.EventSessionState, Session: &domain.SessionSnapshot{ID: "s", Status: domain.StatusIdle}}); err != nil {
		t.Fatal(err)
	}
	page, err := log.HistoryPage(ctx, "s", 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.HasMore || page.LastSeq != 11 || page.Before != 1 || len(page.Events) != 2 || page.Events[0].Item == nil || page.Events[0].Item.Text != "answer" {
		t.Fatalf("page=%+v", page)
	}
}
