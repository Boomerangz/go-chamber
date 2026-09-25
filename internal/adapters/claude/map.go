package claude

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// pendingRequest remembers a can_use_tool request so the runtime can answer it.
type pendingRequest struct {
	kind        domain.RequestKind
	toolName    string
	input       json.RawMessage
	suggestions json.RawMessage
	toolUseID   string
}

// Mapper translates Claude Code stream-json protocol messages into the
// normalized domain events. It is stateful: it correlates streamed blocks
// with the assistant messages and tool results that complete them.
type Mapper struct {
	session domain.SessionID
	turn    domain.TurnID

	next           int
	currentMessage string
	byKey          map[string]domain.ItemID
	byTool         map[string]domain.ItemID
	items          map[domain.ItemID]*domain.Item
	inputBuf       map[string]string
	pending        map[domain.RequestID]pendingRequest
	tasks          map[string]domain.ItemID
}

func NewMapper(session domain.SessionID) *Mapper {
	return &Mapper{
		session:  session,
		byKey:    map[string]domain.ItemID{},
		byTool:   map[string]domain.ItemID{},
		items:    map[domain.ItemID]*domain.Item{},
		inputBuf: map[string]string{},
		pending:  map[domain.RequestID]pendingRequest{},
		tasks:    map[string]domain.ItemID{},
	}
}

// TakePending returns and forgets a remembered can_use_tool request.
func (m *Mapper) TakePending(id domain.RequestID) (pendingRequest, bool) {
	p, ok := m.pending[id]
	delete(m.pending, id)
	return p, ok
}

// SetTurn sets the turn id stamped on items produced from now on.
func (m *Mapper) SetTurn(turn domain.TurnID) { m.turn = turn }

// Map parses one NDJSON protocol message into zero or more domain events.
func (m *Mapper) Map(line []byte) ([]domain.Event, error) {
	var raw rawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		return nil, fmt.Errorf("claude: parse message: %w", err)
	}
	switch raw.Type {
	case "stream_event":
		return m.mapStream(&raw), nil
	case "assistant":
		return m.mapAssistant(&raw), nil
	case "user":
		return m.mapUser(&raw), nil
	case "result":
		return m.mapResult(&raw), nil
	case "control_request":
		return m.mapControlRequest(&raw), nil
	case "control_cancel_request":
		return m.mapControlCancel(&raw), nil
	case "system":
		return m.mapSystem(&raw), nil
	case "rate_limit_event":
		return m.mapRateLimit(&raw), nil
	default:
		// system/init, control_response, rate_limit_event and future message
		// types carry no normalized events in this phase.
		return nil, nil
	}
}

// mapControlRequest turns a can_use_tool prompt into a blocking request.
func (m *Mapper) mapControlRequest(raw *rawMessage) []domain.Event {
	if raw.RequestID == "" {
		return nil
	}
	var req rawPermissionRequest
	if err := json.Unmarshal(raw.Request, &req); err != nil {
		return nil
	}
	if req.Subtype != "can_use_tool" {
		return nil
	}
	id := domain.RequestID(raw.RequestID)
	kind := domain.RequestPermission
	if req.ToolName == "AskUserQuestion" {
		kind = domain.RequestQuestion
	}
	m.pending[id] = pendingRequest{
		kind: kind, toolName: req.ToolName, input: req.Input,
		suggestions: req.PermissionSuggestions, toolUseID: req.ToolUseID,
	}
	title := req.Title
	if title == "" {
		title = req.DisplayName
	}
	if title == "" {
		title = req.ToolName
	}
	payload, _ := json.Marshal(map[string]any{
		"toolName":    req.ToolName,
		"input":       req.Input,
		"suggestions": req.PermissionSuggestions,
		"toolUseId":   req.ToolUseID,
		"agentId":     req.AgentID,
	})
	return []domain.Event{{
		SessionID: m.session, Type: domain.EventRequestOpened,
		Request: &domain.Request{
			ID: id, SessionID: m.session, TurnID: m.turn, Kind: kind,
			Title: title, Prompt: req.Description, Payload: payload,
			State: domain.RequestPending,
		},
	}}
}

