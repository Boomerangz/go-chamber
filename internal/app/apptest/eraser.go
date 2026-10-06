package apptest

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// ErasableStore is the storage a SessionEraser erases from.
type ErasableStore interface {
	Sessions() app.SessionRepo
	Events() interface {
		app.EventLog
		app.MessageSearch
	}
	app.SessionEraser
}

// SessionEraserContract verifies an app.SessionEraser: it removes the
// session, its events and its search entries, and nothing of any other
// session. newStore must return an empty store.
func SessionEraserContract(t *testing.T, newStore func(t *testing.T) ErasableStore) {
	ctx := context.Background()
	seed := func(t *testing.T, st ErasableStore, id domain.SessionID, text string) {
		t.Helper()
		if err := st.Sessions().Save(ctx, domain.SessionSnapshot{ID: id, Agent: domain.AgentClaude, Cwd: "/p", Status: domain.StatusDetached}); err != nil {
			t.Fatal(err)
		}
		item := &domain.Item{ID: "i1", SessionID: id, Kind: domain.ItemUserMessage, Status: domain.ItemCompleted, Text: text}
		for seq, ev := range []domain.Event{
			{SessionID: id, Type: domain.EventTurnStarted},
			{SessionID: id, Type: domain.EventItemUpdated, Item: item},
			{SessionID: id, Type: domain.EventSessionRemoved},
		} {
			ev.Seq = domain.Seq(seq + 1)
			if err := st.Events().Append(ctx, ev); err != nil {
				t.Fatal(err)
			}
		}
	}

	t.Run("erases the session and everything logged for it", func(t *testing.T) {
		st := newStore(t)
		seed(t, st, "gone", "pelican crossing")
		seed(t, st, "kept", "pelican landing")
		if err := st.EraseSession(ctx, "gone"); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Sessions().Get(ctx, "gone"); !errors.Is(err, app.ErrSessionNotFound) {
			t.Fatalf("session still there: %v", err)
		}
		if got, err := st.Events().History(ctx, "gone", 0); err != nil || len(got) != 0 {
			t.Fatalf("history = %+v, %v", got, err)
		}
		if n, err := st.Events().LastSeq(ctx, "gone"); err != nil || n != 0 {
			t.Fatalf("last seq = %d, %v", n, err)
		}
		hits, err := st.Events().Search(ctx, "pelican", 10)
		if err != nil || len(hits) != 1 || hits[0].SessionID != "kept" {
			t.Fatalf("search = %+v, %v", hits, err)
		}
		if got, err := st.Events().History(ctx, "kept", 0); err != nil || len(got) != 3 {
			t.Fatalf("other history = %+v, %v", got, err)
		}
		if list, _ := st.Sessions().List(ctx); len(list) != 1 || list[0].ID != "kept" {
			t.Fatalf("list = %+v", list)
		}
	})

	t.Run("erasing what is gone is not an error", func(t *testing.T) {
		if err := newStore(t).EraseSession(ctx, "none"); err != nil {
			t.Fatal(err)
		}
	})
}
