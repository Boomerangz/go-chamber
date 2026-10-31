package sqlite

import (
	"cmp"
	"context"
	"slices"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// HistoryPage reads the tail through the primary key, without decoding the
// entire transcript. The extra row determines whether there is another page.
func (l eventLog) HistoryPage(ctx context.Context, session domain.SessionID, before domain.Seq, limit int) (app.HistoryPage, error) {
	page := app.HistoryPage{Events: []domain.Event{}}
	last, err := l.LastSeq(ctx, session)
	if err != nil {
		return page, err
	}
	page.LastSeq = last
	upper := before
	if upper == 0 {
		upper = last + 1
	}
	events, err := l.query(ctx, `SELECT body FROM events WHERE session_id=? AND seq<? AND type NOT IN ('quota','session.state','usage') ORDER BY seq DESC LIMIT ?`, session, upper, limit+1)
	if err != nil {
		return page, err
	}
	if len(events) == 0 {
		return page, nil
	}
	page.HasMore = len(events) > limit
	if page.HasMore {
		events = events[:limit]
	}
	slices.Reverse(events)
	page.Before = events[0].Seq
	// Complete messages whose first visible event is a delta, and parents of
	// visible children. Seeds never move the raw-window pagination cursor.
	known := map[domain.ItemID]bool{}
	for _, ev := range events {
		if ev.Item != nil {
			known[ev.Item.ID] = true
		}
	}
	var seed func(domain.ItemID) error
	seed = func(id domain.ItemID) error {
		if id == "" || known[id] {
			return nil
		}
		known[id] = true
		base, err := l.query(ctx, `SELECT body FROM events INDEXED BY events_updates WHERE session_id=? AND item_id=? AND type='item.updated' AND seq<? ORDER BY seq DESC LIMIT 1`, session, id, page.Before)
		if err != nil || len(base) == 0 {
			return err
		}
		ev := base[0]
		if ev.Item == nil {
			return nil
		}
		deltas, err := l.query(ctx, `SELECT body FROM events INDEXED BY events_deltas WHERE session_id=? AND item_id=? AND item_id!='' AND type='text.delta' AND seq>? AND seq<? ORDER BY seq`, session, id, ev.Seq, page.Before)
		if err != nil {
			return err
		}
		for _, delta := range deltas {
			if delta.Delta != nil {
				ev.Item.Text += delta.Delta.Text
			}
		}
		page.Events = append(page.Events, ev)
		return seed(ev.Item.ParentItemID)
	}
	for _, ev := range events {
		if ev.Delta != nil {
			if err := seed(ev.Delta.ItemID); err != nil {
				return page, err
			}
		}
		if ev.Item != nil {
			if err := seed(ev.Item.ParentItemID); err != nil {
				return page, err
			}
		}
	}
	if before == 0 {
		// Current requests and state may have been recorded before the tail.
		requests, err := l.Requests(ctx, session)
		if err != nil {
			return page, err
		}
		for _, ev := range requests {
			if ev.Seq < page.Before {
				page.Events = append(page.Events, ev)
			}
		}
		included := map[domain.Seq]bool{}
		for _, ev := range events {
			included[ev.Seq] = true
		}
		for _, kind := range []domain.EventType{domain.EventSessionState, domain.EventTurnStarted, domain.EventTurnEnded, domain.EventUsage} {
			state, err := l.query(ctx, `SELECT body FROM events INDEXED BY events_state WHERE session_id=? AND type IN ('session.state','turn.started','turn.ended','usage') AND type=? AND seq<=? ORDER BY seq DESC LIMIT 1`, session, kind, page.LastSeq)
			if err != nil {
				return page, err
			}
			for _, ev := range state {
				if !included[ev.Seq] {
					page.Events = append(page.Events, ev)
				}
			}
		}
	}
	page.Events = append(page.Events, events...)
	slices.SortFunc(page.Events, func(a, b domain.Event) int { return cmp.Compare(a.Seq, b.Seq) })
	return page, nil
}
