package mcpapi

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// transcript is a session's events folded into their items, the way the
// web client folds them.
type transcript struct {
	order  []domain.ItemID
	items  map[domain.ItemID]domain.Item
	result *domain.TurnResult
}

func fold(events []domain.Event) *transcript {
	t := &transcript{items: map[domain.ItemID]domain.Item{}}
	for _, ev := range events {
		switch {
		case ev.Type == domain.EventItemUpdated && ev.Item != nil:
			t.put(*ev.Item)
		case ev.Type == domain.EventTextDelta && ev.Delta != nil:
			it, ok := t.items[ev.Delta.ItemID]
			if !ok {
				it = domain.Item{ID: ev.Delta.ItemID, Kind: domain.ItemAssistantMessage, Status: domain.ItemStreaming}
			}
			it.Text += ev.Delta.Text
			t.put(it)
		case ev.Type == domain.EventTurnEnded:
			t.result = ev.Result
		}
	}
	return t
}

func (t *transcript) put(it domain.Item) {
	if _, ok := t.items[it.ID]; !ok {
		t.order = append(t.order, it.ID)
	}
	t.items[it.ID] = it
}

// final is the agent's last message.
func (t *transcript) final() string {
	for i := len(t.order) - 1; i >= 0; i-- {
		if it := t.items[t.order[i]]; it.Kind == domain.ItemAssistantMessage && it.Text != "" {
			return it.Text
		}
	}
	if t.result != nil {
		return t.result.Text
	}
	return ""
}

// activity is the last n lines of work: everything but the conversation.
func (t *transcript) activity(n int) []string {
	var out []string
	for _, id := range t.order {
		it := t.items[id]
		if it.Kind == domain.ItemUserMessage || it.Kind == domain.ItemAssistantMessage {
			continue
		}
		if l := line(it, 160); l != "" {
			out = append(out, l)
		}
	}
	return out[max(0, len(out)-n):]
}

// render is the transcript as text, cut from the front to at most max
// bytes: the end is what a caller came for.
func (t *transcript) render(max int) string {
	var lines []string
	for _, id := range t.order {
		limit := 300
		if k := t.items[id].Kind; k == domain.ItemUserMessage || k == domain.ItemAssistantMessage {
			limit = 0
		}
		if l := line(t.items[id], limit); l != "" {
			lines = append(lines, l)
		}
	}
	text := strings.Join(lines, "\n")
	if len(text) <= max {
		return text
	}
	cut := len(text) - max
	for cut < len(text) && !utf8.RuneStart(text[cut]) {
		cut++
	}
	return "[earlier transcript cut: raise max_chars or pass a later since_seq]\n" + text[cut:]
}

// line is one item as a line of text, empty for what a reader need not
// see; limit shortens long text, 0 keeps it whole.
func line(it domain.Item, limit int) string {
	switch it.Kind {
	case domain.ItemUserMessage:
		who := "user"
		if it.Origin != "" {
			who += " (" + string(it.Origin) + ")"
		}
		return who + ": " + short(it.Text, limit)
	case domain.ItemAssistantMessage:
		return "assistant: " + short(it.Text, limit)
	case domain.ItemToolCall, domain.ItemCommand:
		return "tool " + toolLine(it, limit)
	case domain.ItemFileChange:
		return "edit " + it.Path
	case domain.ItemSubagent:
		return "subagent: " + short(cmp.Or(it.Text, it.Name), limit)
	case domain.ItemPlan:
		return "plan: " + short(it.Text, limit)
	case domain.ItemError:
		return "error: " + short(it.Text, limit)
	case domain.ItemDecision:
		l := string(it.Decision) + " " + cmp.Or(it.Name, "request")
		if it.Text != "" {
			l += ": " + short(it.Text, limit)
		}
		return l
	case domain.ItemHook:
		if it.Outcome == domain.HookBlocked || it.Outcome == domain.HookError {
			return "hook " + it.Name + " " + string(it.Outcome) + ": " + short(it.Text, limit)
		}
	}
	return ""
}

func toolLine(it domain.Item, limit int) string {
	l := strings.TrimSpace(cmp.Or(it.Name, "command") + " " + short(inputGist(it.Input), limit))
	switch {
	case it.ExitCode != nil:
		l += fmt.Sprintf(" (exit %d)", *it.ExitCode)
	case it.Status == domain.ItemFailed:
		l += " (failed)"
	case !it.Status.Terminal():
		l += " (running)"
	}
	return l
}

// inputGist is the one argument that says what a tool call does.
func inputGist(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var args map[string]any
	if json.Unmarshal(raw, &args) != nil {
		return string(raw)
	}
	for _, k := range []string{"command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt"} {
		switch v := args[k].(type) {
		case string:
			return v
		case []any:
			parts := make([]string, 0, len(v))
			for _, p := range v {
				parts = append(parts, fmt.Sprint(p))
			}
			return strings.Join(parts, " ")
		}
	}
	return string(raw)
}

func short(s string, limit int) string {
	s = strings.TrimSpace(s)
	if limit == 0 || utf8.RuneCountInString(s) <= limit {
		return s
	}
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > limit {
		return string(r[:limit]) + "…"
	}
	return s
}

type readIn struct {
	SessionID string     `json:"session_id"`
	SinceSeq  domain.Seq `json:"since_seq,omitempty"`
	MaxChars  int        `json:"max_chars,omitempty" jsonschema:"keep the last this many bytes; 20000 when omitted"`
}

type readOut struct {
	Status string     `json:"status"`
	Seq    domain.Seq `json:"seq"`
}

func (s *Server) readSession(ctx context.Context, _ *sdk.CallToolRequest, in readIn) (*sdk.CallToolResult, readOut, error) {
	id := domain.SessionID(in.SessionID)
	snap, err := s.cfg.Sessions.GetSession(ctx, id)
	if err != nil {
		return nil, readOut{}, err
	}
	events := s.cfg.Events.History(id, in.SinceSeq)
	text := fold(events).render(cmp.Or(in.MaxChars, 20000))
	if text == "" {
		text = "nothing yet"
	}
	out := readOut{Status: string(snap.Status), Seq: lastSeq(events, in.SinceSeq)}
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
}
