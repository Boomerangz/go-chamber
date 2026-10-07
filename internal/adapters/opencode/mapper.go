package opencode

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// mapper owns protocol state for one native session. Runtime serializes access.
//
// Text and reasoning have no IDs of their own: each is the n-th block of its
// kind in an assistant message. Tool calls carry their own IDs.
type mapper struct {
	session     domain.SessionID
	turn        domain.TurnID
	replayUsers bool
	items       map[string]*domain.Item
	order       []string
	requests    map[string]request
	opened      map[string]domain.Request
	children    map[string]bool
	seen        map[string]bool
	usage, base domain.Usage
	turnError   string
}

func newMapper(id domain.SessionID, replay bool) *mapper {
	return &mapper{session: id, replayUsers: replay, items: map[string]*domain.Item{}, requests: map[string]request{}, opened: map[string]domain.Request{}, children: map[string]bool{}, seen: map[string]bool{}}
}
func (m *mapper) ev(typ domain.EventType) domain.Event {
	return domain.Event{SessionID: m.session, Type: typ}
}
func (m *mapper) updated(it *domain.Item) domain.Event {
	e := m.ev(domain.EventItemUpdated)
	e.Item = it
	return e
}
func (m *mapper) begin(turn domain.TurnID) { m.turn = turn; m.base = m.usage; m.turnError = "" }

func blockKey(message, kind string, ordinal int) string {
	return fmt.Sprintf("%s-%s-%d", message, kind, ordinal)
}
func blockKind(kind string) domain.ItemKind {
	if kind == "reasoning" {
		return domain.ItemReasoning
	}
	return domain.ItemAssistantMessage
}

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
	var d struct {
		AssistantMessageID string          `json:"assistantMessageID"`
		Ordinal            int             `json:"ordinal"`
		ID                 string          `json:"id"`
		Name               string          `json:"name"`
		Delta              string          `json:"delta"`
		Text               string          `json:"text"`
		Input              json.RawMessage `json:"input"`
		Content            []toolOutput    `json:"content"`
		Metadata           json.RawMessage `json:"metadata"`
		Error              *failure        `json:"error"`
		Cost               float64         `json:"cost"`
		Tokens             tokens          `json:"tokens"`
		RequestID          string          `json:"requestID"`
		Form               request         `json:"form"`
	}
	if json.Unmarshal(e.Data, &d) != nil {
		return nil
	}
	kind, phase, _ := strings.Cut(strings.TrimPrefix(e.Type, "session."), ".")
	switch e.Type {
	case "session.text.started", "session.reasoning.started", "session.text.delta", "session.reasoning.delta", "session.text.ended", "session.reasoning.ended":
		if d.AssistantMessageID == "" {
			return nil
		}
		key := blockKey(d.AssistantMessageID, kind, d.Ordinal)
		switch phase {
		case "started":
			_, out := m.item(key, blockKind(kind))
			return out
		case "delta":
			text := d.Delta
			if it := m.items[key]; it != nil {
				text = it.Text + d.Delta
			}
			return m.text(key, blockKind(kind), text, false)
		}
		return m.text(key, blockKind(kind), d.Text, true)
	case "session.tool.input.started":
		return m.tool(d.ID, func(it *domain.Item) { it.Name = d.Name })
	case "session.tool.called":
		return m.tool(d.ID, func(it *domain.Item) { setInput(it, d.Input) })
	case "session.tool.progress":
		return m.tool(d.ID, func(it *domain.Item) { setMetadata(it, d.Metadata) })
	case "session.tool.success":
		return m.tool(d.ID, func(it *domain.Item) {
			it.Text = outputText(d.Content)
			setMetadata(it, d.Metadata)
			it.Status = domain.ItemCompleted
		})
	case "session.tool.failed":
		return m.tool(d.ID, func(it *domain.Item) {
			if d.Error != nil {
				it.Text = d.Error.Message
			}
			it.Status = domain.ItemFailed
		})
	case "session.usage.updated":
		return m.setUsage(d.Cost, d.Tokens)
	case "session.step.failed":
		// An interrupted step is not an error; the turn just ends.
		if d.Error != nil && d.Error.Type != "aborted" {
			return m.fail(d.Error.Message)
		}
	case "session.execution.failed":
		var out []domain.Event
		if d.Error != nil {
			out = m.fail(d.Error.Message)
		}
		return append(out, m.idle()...)
	case "session.execution.succeeded", "session.execution.interrupted":
		return m.idle()
	case "permission.asked":
		if p, ok := asked(e); ok {
			return m.openRequest(p)
		}
	case "form.created":
		d.Form.Form = true
		return m.openRequest(d.Form)
	case "permission.replied":
		return m.resolveRequest(d.RequestID, domain.RequestResolved)
	case "form.replied", "form.cancelled":
		return m.resolveRequest(d.ID, domain.RequestResolved)
	}
	return nil
}

