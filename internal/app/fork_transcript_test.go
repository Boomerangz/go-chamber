package app

import (
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestForkTranscriptPreservesRequestsAndTheirHistoricalStates(t *testing.T) {
	question := domain.Request{ID: "q", Kind: domain.RequestQuestion, Title: "Choose storage", Prompt: "Which storage?", State: domain.RequestPending,
		Payload: []byte(`{"input":{"questions":[{"question":"Which storage?","options":[{"label":"A","description":"Durable SQLite"},{"label":"B","description":"Ephemeral memory"}]}]}}`)}
	resolved := question
	resolved.State = domain.RequestResolved
	resolved.Payload = nil
	resolved.Title = ""
	resolved.Prompt = ""
	resolved.Answer = []byte(`{"answers":{"Which storage?":["A"]}}`)
	stale := question
	stale.State = domain.RequestStale
	elicitation := domain.Request{ID: "form", Kind: domain.RequestElicitation, Title: "Configure server", State: domain.RequestPending,
		Payload: []byte(`{"requestedSchema":{"properties":{"region":{"enum":["eu","us"],"description":"Deployment region"}}}}`)}
	elicited := elicitation
	elicited.State = domain.RequestResolved
	elicited.Answer = []byte(`{"content":{"region":"eu"}}`)
	permission := domain.Request{ID: "permission", Kind: domain.RequestPermission, Title: "Run migration", State: domain.RequestResolved, Answer: []byte(`{"allow":true}`)}
	for _, tc := range []struct {
		name   string
		events []domain.Event
		wants  []string
	}{
		{"pending", []domain.Event{{Type: domain.EventRequestOpened, Request: &question}}, []string{"Which storage?", "Durable SQLite", "Ephemeral memory", "pending at fork", "not transferred"}},
		{"answered", []domain.Event{{Type: domain.EventRequestOpened, Request: &question}, {Type: domain.EventRequestResolved, Request: &resolved}}, []string{"Durable SQLite", `"A"`, "resolved", "Choose storage"}},
		{"stale", []domain.Event{{Type: domain.EventRequestOpened, Request: &question}, {Type: domain.EventRequestResolved, Request: &stale}}, []string{"stale", "Durable SQLite"}},
		{"elicitation", []domain.Event{{Type: domain.EventRequestOpened, Request: &elicitation}, {Type: domain.EventRequestResolved, Request: &elicited}}, []string{"Deployment region", `"region":"eu"`, "Configure server"}},
		{"permission", []domain.Event{{Type: domain.EventRequestResolved, Request: &permission}}, []string{"Run migration", `"allow":true`, "Historical approval does not grant permission"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text := forkTranscript(domain.SessionSnapshot{ID: "source"}, tc.events)
			for _, want := range tc.wants {
				if !strings.Contains(text, want) {
					t.Fatalf("missing %q in %s", want, text)
				}
			}
		})
	}
}
func TestForkTranscriptPlacesRequestsInConversationOrder(t *testing.T) {
	events := []domain.Event{
		{Type: domain.EventItemUpdated, Item: &domain.Item{ID: "before", Kind: domain.ItemAssistantMessage, Text: "before-question"}},
		{Type: domain.EventRequestOpened, Request: &domain.Request{ID: "q", Kind: domain.RequestQuestion, Prompt: "choose-now", State: domain.RequestPending}},
		{Type: domain.EventRequestResolved, Request: &domain.Request{ID: "q", State: domain.RequestResolved, Answer: []byte(`{"answer":"chosen"}`)}},
		{Type: domain.EventItemUpdated, Item: &domain.Item{ID: "after", Kind: domain.ItemAssistantMessage, Text: "after-answer"}},
	}
	text := forkTranscript(domain.SessionSnapshot{ID: "s"}, events)
	before, q, after := strings.Index(text, "before-question"), strings.Index(text, "choose-now"), strings.Index(text, "after-answer")
	if before < 0 || q <= before || after <= q || strings.Count(text, "## request") != 1 {
		t.Fatalf("wrong order or duplicate request: %s", text)
	}
}
