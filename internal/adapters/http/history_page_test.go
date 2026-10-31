package httpapi

import (
	"encoding/json"
	"testing"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestSessionEventPages(t *testing.T) {
	events := hub.New()
	for range 5 {
		events.Publish(domain.Event{SessionID: "s", Type: domain.EventTurnStarted})
	}
	h := newSessionsServer(&fakeSessions{}, events)
	rec := do(h, authed("GET", "/api/sessions/s/events?limit=2", ""))
	var page app.HistoryPage
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if rec.Code != 200 || len(page.Events) != 2 || page.Events[0].Seq != 4 || page.Before != 4 || !page.HasMore {
		t.Fatalf("response=%s", rec.Body)
	}
	rec = do(h, authed("GET", "/api/sessions/s/events?limit=2&before=4", ""))
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 2 || page.Events[0].Seq != 2 || page.Before != 2 {
		t.Fatalf("response=%s", rec.Body)
	}
	for _, q := range []string{"limit=0", "limit=1001", "limit=x", "limit=2&before=-1", "limit=2&since=1", "limit=2&before=x", "before=2"} {
		rec = do(h, authed("GET", "/api/sessions/s/events?"+q, ""))
		if rec.Code != 400 {
			t.Fatalf("%s: %d", q, rec.Code)
		}
	}
}
