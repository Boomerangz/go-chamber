package apptest

import (
	"context"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// EventLogContract checks an app.EventLog and its message search. newLog
// must return an empty log.
func EventLogContract(t *testing.T, newLog func(t *testing.T) interface {
	app.EventLog
	app.MessageSearch
}) {
	ctx := context.Background()
	msg := func(seq domain.Seq, session domain.SessionID, id domain.ItemID, kind domain.ItemKind, status domain.ItemStatus, text string) domain.Event {
		return domain.Event{Seq: seq, SessionID: session, Type: domain.EventItemUpdated,
			Item: &domain.Item{ID: id, SessionID: session, Kind: kind, Status: status, Text: text}}
	}

	t.Run("history in order since a seq", func(t *testing.T) {
		log := newLog(t)
		if n, err := log.LastSeq(ctx, "a"); err != nil || n != 0 {
			t.Fatalf("empty last seq = %d, %v", n, err)
		}
		for seq := domain.Seq(1); seq <= 3; seq++ {
			if err := log.Append(ctx, domain.Event{Seq: seq, SessionID: "a", Type: domain.EventTurnStarted}); err != nil {
				t.Fatal(err)
			}
		}
		if err := log.Append(ctx, domain.Event{Seq: 1, SessionID: "b", Type: domain.EventTurnStarted}); err != nil {
			t.Fatal(err)
		}
		got, err := log.History(ctx, "a", 1)
		if err != nil || len(got) != 2 || got[0].Seq != 2 || got[1].Seq != 3 || got[0].Type != domain.EventTurnStarted {
			t.Fatalf("history = %+v, %v", got, err)
		}
		if n, _ := log.LastSeq(ctx, "a"); n != 3 {
			t.Fatalf("last seq = %d", n)
		}
		if got, _ := log.History(ctx, "none", 0); len(got) != 0 {
			t.Fatalf("unknown session history = %+v", got)
		}
	})

	t.Run("events round-trip with payloads", func(t *testing.T) {
		log := newLog(t)
		ev := msg(1, "a", "i1", domain.ItemAssistantMessage, domain.ItemCompleted, "hello")
		ev.Session = &domain.SessionSnapshot{ID: "a", Agent: domain.AgentClaude, Cwd: "/p", Status: domain.StatusIdle}
		if err := log.Append(ctx, ev); err != nil {
			t.Fatal(err)
		}
		got, _ := log.History(ctx, "a", 0)
		if len(got) != 1 || got[0].Item.Text != "hello" || got[0].Session.Cwd != "/p" {
			t.Fatalf("round trip = %+v", got)
		}
	})

	t.Run("search finds completed messages", func(t *testing.T) {
		log := newLog(t)
		events := []domain.Event{
			msg(1, "a", "u1", domain.ItemUserMessage, domain.ItemCompleted, "Please refactor the folder picker"),
			msg(2, "a", "a1", domain.ItemAssistantMessage, domain.ItemStreaming, ""),
			{Seq: 3, SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "a1", Text: "The picker now "}},
			{Seq: 4, SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "a1", Text: "uses a portal."}},
			msg(5, "a", "a1", domain.ItemAssistantMessage, domain.ItemCompleted, ""),
			msg(1, "b", "u2", domain.ItemUserMessage, domain.ItemCompleted, "Unrelated quota question"),
			msg(2, "b", "t1", domain.ItemCommand, domain.ItemCompleted, "picker in a command output"),
		}
		for _, ev := range events {
			if err := log.Append(ctx, ev); err != nil {
				t.Fatal(err)
			}
		}
		hits, err := log.Search(ctx, "picker", 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != 1 || hits[0].SessionID != "a" || hits[0].Matches != 2 {
			t.Fatalf("hits = %+v", hits)
		}
		if hits, _ := log.Search(ctx, "portal", 10); len(hits) != 1 || hits[0].ItemID != "a1" ||
			!strings.Contains(hits[0].Snippet, "[[portal]]") {
			t.Fatalf("delta-built message hits = %+v", hits)
		}
		if hits, _ := log.Search(ctx, "refac", 10); len(hits) != 1 {
			t.Fatalf("prefix hits = %+v", hits)
		}
		if hits, _ := log.Search(ctx, `quota "question`, 10); len(hits) != 1 || hits[0].SessionID != "b" {
			t.Fatalf("quoted hits = %+v", hits)
		}
		if hits, err := log.Search(ctx, "  ", 10); err != nil || len(hits) != 0 {
			t.Fatalf("blank = %+v, %v", hits, err)
		}
	})

	t.Run("search snippets are plain text around the phrase", func(t *testing.T) {
		log := newLog(t)
		var b strings.Builder
		b.WriteString("Раздел 70 в начале.\n")
		for i := range 80 {
			b.WriteString("| a | b |\n|---|---|\n| 70 | 4900 |\n```go\nfunc f70() {}\n```\n")
			if i == 60 {
				b.WriteString("## Раздел 7\n**Итог:** готово\n")
			}
		}
		if err := log.Append(ctx, msg(1, "a", "a1", domain.ItemAssistantMessage, domain.ItemCompleted, b.String())); err != nil {
			t.Fatal(err)
		}
		hits, err := log.Search(ctx, "Раздел 7", 10)
		if err != nil || len(hits) != 1 {
			t.Fatalf("hits = %+v, %v", hits, err)
		}
		got := hits[0].Snippet
		if !strings.Contains(got, "[[Раздел]] [[7]] Итог: готово") {
			t.Fatalf("snippet %q is not around the phrase", got)
		}
		if strings.ContainsAny(got, "|`#*") {
			t.Fatalf("snippet %q keeps markdown", got)
		}
	})

	t.Run("history skips deltas a later item update replaces", func(t *testing.T) {
		log := newLog(t)
		upd := func(seq domain.Seq, id domain.ItemID) domain.Event {
			return msg(seq, "a", id, domain.ItemAssistantMessage, domain.ItemStreaming, "")
		}
		delta := func(seq domain.Seq, id domain.ItemID) domain.Event {
			return domain.Event{Seq: seq, SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: id, Text: "x"}}
		}
		for _, ev := range []domain.Event{upd(1, "i"), delta(2, "i"), delta(3, "j"), delta(4, "i"), upd(5, "i"), delta(6, "i")} {
			if err := log.Append(ctx, ev); err != nil {
				t.Fatal(err)
			}
		}
		seqs := func(since domain.Seq) []domain.Seq {
			got, err := log.History(ctx, "a", since)
			if err != nil {
				t.Fatal(err)
			}
			var out []domain.Seq
			for _, ev := range got {
				out = append(out, ev.Seq)
			}
			return out
		}
		if got := seqs(0); len(got) != 4 || got[0] != 1 || got[1] != 3 || got[2] != 5 || got[3] != 6 {
			t.Fatalf("history = %v", got)
		}
		if got := seqs(3); len(got) != 2 || got[0] != 5 || got[1] != 6 {
			t.Fatalf("history since 3 = %v", got)
		}
	})

	t.Run("requests returns only request events in order", func(t *testing.T) {
		log := newLog(t)
		req := &domain.Request{ID: "r1", SessionID: "a", Kind: domain.RequestPermission, State: domain.RequestPending}
		for _, ev := range []domain.Event{
			{Seq: 1, SessionID: "a", Type: domain.EventRequestOpened, Request: req},
			{Seq: 2, SessionID: "a", Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "i", Text: "x"}},
			{Seq: 3, SessionID: "a", Type: domain.EventRequestResolved, Request: req},
			{Seq: 1, SessionID: "b", Type: domain.EventRequestOpened, Request: req},
		} {
			if err := log.Append(ctx, ev); err != nil {
				t.Fatal(err)
			}
		}
		got, err := log.Requests(ctx, "a")
		if err != nil || len(got) != 2 || got[0].Seq != 1 || got[1].Seq != 3 || got[1].Request.ID != "r1" {
			t.Fatalf("requests = %+v, %v", got, err)
		}
	})

	t.Run("a re-completed message is indexed once", func(t *testing.T) {
		log := newLog(t)
		for seq, text := range []string{"draft words", "final words"} {
			if err := log.Append(ctx, msg(domain.Seq(seq+1), "a", "a1", domain.ItemAssistantMessage, domain.ItemCompleted, text)); err != nil {
				t.Fatal(err)
			}
		}
		if hits, _ := log.Search(ctx, "draft", 10); len(hits) != 0 {
			t.Fatalf("stale text still indexed: %+v", hits)
		}
		if hits, _ := log.Search(ctx, "words", 10); len(hits) != 1 || hits[0].Matches != 1 {
			t.Fatalf("hits = %+v", hits)
		}
	})
}
