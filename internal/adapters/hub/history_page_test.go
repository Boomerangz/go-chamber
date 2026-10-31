package hub

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type pagedLog struct {
	memLog
	called bool
	page   app.HistoryPage
	err    error
}

func (l *pagedLog) HistoryPage(context.Context, domain.SessionID, domain.Seq, int) (app.HistoryPage, error) {
	l.called = true
	return l.page, l.err
}

func TestHistoryPageUsesPagerAndReturnsErrors(t *testing.T) {
	l := &pagedLog{page: app.HistoryPage{Before: 42}}
	h := NewLogged(l, nil)
	page, err := h.HistoryPage(context.Background(), "s", 0, 2)
	if err != nil || page.Before != 42 || !l.called {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	l.err = errors.New("read failed")
	if _, err = h.HistoryPage(context.Background(), "s", 0, 2); !errors.Is(err, l.err) {
		t.Fatal(err)
	}
}

func TestHistoryPageFallbackCompletesItemsAndLostEvents(t *testing.T) {
	for _, logged := range []bool{false, true} {
		h := New()
		l := &memLog{}
		if logged {
			h = NewLogged(l, nil)
		}
		for _, ev := range []domain.Event{
			{Type: domain.EventItemUpdated, Item: &domain.Item{ID: "parent", Kind: domain.ItemSubagent}},
			{Type: domain.EventItemUpdated, Item: &domain.Item{ID: "text", ParentItemID: "parent", Text: "one"}},
			{Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "text", Text: " two"}},
			{Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "text", Text: " three"}},
		} {
			ev.SessionID = "s"
			h.Publish(ev)
		}
		if logged {
			l.appendErr = errors.New("write failed")
		}
		h.Publish(domain.Event{SessionID: "s", Type: domain.EventTurnEnded})
		page, err := h.HistoryPage(context.Background(), "s", 0, 2)
		if err != nil || page.Before != 4 || !page.HasMore || page.LastSeq != 5 || len(page.Events) != 4 {
			t.Fatalf("logged=%v page=%+v err=%v", logged, page, err)
		}
		if page.Events[1].Item.Text != "one two" {
			t.Fatal(page.Events)
		}
		if all := h.History("s", 0); all[1].Item.Text != "one" {
			t.Fatal("modified the hub's original item")
		}
		older, err := h.HistoryPage(context.Background(), "s", page.Before, 10)
		if err != nil || older.Before != 1 || older.HasMore {
			t.Fatalf("older=%+v err=%v", older, err)
		}
		empty, err := h.HistoryPage(context.Background(), "s", 1, 10)
		if err != nil || len(empty.Events) != 0 {
			t.Fatalf("empty=%+v err=%v", empty, err)
		}
		if logged {
			l.readErr = errors.New("read failed")
			if _, err = h.HistoryPage(context.Background(), "s", 0, 2); !errors.Is(err, l.readErr) {
				t.Fatal(err)
			}
		}
	}
}
