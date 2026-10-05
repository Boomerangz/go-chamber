package codex

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// Mapper translates app-server notifications into normalized domain events.
type Mapper struct {
	session domain.SessionID
	turn    domain.TurnID
	items   map[domain.ItemID]*domain.Item
	spawned map[string]bool
	// IncludeUserMessages maps Codex's userMessage items. Off for sessions
	// the user drives (go-chamber records their messages itself), on for
	// subagent threads, whose prompts only Codex knows.
	IncludeUserMessages bool
	// hooks maps a running hook run id to its item; run ids repeat.
	hooks   map[string]domain.ItemID
	hookSeq int
	errSeq  int
	// rateLimits is the last rate-limit notification; Codex repeats it
	// unchanged many times per turn.
	rateLimits string
}

func NewMapper(session domain.SessionID) *Mapper {
	return &Mapper{
		session: session, items: map[domain.ItemID]*domain.Item{}, spawned: map[string]bool{},
		hooks: map[string]domain.ItemID{},
	}
}

func (m *Mapper) SetTurn(turn domain.TurnID) { m.turn = turn }

// FailUnfinished marks every unfinished item failed, for a turn whose
// server died under it.
func (m *Mapper) FailUnfinished() []domain.Event {
	var events []domain.Event
	for _, item := range m.items {
		if item.SetStatus(domain.ItemFailed) == nil {
			events = append(events, domain.Event{SessionID: m.session, Type: domain.EventItemUpdated, Item: item})
		}
	}
	return domain.DetachItems(events)
}

// MapNotification maps one server notification. Unknown methods are ignored.
func (m *Mapper) MapNotification(method string, params json.RawMessage) []domain.Event {
	return domain.DetachItems(m.mapNotification(method, params))
}

func (m *Mapper) mapNotification(method string, params json.RawMessage) []domain.Event {
	switch method {
	case "hook/started", "hook/completed":
		var n hookNotification
		if err := json.Unmarshal(params, &n); err != nil || n.Run.ID == "" || n.Run.EventName == "" {
			return nil
		}
		return m.mapHook(n.Run, method == "hook/completed")
	case "item/started":
		var n itemNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		item, _, refreshed := m.apply(n.Item, false)
		if item == nil {
			return nil
		}
		return append(refreshed, m.spawns(n.Item)...)
	case "item/completed":
		var n itemNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		item, _, refreshed := m.apply(n.Item, true)
		if item == nil {
			return nil
		}
		// receiverThreadIds may only be known once the spawn completes.
		return append(refreshed, m.spawns(n.Item)...)
	case "error":
		var n errorNotification
		if err := json.Unmarshal(params, &n); err != nil || n.WillRetry || n.Error.Message == "" {
			return nil
		}
		return m.errorItem(n.Error.Message)
	case "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta", "item/plan/delta":
		var n deltaNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		return m.delta(n, reasoningOrCommand(method))
	case "item/fileChange/patchUpdated":
		var n patchUpdatedNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		item, _, refreshed := m.apply(rpcItem{
			Type: "fileChange", ID: n.ItemID, Changes: n.Changes,
		}, false)
		if item == nil {
			return nil
		}
		return refreshed
	case "turn/started":
		var n turnNotification
		if err := json.Unmarshal(params, &n); err == nil && n.Turn.ID != "" {
			m.turn = domain.TurnID(n.Turn.ID)
		}
		return nil
	case "turn/completed":
		var n turnNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		var events []domain.Event
		for _, it := range n.Turn.Items {
			if item, _, refreshed := m.apply(it, true); item != nil {
				events = append(events, refreshed...)
			}
		}
		events = append(events, domain.Event{SessionID: m.session, Type: domain.EventTurnEnded, Result: turnResult(n.Turn)})
		return events
	case "turn/plan/updated":
		var n planUpdatedNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		return m.planItem(n.TurnID, n.Plan, n.Explanation)
	case "thread/tokenUsage/updated":
		var n tokenUsageNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		return []domain.Event{{SessionID: m.session, Type: domain.EventUsage, Usage: &domain.Usage{
			InputTokens: n.TokenUsage.Total.InputTokens, OutputTokens: n.TokenUsage.Total.OutputTokens,
			TotalTokens: n.TokenUsage.Total.TotalTokens,
		}}}
	case "serverRequest/resolved":
		var n resolvedNotification
		if err := json.Unmarshal(params, &n); err != nil {
			return nil
		}
		id := domain.RequestID(idKey(n.RequestID))
		if id == "" {
			return nil
		}
		return []domain.Event{{
			SessionID: m.session, Type: domain.EventRequestResolved,
			Request: &domain.Request{ID: id, SessionID: m.session, Kind: domain.RequestPermission, State: domain.RequestResolved},
		}}
	}
	return nil
}