// mapControlCancel closes a request another client or the agent withdrew.
func (m *Mapper) mapControlCancel(raw *rawMessage) []domain.Event {
	id := domain.RequestID(raw.RequestID)
	if id == "" {
		return nil
	}
	delete(m.pending, id)
	req := &domain.Request{
		ID: id, SessionID: m.session, Kind: domain.RequestPermission,
		State: domain.RequestStale,
	}
	return []domain.Event{{SessionID: m.session, Type: domain.EventRequestResolved, Request: req}}
}

func blockKey(msgID, parent string, index int) string {
	return parent + "|" + msgID + "|" + strconv.Itoa(index)
}

func parentOf(raw *rawMessage) string {
	if raw.ParentToolUseID == nil {
		return ""
	}
	return *raw.ParentToolUseID
}

func (m *Mapper) create(kind domain.ItemKind, parentToolID string) *domain.Item {
	var parent domain.ItemID
	if parentToolID != "" {
		parent = m.byTool[parentToolID]
	}
	m.next++
	item, _ := domain.NewItem(domain.ItemID(fmt.Sprintf("it-%d", m.next)), m.session, m.turn, parent, kind)
	m.items[item.ID] = item
	return item
}

func (m *Mapper) updated(item *domain.Item) []domain.Event {
	return []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
}

func (m *Mapper) mapStream(raw *rawMessage) []domain.Event {
	var env rawStreamEnvelope
	if err := json.Unmarshal(raw.Event, &env); err != nil {
		return nil
	}
	parent := parentOf(raw)
	switch env.Type {
	case "message_start":
		var msg rawStreamMessage
		if err := json.Unmarshal(env.Message, &msg); err == nil && msg.ID != "" {
			m.currentMessage = msg.ID
		}
	case "content_block_start":
		return m.startBlock(env, parent)
	case "content_block_delta":
		return m.blockDelta(env, parent)
	case "content_block_stop":
		return m.stopBlock(env, parent)
	}
	return nil
}

func (m *Mapper) startBlock(env rawStreamEnvelope, parent string) []domain.Event {
	var block rawBlock
	if err := json.Unmarshal(env.ContentBlock, &block); err != nil {
		return nil
	}
	key := blockKey(m.currentMessage, parent, env.Index)
	switch block.Type {
	case "text", "thinking":
		kind := domain.ItemAssistantMessage
		if block.Type == "thinking" {
			kind = domain.ItemReasoning
		}
		item := m.create(kind, parent)
		_ = item.SetStatus(domain.ItemStreaming)
		m.byKey[key] = item.ID
		return m.updated(item)
	case "tool_use":
		item := m.create(toolKind(block.Name), parent)
		item.Name = block.Name
		m.byKey[key] = item.ID
		m.byTool[block.ID] = item.ID
		return m.updated(item)
	}
	return nil
}

func (m *Mapper) blockDelta(env rawStreamEnvelope, parent string) []domain.Event {
	var delta rawStreamDelta
	if err := json.Unmarshal(env.Delta, &delta); err != nil {
		return nil
	}
	key := blockKey(m.currentMessage, parent, env.Index)
	item := m.items[m.byKey[key]]
	if item == nil {
		return nil
	}
	switch delta.Type {
	case "text_delta":
		item.AppendText(delta.Text)
		return m.delta(item, delta.Text)
	case "thinking_delta":
		item.AppendText(delta.Thinking)
		return m.delta(item, delta.Thinking)
	case "input_json_delta":
		m.inputBuf[key] += delta.PartialJSON
	}
	return nil
}

func (m *Mapper) delta(item *domain.Item, text string) []domain.Event {
	if text == "" {
		return nil
	}
	return []domain.Event{{
		SessionID: m.session,
		Type:      domain.EventTextDelta,
		Delta:     &domain.Delta{ItemID: item.ID, Text: text},
	}}
}