// item returns the item for key, creating it as streaming.
func (m *mapper) item(key string, kind domain.ItemKind) (*domain.Item, []domain.Event) {
	if it := m.items[key]; it != nil {
		return it, nil
	}
	it, _ := domain.NewItem(domain.ItemID("oc-"+key), m.session, m.turn, "", kind)
	it.Status = domain.ItemStreaming
	m.items[key] = it
	m.order = append(m.order, key)
	return it, domain.DetachItems([]domain.Event{m.updated(it)})
}

// text moves a block to text. A completed block takes no more deltas, but
// its final text replaces whatever the stream had, filling any gap.
func (m *mapper) text(key string, kind domain.ItemKind, text string, done bool) []domain.Event {
	it, out := m.item(key, kind)
	if it.Status.Terminal() && !done {
		return out
	}
	before := *it
	if strings.HasPrefix(text, it.Text) && len(text) > len(it.Text) {
		e := m.ev(domain.EventTextDelta)
		e.Delta = &domain.Delta{ItemID: it.ID, Text: strings.TrimPrefix(text, it.Text)}
		out = append(out, e)
	}
	it.Text = text
	if done {
		it.Status = domain.ItemCompleted
	}
	if !reflect.DeepEqual(before, *it) {
		out = append(out, m.updated(it))
	}
	return out
}
func (m *mapper) tool(id string, apply func(*domain.Item)) []domain.Event {
	if id == "" {
		return nil
	}
	it, out := m.item(id, domain.ItemToolCall)
	before := *it
	apply(it)
	it.Kind = toolKind(it.Name)
	if !reflect.DeepEqual(before, *it) {
		out = append(out, m.updated(it))
	}
	return out
}
func toolKind(name string) domain.ItemKind {
	switch name {
	case "shell", "bash":
		return domain.ItemCommand
	case "write", "edit", "apply_patch", "patch":
		return domain.ItemFileChange
	case "subagent", "task":
		return domain.ItemSubagent
	}
	return domain.ItemToolCall
}
func setInput(it *domain.Item, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	it.Input = raw
	var input struct {
		Path     string `json:"path"`
		FilePath string `json:"filePath"`
	}
	_ = json.Unmarshal(raw, &input)
	it.Path = input.Path
	if it.Path == "" {
		it.Path = input.FilePath
	}
}
func setMetadata(it *domain.Item, raw json.RawMessage) {
	var meta struct {
		Files []struct {
			Patch string `json:"patch"`
		} `json:"files"`
		Exit      *float64 `json:"exit"`
		SessionID string   `json:"sessionID"`
	}
	if json.Unmarshal(raw, &meta) != nil {
		return
	}
	var diff []string
	for _, f := range meta.Files {
		diff = append(diff, f.Patch)
	}
	if len(diff) > 0 {
		it.Diff = strings.Join(diff, "\n")
	}
	if meta.Exit != nil {
		code := int(*meta.Exit)
		it.ExitCode = &code
	}
	if meta.SessionID != "" {
		it.AgentID = meta.SessionID
	}
}
func outputText(parts []toolOutput) string {
	var text []string
	for _, p := range parts {
		if p.Type == "text" {
			text = append(text, p.Text)
		}
	}
	return strings.Join(text, "\n")
}

