package opencode

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// mapper owns protocol state for one native session. Runtime serializes access.
type mapper struct {
	session     domain.SessionID
	turn        domain.TurnID
	replayUsers bool
	messages    map[string]string
	infos       map[string]message
	parts       map[string]part
	pending     map[string]map[string]part
	items       map[string]*domain.Item
	order       []string
	requests    map[string]request
	opened      map[string]domain.Request
	children    map[string]bool
	seen        map[string]bool
	recovered   map[string]bool
	usage, base domain.Usage
	turnError   string
}

func newMapper(id domain.SessionID, replay bool) *mapper {
	return &mapper{session: id, replayUsers: replay, messages: map[string]string{}, infos: map[string]message{}, parts: map[string]part{}, items: map[string]*domain.Item{}, requests: map[string]request{}, opened: map[string]domain.Request{}, children: map[string]bool{}, seen: map[string]bool{}}
}
func (m *mapper) ev(typ domain.EventType) domain.Event {
	return domain.Event{SessionID: m.session, Type: typ}
}
func (m *mapper) begin(turn domain.TurnID) { m.turn = turn; m.base = m.usage; m.turnError = "" }
func (m *mapper) mapEvent(e event) []domain.Event {
	if e.ID != "" {
		if m.seen[e.ID] {
			return nil
		}
		if len(m.seen) > 10000 {
			m.seen = map[string]bool{}
		}
		m.seen[e.ID] = true
	}
	switch e.Type {
	case "message.updated":
		var p struct {
			Info message `json:"info"`
		}
		if json.Unmarshal(e.Properties, &p) == nil {
			return m.message(p.Info)
		}
	case "message.part.updated":
		var p struct {
			Part part `json:"part"`
		}
		if json.Unmarshal(e.Properties, &p) == nil {
			out := m.part(p.Part)
			if p.Part.Type == "text" || p.Part.Type == "reasoning" {
				if it := m.items[p.Part.ID]; it != nil && len(p.Part.Text) >= len(it.Text) {
					delete(m.recovered, p.Part.ID)
				}
			}
			return out
		}
	case "message.part.delta":
		var p struct {
			PartID    string `json:"partID"`
			MessageID string `json:"messageID"`
			Field     string `json:"field"`
			Delta     string `json:"delta"`
		}
		if json.Unmarshal(e.Properties, &p) == nil && p.Field == "text" {
			if m.recovered[p.PartID] {
				return nil
			}
			if it := m.items[p.PartID]; it != nil && it.Status.Terminal() {
				return nil
			}
			v := m.parts[p.PartID]
			v.ID = p.PartID
			v.MessageID = p.MessageID
			if v.Type == "" {
				v.Type = "text"
			}
			v.Text += p.Delta
			return m.part(v)
		}
	case "session.status":
		var p struct {
			Status status `json:"status"`
		}
		if json.Unmarshal(e.Properties, &p) == nil {
			return m.status(p.Status)
		}
	case "permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked":
		if p, ok := asked(e); ok {
			return m.openRequest(p)
		}
	case "permission.replied", "permission.v2.replied", "question.replied", "question.rejected", "question.v2.replied", "question.v2.rejected":
		var p struct {
			RequestID string `json:"requestID"`
		}
		if json.Unmarshal(e.Properties, &p) == nil {
			return m.resolveRequest(p.RequestID, domain.RequestResolved)
		}
	case "session.error":
		var p struct {
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal(e.Properties, &p) == nil {
			return m.fail(errorText(p.Error))
		}
	}
	return nil
}
func (m *mapper) message(info message) []domain.Event {
	if info.ID == "" || info.Role == "" {
		return nil
	}
	m.messages[info.ID] = info.Role
	previous := messageUsage(m.infos[info.ID])
	m.infos[info.ID] = info
	var out []domain.Event
	current := messageUsage(info)
	next := m.usage
	next.InputTokens += current.InputTokens - previous.InputTokens
	next.OutputTokens += current.OutputTokens - previous.OutputTokens
	next.CostUSD += current.CostUSD - previous.CostUSD
	next.TotalTokens = next.InputTokens + next.OutputTokens
	if next != m.usage {
		m.usage = next
		e := m.ev(domain.EventUsage)
		v := next
		e.Usage = &v
		out = append(out, e)
	}
	if len(info.Error) > 0 && string(info.Error) != "null" {
		out = append(out, m.fail(errorText(info.Error))...)
	}
	// Parts can precede their role snapshot on reconnect. Do not guess user vs assistant.
	for _, p := range m.pending[info.ID] {
		out = append(out, m.part(p)...)
	}
	delete(m.pending, info.ID)
	return out
}
func messageUsage(info message) domain.Usage {
	if info.Role != "assistant" {
		return domain.Usage{}
	}
	return domain.Usage{InputTokens: info.Tokens.Input + info.Tokens.Cache.Read + info.Tokens.Cache.Write, OutputTokens: info.Tokens.Output + info.Tokens.Reasoning, CostUSD: info.Cost}
}
func (m *mapper) part(p part) []domain.Event {
	if p.ID == "" || p.MessageID == "" {
		return nil
	}
	old := m.parts[p.ID]
	if (p.Type == "text" || p.Type == "reasoning") && strings.HasPrefix(old.Text, p.Text) && len(old.Text) > len(p.Text) {
		p.Text = old.Text
	}
	m.parts[p.ID] = p
	role := m.messages[p.MessageID]
	if role == "" {
		if m.pending == nil {
			m.pending = map[string]map[string]part{}
		}
		if m.pending[p.MessageID] == nil {
			m.pending[p.MessageID] = map[string]part{}
		}
		m.pending[p.MessageID][p.ID] = p
		return nil
	}
	if role == "user" && !m.replayUsers {
		return nil
	}
	kind := domain.ItemAssistantMessage
	switch p.Type {
	case "text":
		if role == "user" {
			kind = domain.ItemUserMessage
		}
	case "reasoning":
		kind = domain.ItemReasoning
	case "tool":
		kind = domain.ItemToolCall
		switch p.Tool {
		case "bash":
			kind = domain.ItemCommand
		case "write", "edit", "apply_patch":
			kind = domain.ItemFileChange
		case "task":
			kind = domain.ItemSubagent
		}
	default:
		return nil
	}
	it := m.items[p.ID]
	fresh := it == nil
	if fresh {
		it, _ = domain.NewItem(domain.ItemID("oc-"+p.ID), m.session, m.turn, "", kind)
		m.items[p.ID] = it
		m.order = append(m.order, p.ID)
	}
	before := *it
	var out []domain.Event
	if fresh {
		it.Status = domain.ItemStreaming
		e := m.ev(domain.EventItemUpdated)
		e.Item = it
		out = append(out, domain.DetachItems([]domain.Event{e})...)
	}
	if p.Type == "text" || p.Type == "reasoning" {
		if strings.HasPrefix(p.Text, it.Text) && len(p.Text) > len(it.Text) {
			delta := strings.TrimPrefix(p.Text, it.Text)
			it.Text = p.Text
			e := m.ev(domain.EventTextDelta)
			e.Delta = &domain.Delta{ItemID: it.ID, Text: delta}
			out = append(out, e)
		}
		if role == "user" || p.Time.End > 0 {
			it.Status = domain.ItemCompleted
		}
	} else {
		it.Name = p.Tool
		it.Input = p.State.Input
		it.Text = p.State.Output
		switch p.State.Status {
		case "completed":
			it.Status = domain.ItemCompleted
		case "error":
			it.Status = domain.ItemFailed
			it.Text = p.State.Error
		}
		var input struct {
			FilePath string `json:"filePath"`
			Path     string `json:"path"`
		}
		_ = json.Unmarshal(p.State.Input, &input)
		it.Path = input.FilePath
		if it.Path == "" {
			it.Path = input.Path
		}
		var meta struct {
			Diff      string `json:"diff"`
			Exit      *int   `json:"exit"`
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(p.State.Metadata, &meta)
		it.Diff = meta.Diff
		it.ExitCode = meta.Exit
		it.AgentID = meta.SessionID
	}
	if !reflect.DeepEqual(before, *it) {
		e := m.ev(domain.EventItemUpdated)
		e.Item = it
		out = append(out, e)
	}
	return out
}
func (m *mapper) status(s status) []domain.Event {
	if s.Type != "idle" || m.turn == "" {
		return nil
	}
	var out []domain.Event
	var text []string
	for _, id := range m.order {
		it := m.items[id]
		if it.TurnID != m.turn {
			continue
		}
		if !it.Status.Terminal() {
			it.Status = domain.ItemCompleted
			e := m.ev(domain.EventItemUpdated)
			e.Item = it
			out = append(out, e)
		}
		if it.Kind == domain.ItemAssistantMessage {
			text = append(text, it.Text)
		}
	}
	e := m.ev(domain.EventTurnEnded)
	e.Result = &domain.TurnResult{Text: strings.Join(text, "\n"), IsError: m.turnError != "", Error: m.turnError, CostUSD: m.usage.CostUSD - m.base.CostUSD, InputTokens: m.usage.InputTokens - m.base.InputTokens, OutputTokens: m.usage.OutputTokens - m.base.OutputTokens}
	out = append(out, e)
	m.turn = ""
	return out
}
func (m *mapper) fail(text string) []domain.Event {
	if text == "" || text == m.turnError {
		return nil
	}
	m.turnError = text
	it, _ := domain.NewItem(domain.ItemID(fmt.Sprintf("oc-error-%d", len(m.items))), m.session, m.turn, "", domain.ItemError)
	it.Text = text
	it.Status = domain.ItemFailed
	e := m.ev(domain.EventItemUpdated)
	e.Item = it
	return []domain.Event{e}
}
func errorText(raw json.RawMessage) string {
	var p struct {
		Message string `json:"message"`
		Name    string `json:"name"`
		Data    struct {
			Message string `json:"message"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return "OpenCode error"
	}
	if p.Data.Message != "" {
		return p.Data.Message
	}
	if p.Message != "" {
		return p.Message
	}
	return p.Name
}
func (m *mapper) openRequest(p request) []domain.Event {
	if p.ID == "" {
		return nil
	}
	if _, ok := m.requests[p.ID]; ok {
		return nil
	}
	m.requests[p.ID] = p
	req := domain.Request{ID: domain.RequestID(p.ID), SessionID: m.session, TurnID: m.turn, Kind: domain.RequestPermission, State: domain.RequestPending, Title: p.Permission, Prompt: strings.Join(p.Patterns, "\n")}
	rules := []map[string]string{}
	patterns := p.Always
	if len(patterns) == 0 {
		patterns = p.Patterns
	}
	for _, pattern := range patterns {
		rules = append(rules, map[string]string{"toolName": p.Permission, "ruleContent": pattern})
	}
	payload := map[string]any{"toolName": p.Permission, "input": p.Metadata, "suggestions": []any{map[string]any{"type": "addRules", "rules": rules}}}
	if len(p.Questions) > 0 {
		req.Kind = domain.RequestQuestion
		req.Title = p.Questions[0].Header
		questions := []map[string]any{}
		for _, q := range p.Questions {
			questions = append(questions, map[string]any{"question": q.Question, "header": q.Header, "options": q.Options, "multiSelect": q.Multiple, "custom": q.Custom})
		}
		payload = map[string]any{"toolName": "question", "input": map[string]any{"questions": questions}}
	}
	req.Payload, _ = json.Marshal(payload)
	m.opened[p.ID] = req
	e := m.ev(domain.EventRequestOpened)
	e.Request = &req
	return []domain.Event{e}
}
func (m *mapper) resolveRequest(id string, state domain.RequestState) []domain.Event {
	req, ok := m.opened[id]
	if !ok {
		return nil
	}
	delete(m.requests, id)
	delete(m.opened, id)
	req.State = state
	e := m.ev(domain.EventRequestResolved)
	e.Request = &req
	return []domain.Event{e}
}

// A history snapshot may already include SSE deltas buffered during its GET.
// For a recovered partial part, wait for its next full snapshot before accepting
// incremental chunks again; completed snapshots never take further deltas.
func (m *mapper) replayPart(p part) []domain.Event {
	out := m.part(p)
	if p.Type == "text" || p.Type == "reasoning" {
		if m.recovered == nil {
			m.recovered = map[string]bool{}
		}
		m.recovered[p.ID] = true
	}
	return out
}