func (m *Mapper) stopBlock(env rawStreamEnvelope, parent string) []domain.Event {
	key := blockKey(m.currentMessage, parent, env.Index)
	item := m.items[m.byKey[key]]
	if item == nil {
		return nil
	}
	switch item.Kind {
	case domain.ItemAssistantMessage, domain.ItemReasoning:
		if !item.Status.Terminal() {
			_ = item.SetStatus(domain.ItemCompleted)
			return m.updated(item)
		}
	case domain.ItemToolCall, domain.ItemCommand, domain.ItemFileChange, domain.ItemSubagent:
		if buf := m.inputBuf[key]; buf != "" && len(item.Input) == 0 {
			item.Input = json.RawMessage(buf)
			m.applyToolFields(item)
			return m.updated(item)
		}
	}
	return nil
}

func (m *Mapper) mapAssistant(raw *rawMessage) []domain.Event {
	var msg rawContentMessage
	if err := json.Unmarshal(raw.Message, &msg); err != nil {
		return nil
	}
	if msg.ID != "" {
		m.currentMessage = msg.ID
	}
	parent := parentOf(raw)
	var (
		events []domain.Event
		items  []*domain.Item
	)
	for i, block := range msg.Content {
		key := blockKey(msg.ID, parent, i)
		switch block.Type {
		case "text":
			item := m.ensureText(key, parent, domain.ItemAssistantMessage)
			if item.Text != block.Text {
				item.Text = block.Text
			}
			items = append(items, item)
		case "thinking":
			item := m.ensureText(key, parent, domain.ItemReasoning)
			if item.Text != block.Thinking {
				item.Text = block.Thinking
			}
			items = append(items, item)
		case "tool_use":
			item := m.ensureTool(key, parent, block)
			items = append(items, item)
		}
	}
	for _, item := range items {
		if isTextKind(item.Kind) && !item.Status.Terminal() {
			_ = item.SetStatus(domain.ItemCompleted)
		}
		events = append(events, m.updated(item)...)
	}
	return events
}

func isTextKind(kind domain.ItemKind) bool {
	return kind == domain.ItemAssistantMessage || kind == domain.ItemReasoning || kind == domain.ItemPlan
}

func (m *Mapper) ensureText(key, parent string, kind domain.ItemKind) *domain.Item {
	if item := m.items[m.byKey[key]]; item != nil {
		return item
	}
	item := m.create(kind, parent)
	m.byKey[key] = item.ID
	_ = item.SetStatus(domain.ItemStreaming)
	return item
}

func (m *Mapper) ensureTool(key, parent string, block rawBlock) *domain.Item {
	item := m.items[m.byKey[key]]
	if item == nil {
		item = m.items[m.byTool[block.ID]]
	}
	if item == nil {
		item = m.create(toolKind(block.Name), parent)
		m.byTool[block.ID] = item.ID
		m.byKey[key] = item.ID
	}
	item.Name = block.Name
	if len(block.Input) > 0 {
		item.Input = block.Input
	}
	m.applyToolFields(item)
	return item
}

func (m *Mapper) applyToolFields(item *domain.Item) {
	switch item.Kind {
	case domain.ItemFileChange:
		item.Path = inputString(item.Input, "file_path", "path", "notebook_path")
	case domain.ItemSubagent:
		item.AgentID = inputString(item.Input, "subagent_type")
	}
}

func (m *Mapper) mapUser(raw *rawMessage) []domain.Event {
	var msg rawContentMessage
	if err := json.Unmarshal(raw.Message, &msg); err != nil {
		return nil
	}
	var events []domain.Event
	for _, block := range msg.Content {
		if block.Type != "tool_result" {
			continue
		}
		item := m.items[m.byTool[block.ToolUseID]]
		if item == nil {
			continue
		}
		item.Text = textFromToolResult(block.Content)
		if item.Kind == domain.ItemCommand && item.ExitCode == nil {
			code := 0
			if block.IsError {
				code = 1
			}
			item.ExitCode = &code
		}
		if block.IsError {
			_ = item.SetStatus(domain.ItemFailed)
		} else {
			_ = item.SetStatus(domain.ItemCompleted)
		}
		events = append(events, m.updated(item)...)
	}
	return events
}

