package hub

import (
	"cmp"
	"context"
	"slices"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// HistoryPage uses indexed storage when available. Memory-only hubs and a
// log with lost writes reconstruct a window from the surviving replay.
func (h *Hub) HistoryPage(ctx context.Context, session domain.SessionID, before domain.Seq, limit int) (app.HistoryPage, error) {
	h.mu.Lock()
	lost := h.lost[session]
	h.mu.Unlock()
	if pager, ok := h.log.(app.HistoryPager); ok && !lost {
		return pager.HistoryPage(ctx, session, before, limit)
	}
	var all []domain.Event
	if h.log != nil {
		var err error
		all, err = h.log.History(ctx, session, 0)
		if err != nil {
			return app.HistoryPage{}, err
		}
		all = h.fillLost(session, 0, all)
	} else {
		all = h.History(session, 0)
	}
	end := len(all)
	if before > 0 {
		end = sortBefore(all, before)
	}
	start := max(0, end-limit)
	page := app.HistoryPage{Events: append([]domain.Event{}, all[start:end]...), HasMore: start > 0}
	if start == end {
		return page, nil
	}
	page.Before = all[start].Seq
	page.LastSeq = all[end-1].Seq
	known := map[domain.ItemID]bool{}
	for _, ev := range page.Events {
		if ev.Item != nil {
			known[ev.Item.ID] = true
		}
	}
	bases := map[domain.ItemID]domain.Event{}
	for _, ev := range domain.DetachItems(all[:start]) {
		if ev.Item != nil {
			bases[ev.Item.ID] = ev
		}
		if ev.Delta != nil {
			if base, ok := bases[ev.Delta.ItemID]; ok {
				base.Item.Text += ev.Delta.Text
			}
		}
	}
	var seed func(domain.ItemID)
	seed = func(id domain.ItemID) {
		if known[id] {
			return
		}
		known[id] = true
		if ev, ok := bases[id]; ok {
			page.Events = append(page.Events, ev)
			seed(ev.Item.ParentItemID)
		}
	}
	for _, ev := range all[start:end] {
		if ev.Item != nil {
			seed(ev.Item.ParentItemID)
		}
		if ev.Delta != nil {
			seed(ev.Delta.ItemID)
		}
	}
	slices.SortFunc(page.Events, func(a, b domain.Event) int { return cmp.Compare(a.Seq, b.Seq) })
	return page, nil
}

func sortBefore(events []domain.Event, before domain.Seq) int {
	i, _ := slices.BinarySearchFunc(events, before, func(ev domain.Event, seq domain.Seq) int { return cmp.Compare(ev.Seq, seq) })
	return i
}