// MapGlobalNotification maps account-wide notifications that carry no
// threadId and must be broadcast to every session.
func (m *Mapper) MapGlobalNotification(method string, params json.RawMessage) []domain.Event {
	if method != "account/rateLimits/updated" || string(params) == m.rateLimits {
		return nil
	}
	var n struct {
		RateLimits rateLimitSnapshot `json:"rateLimits"`
	}
	if err := json.Unmarshal(params, &n); err != nil {
		return nil
	}
	m.rateLimits = string(params)
	q := quotaFromSnapshot(n.RateLimits)
	return []domain.Event{{SessionID: m.session, Type: domain.EventQuota, Quota: &q}}
}

func quotaFromSnapshot(s rateLimitSnapshot) domain.QuotaSnapshot {
	q := domain.QuotaSnapshot{
		Agent: domain.AgentCodex, Plan: s.PlanType, Reached: s.RateLimitReachedType != "",
		UpdatedAt: time.Now().UTC(),
	}
	add := func(name string, w *rateLimitWindow) {
		if w == nil {
			return
		}
		window := domain.QuotaWindow{Name: name, UsedPct: clampPct(float64(w.UsedPercent))}
		if w.ResetsAt != nil {
			window.ResetsAt = time.Unix(*w.ResetsAt, 0).UTC()
		}
		if w.WindowDurationMins != nil {
			window.Status = fmt.Sprintf("%dm", *w.WindowDurationMins)
		}
		q.Windows = append(q.Windows, window)
	}
	add("primary", s.Primary)
	add("secondary", s.Secondary)
	return q
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

// MapServerRequest maps a server-initiated request into a blocking request.
func (m *Mapper) MapServerRequest(method string, id json.RawMessage, params json.RawMessage) (domain.Event, bool) {
	requestID := domain.RequestID(idKey(id))
	if requestID == "" {
		return domain.Event{}, false
	}
	kind := domain.RequestPermission
	title := ""
	var payload json.RawMessage
	switch method {
	case "item/commandExecution/requestApproval":
		var p commandApprovalParams
		if json.Unmarshal(params, &p) != nil {
			return domain.Event{}, false
		}
		title = "Run command"
		if p.Command != "" {
			title = p.Command
		}
		payload = mustJSON(map[string]any{"itemId": p.ItemID, "toolName": "command", "reason": p.Reason,
			"input": map[string]any{"command": p.Command}})
	case "item/fileChange/requestApproval":
		var p fileApprovalParams
		if json.Unmarshal(params, &p) != nil {
			return domain.Event{}, false
		}
		title = "Apply file change"
		// The request carries no path; the fileChange item streamed before it does.
		input := map[string]any{"path": p.GrantRoot}
		if item := m.items[domain.ItemID(p.ItemID)]; item != nil && item.Path != "" {
			input = map[string]any{"path": item.Path, "diff": item.Diff}
		}
		payload = mustJSON(map[string]any{"itemId": p.ItemID, "reason": p.Reason, "grantRoot": p.GrantRoot,
			"toolName": "fileChange", "input": input})
	case "item/permissions/requestApproval":
		title = "Grant permissions"
		payload = params
	case "item/tool/requestUserInput":
		var p userInputParams
		if json.Unmarshal(params, &p) != nil {
			return domain.Event{}, false
		}
		kind = domain.RequestQuestion
		title = "Question"
		payload = mustJSON(map[string]any{"itemId": p.ItemID, "toolName": "requestUserInput",
			"input": map[string]any{"questions": inputQuestions(p.Questions)}})
	case "mcpServer/elicitation/request":
		var p elicitationParams
		if json.Unmarshal(params, &p) != nil {
			return domain.Event{}, false
		}
		kind = domain.RequestElicitation
		title = p.ServerName
		if p.Message != "" {
			title = p.Message
		}
		payload = params
	default:
		return domain.Event{}, false
	}
	return domain.Event{
		SessionID: m.session, Type: domain.EventRequestOpened,
		Request: &domain.Request{
			ID: requestID, SessionID: m.session, Kind: kind,
			Title: title, Payload: payload, State: domain.RequestPending,
		},
	}, true
}

// MapThread turns a thread's existing turns into item events, restoring the
// conversation after resume.
func (m *Mapper) MapThread(thread rpcThread) []domain.Event {
	var events []domain.Event
	for _, turn := range thread.Turns {
		for _, it := range turn.Items {
			item, _, refreshed := m.apply(it, true)
			if item != nil {
				events = append(events, refreshed...)
			}
		}
	}
	return events
}

// spawns reports child sessions for a Codex collab agent tool call.
func (m *Mapper) spawns(it rpcItem) []domain.Event {
	if it.Type != "collabAgentToolCall" {
		return nil
	}
	title := "subagent"
	if it.Prompt != nil && *it.Prompt != "" {
		title = *it.Prompt
	}
	var out []domain.Event
	for _, threadID := range it.ReceiverThreadIDs {
		if threadID == "" || m.spawned[threadID] {
			continue
		}
		m.spawned[threadID] = true
		out = append(out, domain.Event{
			SessionID: m.session, Type: domain.EventSubagentSpawned,
			Subagent: &domain.SubagentSpawn{ThreadID: threadID, Title: title},
		})
	}
	return out
}

// commandOutputCap matches the ~1 MiB Codex keeps of a command's aggregated
// output. Output streamed past it is dropped by the final item anyway, and
// every client flush re-copied the whole growing text.
const commandOutputCap = 1 << 20

func (m *Mapper) delta(n deltaNotification, kind domain.ItemKind) []domain.Event {
	item, _, refreshed := m.ensure(n.ItemID, kind)
	if item == nil {
		return nil
	}
	events := refreshed
	if n.Delta != "" && (kind != domain.ItemCommand || len(item.Text) < commandOutputCap) {
		item.AppendText(n.Delta)
		events = append(events, domain.Event{
			SessionID: m.session, Type: domain.EventTextDelta,
			Delta: &domain.Delta{ItemID: item.ID, Text: n.Delta},
		})
	}
	return events
}

func (m *Mapper) planItem(turnID string, plan []rpcPlanStep, explanation *string) []domain.Event {
	if len(plan) == 0 {
		return nil
	}
	id := domain.ItemID("plan-" + turnID)
	item, created, refreshed := m.ensure(string(id), domain.ItemPlan)
	if item == nil {
		return nil
	}
	var b strings.Builder
	for _, step := range plan {
		fmt.Fprintf(&b, "- [%s] %s\n", step.Status, step.Step)
	}
	if explanation != nil && *explanation != "" {
		b.WriteString("\n" + *explanation)
	}
	item.Text = b.String()
	events := refreshed
	if !created {
		events = []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
	}
	return events
}

func (m *Mapper) ensure(nativeID string, kind domain.ItemKind) (*domain.Item, bool, []domain.Event) {
	if nativeID == "" {
		return nil, false, nil
	}
	if item := m.items[domain.ItemID(nativeID)]; item != nil {
		return item, false, nil
	}
	item, err := domain.NewItem(domain.ItemID(nativeID), m.session, m.turn, "", kind)
	if err != nil {
		return nil, false, nil
	}
	m.items[item.ID] = item
	return item, true, []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
}

func (m *Mapper) apply(it rpcItem, final bool) (*domain.Item, bool, []domain.Event) {
	kind, ok := itemKind(it.Type)
	if !ok || it.ID == "" || (kind == domain.ItemUserMessage && !m.IncludeUserMessages) {
		return nil, false, nil
	}
	item, created, events := m.ensure(it.ID, kind)
	if item == nil {
		return nil, false, nil
	}
	applyItemFields(item, it)
	if !item.Status.Terminal() {
		if final {
			if it.Status == "failed" || it.Status == "declined" {
				_ = item.SetStatus(domain.ItemFailed)
			} else {
				_ = item.SetStatus(domain.ItemCompleted)
			}
		} else if isStreamingKind(kind) {
			_ = item.SetStatus(domain.ItemStreaming)
		}
	}
	if created {
		return item, true, events
	}
	return item, false, []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
}

func itemKind(t string) (domain.ItemKind, bool) {
	switch t {
	case "userMessage":
		return domain.ItemUserMessage, true
	case "agentMessage":
		return domain.ItemAssistantMessage, true
	case "reasoning":
		return domain.ItemReasoning, true
	case "plan":
		return domain.ItemPlan, true
	case "commandExecution":
		return domain.ItemCommand, true
	case "fileChange":
		return domain.ItemFileChange, true
	case "functionCallOutput", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "imageView":
		return domain.ItemToolCall, true
	case "collabAgentToolCall", "subAgentActivity":
		return domain.ItemSubagent, true
	}
	return "", false
}

func isStreamingKind(kind domain.ItemKind) bool {
	return kind == domain.ItemAssistantMessage || kind == domain.ItemReasoning || kind == domain.ItemPlan
}

func reasoningOrCommand(method string) domain.ItemKind {
	switch method {
	case "item/agentMessage/delta":
		return domain.ItemAssistantMessage
	case "item/commandExecution/outputDelta":
		return domain.ItemCommand
	case "item/plan/delta":
		return domain.ItemPlan
	default:
		return domain.ItemReasoning
	}
}

func applyItemFields(item *domain.Item, it rpcItem) {
	switch it.Type {
	case "userMessage":
		item.Text = joinText(it.Content)
	case "agentMessage", "plan":
		item.Text = it.Text
	case "reasoning":
		item.Text = reasoningText(it)
	case "commandExecution":
		item.Name = "command"
		item.Input = mustJSON(map[string]any{"command": it.Command})
		if it.AggregatedOutput != nil {
			item.Text = *it.AggregatedOutput
		}
		item.ExitCode = it.ExitCode
	case "fileChange":
		item.Name = "fileChange"
		if len(it.Changes) > 0 {
			item.Path = it.Changes[0].Path
			item.Diff = it.Changes[0].Diff
		}
	case "functionCallOutput":
		item.Name = it.Name
		item.Text = outputText(it.Output)
	case "mcpToolCall":
		item.Name = strings.Trim(strings.Join([]string{it.Server, it.Tool}, "/"), "/")
		item.Input = it.Arguments
	case "dynamicToolCall":
		item.Name = it.Tool
		item.Input = it.Arguments
	case "webSearch":
		item.Name = "webSearch"
		item.Text = it.Query
	case "collabAgentToolCall", "subAgentActivity":
		item.Name = "agent"
		item.AgentID = it.AgentThreadID
		if it.Prompt != nil {
			item.Text = *it.Prompt
		}
	}
}

func joinText(parts []rpcTextPart) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Type == "text" {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func reasoningText(it rpcItem) string {
	var b strings.Builder
	for _, p := range it.Summary {
		b.WriteString(p.Text)
	}
	for _, p := range it.Content {
		b.WriteString(p.Text)
	}
	return b.String()
}

func outputText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []rpcTextPart
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return string(raw)
}

func turnResult(turn rpcTurn) *domain.TurnResult {
	res := &domain.TurnResult{IsError: turn.Status == "failed"}
	if turn.Error != nil {
		res.IsError = true
		res.Error = turn.Error.Message
	}
	for _, it := range turn.Items {
		if it.Type == "agentMessage" {
			res.Text += it.Text
		}
	}
	return res
}

func inputQuestions(questions []inputQuestion) []map[string]any {
	out := make([]map[string]any, 0, len(questions))
	for _, q := range questions {
		options := make([]map[string]string, 0, len(q.Options))
		for _, o := range q.Options {
			options = append(options, map[string]string{"label": o.Label, "description": o.Description})
		}
		out = append(out, map[string]any{
			"id":       q.ID,
			"question": q.Question,
			"header":   q.Header,
			"options":  options,
		})
	}
	return out
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

// errorItem shows a turn error app-server gave up retrying.
func (m *Mapper) errorItem(message string) []domain.Event {
	m.errSeq++
	item, err := domain.NewItem(domain.ItemID(fmt.Sprintf("error-%d", m.errSeq)), m.session, m.turn, "", domain.ItemError)
	if err != nil {
		return nil
	}
	item.Text = message
	_ = item.SetStatus(domain.ItemFailed)
	m.items[item.ID] = item
	return []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
}

type hookNotification struct {
	Run rpcHookRun `json:"run"`
}

type rpcHookRun struct {
	ID            string `json:"id"`
	EventName     string `json:"eventName"`
	Status        string `json:"status"`
	StatusMessage string `json:"statusMessage"`
	Entries       []struct {
		Kind string `json:"kind"`
		Text string `json:"text"`
	} `json:"entries"`
}

// mapHook shows a user-configured hook run. "blocked" and "stopped" mean
// the hook stopped the agent (its feedback goes back to the model).
func (m *Mapper) mapHook(run rpcHookRun, done bool) []domain.Event {
	item := m.items[m.hooks[run.ID]]
	if item == nil {
		m.hookSeq++
		item, _ = domain.NewItem(domain.ItemID(fmt.Sprintf("hook-%d", m.hookSeq)), m.session, m.turn, "", domain.ItemHook)
		item.Name = strings.ToUpper(run.EventName[:1]) + run.EventName[1:]
		m.items[item.ID] = item
		m.hooks[run.ID] = item.ID
	}
	if !done {
		_ = item.SetStatus(domain.ItemStreaming)
		return []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
	}
	delete(m.hooks, run.ID)
	texts := make([]string, 0, len(run.Entries))
	for _, e := range run.Entries {
		if e.Text != "" {
			texts = append(texts, e.Text)
		}
	}
	item.Text = strings.Join(texts, "\n")
	if item.Text == "" {
		item.Text = run.StatusMessage
	}
	switch run.Status {
	case "blocked", "stopped":
		item.Outcome = domain.HookBlocked
		_ = item.SetStatus(domain.ItemCompleted)
	case "failed":
		item.Outcome = domain.HookError
		_ = item.SetStatus(domain.ItemFailed)
	default:
		item.Outcome = domain.HookSuccess
		_ = item.SetStatus(domain.ItemCompleted)
	}
	return []domain.Event{{SessionID: m.session, Type: domain.EventItemUpdated, Item: item}}
}
