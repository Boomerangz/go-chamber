package httpapi

import (
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestReplayDropsDeltasALaterItemUpdateReplaces(t *testing.T) {
	upd := func(seq domain.Seq, id domain.ItemID) domain.Event {
		return domain.Event{Seq: seq, Type: domain.EventItemUpdated, Item: &domain.Item{ID: id}}
	}
	delta := func(seq domain.Seq, id domain.ItemID) domain.Event {
		return domain.Event{Seq: seq, Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: id, Text: "x"}}
	}
	got := replay([]domain.Event{
		upd(1, "a"), delta(2, "a"), delta(3, "b"), delta(4, "a"), upd(5, "a"), delta(6, "a"),
	})
	var seqs []domain.Seq
	for _, ev := range got {
		seqs = append(seqs, ev.Seq)
	}
	// 2 and 4 fold into a and are replaced by 5; 3 has no later update; 6 streams after it.
	if len(seqs) != 4 || seqs[0] != 1 || seqs[1] != 3 || seqs[2] != 5 || seqs[3] != 6 {
		t.Fatalf("replayed seqs = %v", seqs)
	}
}
