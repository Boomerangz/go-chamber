package sqlite

import (
	"context"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestMessageTextLookupUsesDeltaIndex(t *testing.T) {
	s := openTest(t)
	rows, err := s.db.Query("EXPLAIN QUERY PLAN "+messageTextSQL, "s", "i")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	indexed := false
	for rows.Next() {
		var id, parent, unused int
		var plan string
		if err := rows.Scan(&id, &parent, &unused, &plan); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(plan, "USING INDEX events_deltas (session_id=? AND item_id=?)") {
			indexed = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !indexed {
		t.Fatal("message text reconstruction reads the session history instead of its delta index")
	}
}

func TestMessageTextReconstructionOrdersOnlyMatchingDeltas(t *testing.T) {
	s := openTest(t)
	log := s.Events()
	ctx := context.Background()
	for _, ev := range []domain.Event{
		{SessionID: "s", Seq: 5, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "i", Text: "second"}},
		{SessionID: "s", Seq: 2, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "i", Text: "first"}},
		{SessionID: "s", Seq: 3, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "other", Text: "unrelated"}},
		{SessionID: "other", Seq: 1, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "i", Text: "foreign"}},
		{SessionID: "s", Seq: 6, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "i", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted}},
	} {
		if err := log.Append(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}
	hits, err := log.Search(ctx, "firstsecond", 10)
	if err != nil || len(hits) != 1 || hits[0].SessionID != "s" {
		t.Fatalf("reconstructed search: hits=%v err=%v", hits, err)
	}
	hits, err = log.Search(ctx, "unrelated foreign", 10)
	if err != nil || len(hits) != 0 {
		t.Fatalf("unrelated text leaked: hits=%v err=%v", hits, err)
	}
}
