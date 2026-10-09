package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// TranscriptFiles stores the handoff independently of the project's files.
type TranscriptFiles interface {
	WriteTranscript(ctx context.Context, fork domain.SessionID, text string) (string, error)
}

// forkTranscript folds streamed updates into full items without truncation.
// JSON payloads remain data below each readable item heading.
func forkTranscript(source domain.SessionSnapshot, events []domain.Event) string {
	type entry struct {
		item    domain.ItemID
		request domain.RequestID
	}
	var order []entry
	requests := map[domain.RequestID]domain.Request{}
	items := map[domain.ItemID]domain.Item{}
	for _, ev := range events {
		switch {
		case ev.Type == domain.EventItemUpdated && ev.Item != nil:
			if _, ok := items[ev.Item.ID]; !ok {
				order = append(order, entry{item: ev.Item.ID})
			}
			items[ev.Item.ID] = *ev.Item
		case (ev.Type == domain.EventRequestOpened || ev.Type == domain.EventRequestResolved) && ev.Request != nil:
			r := *ev.Request
			if old, ok := requests[r.ID]; ok {
				if r.Kind == "" {
					r.Kind = old.Kind
				}
				if r.Title == "" {
					r.Title = old.Title
				}
				if r.Prompt == "" {
					r.Prompt = old.Prompt
				}
				if r.TurnID == "" {
					r.TurnID = old.TurnID
				}
				if r.ItemID == "" {
					r.ItemID = old.ItemID
				}
				if len(r.Payload) == 0 {
					r.Payload = old.Payload
				}
			} else {
				order = append(order, entry{request: r.ID})
			}
			if r.State == "" {
				r.State = domain.RequestPending
				if ev.Type == domain.EventRequestResolved {
					r.State = domain.RequestResolved
				}
			}
			requests[r.ID] = r

		case ev.Type == domain.EventTextDelta && ev.Delta != nil:
			if it, ok := items[ev.Delta.ItemID]; ok {
				it.Text += ev.Delta.Text
				items[it.ID] = it
			}
		}
	}
	var out strings.Builder
	fmt.Fprintf(&out, "# Session transcript\n\nSession: %s\nAgent: %s\nDirectory: %s\nTitle: %s\n\nThis is a snapshot of historical conversation, including tool output. Pending requests and running tools are not transferred.\n", source.ID, source.Agent, source.Cwd, source.Title)
	for _, row := range order {
		if row.request != "" {
			renderForkRequest(&out, requests[row.request])
			continue
		}
		it := items[row.item]
		fmt.Fprintf(&out, "\n## %s (%s) [%s]\n\n", it.Kind, it.ID, it.Status)
		if it.ParentItemID != "" {
			fmt.Fprintf(&out, "Parent item: %s\n", it.ParentItemID)
		}
		if it.Name != "" {
			fmt.Fprintf(&out, "Name: %s\n", it.Name)
		}
		if it.Path != "" {
			fmt.Fprintf(&out, "Path: %s\n", it.Path)
		}
		if len(it.Input) > 0 {
			fmt.Fprintf(&out, "Input: %s\n", it.Input)
		}
		if it.ExitCode != nil {
			fmt.Fprintf(&out, "Exit code: %d\n", *it.ExitCode)
		}
		if it.Decision != "" {
			fmt.Fprintf(&out, "Decision: %s\n", it.Decision)
		}
		if len(it.Images) > 0 {
			fmt.Fprintf(&out, "Image IDs (attachments are not transferred): %v\n", it.Images)
		}
		if it.Text != "" {
			fmt.Fprintf(&out, "\n%s\n", it.Text)
		}
		if it.Diff != "" {
			fmt.Fprintf(&out, "\n%s\n", it.Diff)
		}
	}
	return out.String()
}

func renderForkRequest(out *strings.Builder, r domain.Request) {
	state := string(r.State)
	if r.State == domain.RequestPending {
		state = "pending at fork; not transferred"
	}
	fmt.Fprintf(out, "\n## request %s (%s) [%s]\n\n", r.Kind, r.ID, state)
	if r.Title != "" {
		fmt.Fprintf(out, "Title: %s\n", r.Title)
	}
	if r.Prompt != "" {
		fmt.Fprintf(out, "Prompt: %s\n", r.Prompt)
	}
	if r.TurnID != "" {
		fmt.Fprintf(out, "Turn: %s\n", r.TurnID)
	}
	if r.ItemID != "" {
		fmt.Fprintf(out, "Item: %s\n", r.ItemID)
	}
	if len(r.Payload) > 0 {
		fmt.Fprintf(out, "Payload: %s\n", r.Payload)
	}
	if len(r.Answer) > 0 {
		fmt.Fprintf(out, "Answer: %s\n", r.Answer)
	}
	if r.Kind == domain.RequestPermission {
		out.WriteString("Historical approval does not grant permission in the new session.\n")
	}
}