// message replays one stored message. A block is stored when it starts and
// filled when it ends, so an empty one is still streaming.
func (m *mapper) message(msg message) []domain.Event {
	var out []domain.Event
	switch msg.Type {
	case "user":
		if !m.replayUsers || msg.Text == "" {
			return nil
		}
		it, created := m.item(msg.ID, domain.ItemUserMessage)
		before := *it
		it.Text, it.Status = msg.Text, domain.ItemCompleted
		out = created
		if !reflect.DeepEqual(before, *it) {
			out = append(out, m.updated(it))
		}
	case "assistant":
		ordinals := map[string]int{}
		for _, c := range msg.Content {
			switch c.Type {
			case "text", "reasoning":
				key := blockKey(msg.ID, c.Type, ordinals[c.Type])
				ordinals[c.Type]++
				out = append(out, m.text(key, blockKind(c.Type), c.Text, c.Text != "")...)
			case "tool":
				out = append(out, m.tool(c.ID, func(it *domain.Item) {
					it.Name = c.Name
					if c.State.Status != "streaming" {
						setInput(it, c.State.Input)
					}
					setMetadata(it, c.State.Metadata)
					switch c.State.Status {
					case "completed":
						it.Text = outputText(c.State.Content)
						it.Status = domain.ItemCompleted
					case "error":
						if c.State.Error != nil {
							it.Text = c.State.Error.Message
						}
						it.Status = domain.ItemFailed
					}
				})...)
			}
		}
		if msg.Error != nil && msg.Error.Type != "aborted" {
			out = append(out, m.fail(msg.Error.Message)...)
		}
	}
	return out
}
func (m *mapper) setUsage(cost float64, t tokens) []domain.Event {
	next := domain.Usage{InputTokens: t.Input + t.Cache.Read + t.Cache.Write, OutputTokens: t.Output + t.Reasoning, CostUSD: cost}
	next.TotalTokens = next.InputTokens + next.OutputTokens
	if next == m.usage {
		return nil
	}
	m.usage = next
	e := m.ev(domain.EventUsage)
	e.Usage = &next
	return []domain.Event{e}
}

// idle ends the current turn, completing whatever it left streaming.
func (m *mapper) idle() []domain.Event {
	if m.turn == "" {
		return nil
	}
	var out []domain.Event
	var text []string
	for _, key := range m.order {
		it := m.items[key]
		if it.TurnID != m.turn {
			continue
		}
		if !it.Status.Terminal() {
			it.Status = domain.ItemCompleted
			out = append(out, m.updated(it))
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
	return []domain.Event{m.updated(it)}
}

func (f field) question() string {
	for _, s := range []string{f.Description, f.Title} {
		if s != "" {
			return s
		}
	}
	return f.Key
}

// choices are the options shown for a field; a boolean becomes Yes/No.
func (f field) choices() []option {
	if f.Type == "boolean" {
		return []option{{Value: "true", Label: "Yes"}, {Value: "false", Label: "No"}}
	}
	return f.Options
}

// asks reports whether the field is shown as a question. External fields
// point to a URL and cannot be answered here.
func (f field) asks() bool { return !f.Hidden && f.Type != "external" }

func (m *mapper) openRequest(p request) []domain.Event {
	if p.ID == "" {
		return nil
	}
	if _, ok := m.requests[p.ID]; ok {
		return nil
	}
	m.requests[p.ID] = p
	req := domain.Request{ID: domain.RequestID(p.ID), SessionID: m.session, TurnID: m.turn, Kind: domain.RequestPermission, State: domain.RequestPending, Title: p.Action, Prompt: strings.Join(p.Resources, "\n")}
	rules := []map[string]string{}
	patterns := p.Save
	if len(patterns) == 0 {
		patterns = p.Resources
	}
	for _, pattern := range patterns {
		rules = append(rules, map[string]string{"toolName": p.Action, "ruleContent": pattern})
	}
	payload := map[string]any{"toolName": p.Action, "input": p.Metadata, "suggestions": []any{map[string]any{"type": "addRules", "rules": rules}}}
	if p.Form {
		req.Kind = domain.RequestQuestion
		req.Title, req.Prompt = p.Title, ""
		questions := []map[string]any{}
		for _, f := range p.Fields {
			if !f.asks() {
				continue
			}
			if len(questions) == 0 && f.Title != "" {
				req.Title = f.Title
			}
			options := []map[string]string{}
			for _, o := range f.choices() {
				options = append(options, map[string]string{"label": o.Label, "description": o.Description})
			}
			custom := f.Custom
			if len(options) == 0 {
				free := true
				custom = &free
			}
			questions = append(questions, map[string]any{"question": f.question(), "header": f.Title, "options": options, "multiSelect": f.Type == "multiselect", "custom": custom})
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