// mapRateLimit turns a subscription rate-limit update into a quota snapshot.
func (m *Mapper) mapRateLimit(raw *rawMessage) []domain.Event {
	info := raw.RateLimitInfo
	if info == nil || info.RateLimitType == "" {
		return nil
	}
	window := domain.QuotaWindow{Name: info.RateLimitType, Status: info.Status}
	if info.ResetsAt != nil {
		window.ResetsAt = time.Unix(*info.ResetsAt, 0).UTC()
	}
	if info.Utilization != nil {
		pct := *info.Utilization
		if pct <= 1 {
			pct *= 100
		}
		window.UsedPct = clampPct(pct)
	}
	snapshot := domain.QuotaSnapshot{
		Agent: domain.AgentClaude, Windows: []domain.QuotaWindow{window},
		Reached: info.Status == "rejected", UpdatedAt: time.Now().UTC(),
	}
	return []domain.Event{{SessionID: m.session, Type: domain.EventQuota, Quota: &snapshot}}
}

func clampPct(pct float64) float64 {
	switch {
	case pct < 0:
		return 0
	case pct > 100:
		return 100
	default:
		return pct
	}
}

// mapSystem handles background subagent task lifecycle messages.
func (m *Mapper) mapSystem(raw *rawMessage) []domain.Event {
	switch raw.Subtype {
	case "task_started":
		return m.mapTaskStarted(raw)
	case "task_notification":
		return m.mapTaskNotification(raw)
	}
	return nil
}

func (m *Mapper) mapTaskStarted(raw *rawMessage) []domain.Event {
	if raw.TaskID == "" {
		return nil
	}
	var item *domain.Item
	if raw.ToolUseID != "" {
		item = m.items[m.byTool[raw.ToolUseID]]
	}
	if item == nil {
		name := raw.SubagentType
		if name == "" {
			name = raw.TaskType
		}
		item = m.create(domain.ItemSubagent, "")
		item.Name = name
		text := raw.Description
		if text == "" {
			text = raw.Prompt
		}
		item.Text = text
		_ = item.SetStatus(domain.ItemStreaming)
	} else if !item.Status.Terminal() {
		_ = item.SetStatus(domain.ItemStreaming)
	}
	item.AgentID = raw.TaskID
	m.tasks[raw.TaskID] = item.ID
	return m.updated(item)
}

func (m *Mapper) mapTaskNotification(raw *rawMessage) []domain.Event {
	item := m.items[m.tasks[raw.TaskID]]
	if item == nil && raw.ToolUseID != "" {
		item = m.items[m.byTool[raw.ToolUseID]]
	}
	if item == nil {
		return nil
	}
	if raw.Summary != "" {
		item.Text = raw.Summary
	}
	if !item.Status.Terminal() {
		if raw.Status == "completed" {
			_ = item.SetStatus(domain.ItemCompleted)
		} else {
			_ = item.SetStatus(domain.ItemFailed)
		}
	}
	return m.updated(item)
}

func (m *Mapper) mapResult(raw *rawMessage) []domain.Event {
	res := &domain.TurnResult{
		Text:    raw.Result,
		IsError: raw.IsError,
		CostUSD: raw.TotalCostUSD,
	}
	switch {
	case len(raw.Errors) > 0:
		res.Error = strings.Join(raw.Errors, "; ")
	case raw.IsError:
		res.Error = raw.Result
	}
	if raw.Usage != nil {
		res.InputTokens = raw.Usage.InputTokens
		res.OutputTokens = raw.Usage.OutputTokens
	}
	return []domain.Event{{SessionID: m.session, Type: domain.EventTurnEnded, Result: res}}
}

func toolKind(name string) domain.ItemKind {
	switch name {
	case "Bash", "BashOutput", "KillShell":
		return domain.ItemCommand
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return domain.ItemFileChange
	case "Task", "Agent":
		return domain.ItemSubagent
	default:
		return domain.ItemToolCall
	}
}

func inputString(raw json.RawMessage, keys ...string) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	for _, k := range keys {
		if s, ok := m[k].(string); ok {
			return s
		}
	}
	return ""
}
