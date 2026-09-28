package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ManagerConfig wires the manager's dependencies.
type ManagerConfig struct {
	Repo     SessionRepo
	Runtimes RuntimeFactory
	Bus      EventBus
	// Accounts optionally reports and starts agent logins.
	Accounts AccountManager
	// Quotas optionally caches quota snapshots; QuotaProvider fetches them.
	Quotas        QuotaRepo
	QuotaProvider QuotaProvider
	// NewID generates session, turn and item ids. Defaults to random hex.
	NewID func() string
	// Now stamps session creation and activity. Defaults to time.Now.
	Now func() time.Time
	// Models optionally lists the models each agent offers.
	Models ModelCatalog
	// History optionally replays the event log; Restore uses it to close
	// requests a previous process left open.
	History EventHistory
	// IdleTimeout closes a Claude process idle this long; the session becomes
	// detached and resumes on the next message. Zero keeps processes alive.
	IdleTimeout time.Duration
}

// EventHistory replays a session's published events.
type EventHistory interface {
	History(session domain.SessionID, since domain.Seq) []domain.Event
}

// Manager is the session use-case boundary: it owns the in-memory registry
// of sessions, lazily attaches agent runtimes and turns runtime events into
// the normalized, sequenced event log.
type Manager struct {
	cfg ManagerConfig

	mu       sync.Mutex
	sessions map[domain.SessionID]*domain.Session
	runtimes map[domain.SessionID]AgentRuntime
	pending  map[domain.SessionID]map[domain.RequestID]*domain.Request
	// restart marks sessions whose runtime must be replaced before the next
	// turn (a model change it couldn't apply live).
	restart map[domain.SessionID]bool
	// idle holds the timers that retire idle Claude processes.
	idle map[domain.SessionID]*idleTimer
	// resume holds the timers that continue quota-interrupted sessions.
	resume map[domain.SessionID]*time.Timer
}

func NewManager(cfg ManagerConfig) *Manager {
	if cfg.NewID == nil {
		cfg.NewID = randomID
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Manager{
		cfg:      cfg,
		sessions: map[domain.SessionID]*domain.Session{},
		runtimes: map[domain.SessionID]AgentRuntime{},
		pending:  map[domain.SessionID]map[domain.RequestID]*domain.Request{},
		restart:  map[domain.SessionID]bool{},
		idle:     map[domain.SessionID]*idleTimer{},
		resume:   map[domain.SessionID]*time.Timer{},
	}
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// CreateSession registers a new detached session and persists it.
func (m *Manager) CreateSession(ctx context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error) {
	id := domain.SessionID(m.cfg.NewID())
	s, err := domain.NewSession(id, agent, cwd)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	s.Touch(m.cfg.Now().UTC())
	if err := m.cfg.Repo.Save(ctx, s.Snapshot()); err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()
	return s.Snapshot(), nil
}

// ListSessions returns persisted sessions in creation order.
func (m *Manager) ListSessions(ctx context.Context) ([]domain.SessionSnapshot, error) {
	return m.cfg.Repo.List(ctx)
}

// GetSession returns a snapshot, restoring the session into memory if needed.
func (m *Manager) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	// Runtime goroutines mutate sessions under m.mu.
	m.mu.Lock()
	defer m.mu.Unlock()
	return s.Snapshot(), nil
}

// Restore loads persisted sessions into memory, normalizing statuses left
// over from a previous process (running becomes interrupted, idle detached)
// and persisting the normalized state.
func (m *Manager) Restore(ctx context.Context) ([]domain.SessionSnapshot, error) {
	snaps, err := m.cfg.Repo.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.SessionSnapshot, 0, len(snaps))
	for _, snap := range snaps {
		s, err := domain.RestoreSession(snap)
		if err != nil {
			continue
		}
		m.mu.Lock()
		m.sessions[s.ID()] = s
		m.mu.Unlock()
		cur := s.Snapshot()
		// Whatever the saved status, no process of the previous run can
		// answer its requests any more.
		m.closeLeftoverRequests(cur.ID)
		if cur.AutoContinue {
			m.armAutoContinue(cur.ID, true, cur.Interruption.ResumeAfter)
		}
		if cur != snap {
			if err := m.cfg.Repo.Save(ctx, cur); err != nil {
				return out, err
			}
			// Persisted history must show how the previous run ended.
			m.cfg.Bus.Publish(domain.Event{SessionID: cur.ID, Type: domain.EventSessionState, Session: &cur})
		}
		out = append(out, cur)
	}
	return out, nil
}

// closeLeftoverRequests marks requests the previous process never resolved
// as stale, so replayed history doesn't show them as answerable.
func (m *Manager) closeLeftoverRequests(id domain.SessionID) {
	if m.cfg.History == nil {
		return
	}
	open := map[domain.RequestID]*domain.Request{}
	var order []domain.RequestID
	for _, ev := range m.cfg.History.History(id, 0) {
		switch {
		case ev.Request == nil:
		case ev.Type == domain.EventRequestOpened:
			open[ev.Request.ID] = ev.Request
			order = append(order, ev.Request.ID)
		case ev.Type == domain.EventRequestResolved:
			delete(open, ev.Request.ID)
		}
	}
	for _, rid := range order {
		if req := open[rid]; req != nil {
			delete(open, rid)
			req.MarkStale()
			m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventRequestResolved, Request: req})
		}
	}
}

// SendMessage starts a new turn: it lazily attaches (or resumes) the agent
// runtime, records the user message and forwards it to the agent.
func (m *Manager) SendMessage(ctx context.Context, id domain.SessionID, text string) error {
	s, err := m.session(ctx, id)
	if err != nil {
		return err
	}
	turn := domain.TurnID(m.cfg.NewID())
	m.mu.Lock()
	// A running turn keeps its runtime; the restart waits for the next turn.
	if m.restart[id] && s.Status() != domain.StatusRunning {
		m.retire(s)
	}
	m.mu.Unlock()
	rt, err := m.ensureRuntime(ctx, s)
	if err != nil {
		return err
	}

	m.mu.Lock()
	err = s.TurnStarted()
	if err == nil {
		s.Touch(m.cfg.Now().UTC())
		if s.Title() == "" {
			s.Rename(titleFromText(text))
		}
	}
	snap := s.Snapshot()
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventTurnStarted, Session: &snap})
	if err := m.recordUserItem(ctx, s, turn, text); err != nil {
		return err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return err
	}
	if err := rt.Send(ctx, turn, text); err != nil {
		// The agent never got the turn; don't leave the session running.
		m.mu.Lock()
		_ = s.TurnCompleted()
		snap = s.Snapshot()
		m.mu.Unlock()
		_ = m.cfg.Repo.Save(ctx, snap)
		m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
		return err
	}
	return nil
}

func (m *Manager) recordUserItem(ctx context.Context, s *domain.Session, turn domain.TurnID, text string) error {
	item, err := domain.NewItem(domain.ItemID(m.cfg.NewID()), s.ID(), turn, "", domain.ItemUserMessage)
	if err != nil {
		return err
	}
	item.Text = text
	if err := item.SetStatus(domain.ItemCompleted); err != nil {
		return err
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventItemUpdated, Item: item})
	return nil
}

// Steer appends input to the running turn; an idle session starts a new turn.
func (m *Manager) Steer(ctx context.Context, id domain.SessionID, text string) error {
	s, err := m.session(ctx, id)
	if err != nil {
		return err
	}
	m.mu.Lock()
	rt := m.runtimes[id]
	running := s.Status() == domain.StatusRunning
	m.mu.Unlock()
	if rt == nil || !running {
		return m.SendMessage(ctx, id, text)
	}
	if err := m.recordUserItem(ctx, s, "", text); err != nil {
		return err
	}
	return rt.Steer(ctx, text)
}

// Quotas returns every cached quota snapshot.
func (m *Manager) Quotas(ctx context.Context) ([]domain.QuotaSnapshot, error) {
	if m.cfg.Quotas == nil {
		return nil, nil
	}
	return m.cfg.Quotas.ListQuotas(ctx)
}

// RefreshQuota fetches and caches live rate limits for an agent.
func (m *Manager) RefreshQuota(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, error) {
	if m.cfg.QuotaProvider == nil {
		return domain.QuotaSnapshot{}, ErrQuotasUnsupported
	}
	q, err := m.cfg.QuotaProvider.RateLimits(ctx, agent)
	if err != nil {
		return domain.QuotaSnapshot{}, err
	}
	if m.cfg.Quotas != nil {
		_ = m.cfg.Quotas.SaveQuota(ctx, q)
	}
	return q, nil
}

// StopTask stops a background subagent task on the session's runtime.
func (m *Manager) StopTask(ctx context.Context, id domain.SessionID, taskID string) error {
	if _, err := m.session(ctx, id); err != nil {
		return err
	}
	m.mu.Lock()
	rt := m.runtimes[id]
	m.mu.Unlock()
	if rt == nil {
		return nil
	}
	return rt.StopTask(ctx, taskID)
}

// SetApprovalReviewer changes who reviews the session's approval requests.
// A running runtime that supports it switches at once; otherwise the value
// applies when the agent is next started.
func (m *Manager) SetApprovalReviewer(ctx context.Context, id domain.SessionID, r domain.ApprovalReviewer) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.SetApprovalReviewer(r)
	snap := s.Snapshot()
	rt := m.runtimes[id]
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	if setter, ok := rt.(ApprovalReviewerSetter); ok {
		if err := setter.SetApprovalReviewer(ctx, r); err != nil {
			return domain.SessionSnapshot{}, err
		}
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}

// SetModel chooses the session's model and reasoning effort. A runtime that
// can switch does so at once; otherwise the agent is restarted (resuming
// the conversation) now if idle, or before the next turn.
func (m *Manager) SetModel(ctx context.Context, id domain.SessionID, model, effort string) (domain.SessionSnapshot, error) {
	s, err := m.session(ctx, id)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	m.mu.Lock()
	err = s.SetModel(model, effort)
	snap := s.Snapshot()
	rt := m.runtimes[id]
	m.mu.Unlock()
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if err := m.cfg.Repo.Save(ctx, snap); err != nil {
		return domain.SessionSnapshot{}, err
	}
	if rt != nil {
		err := ErrRestartRequired
		if setter, ok := rt.(ModelSetter); ok {
			err = setter.SetModel(ctx, model, effort)
		}
		switch {
		case errors.Is(err, ErrRestartRequired):
			m.mu.Lock()
			if s.Status() == domain.StatusRunning {
				m.restart[id] = true
			} else {
				m.retire(s)
			}
			snap = s.Snapshot()
			m.mu.Unlock()
		case err != nil:
			return domain.SessionSnapshot{}, err
		}
	}
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	return snap, nil
}

// retire detaches and closes the session's runtime so the next turn starts
// a fresh one. Callers hold m.mu; the session must not be running.
func (m *Manager) retire(s *domain.Session) {
	delete(m.restart, s.ID())
	rt := m.runtimes[s.ID()]
	if rt == nil {
		return
	}
	delete(m.runtimes, s.ID())
	s.RuntimeExited(domain.ExitIdleTimeout)
	go func() { _ = rt.Close() }()
}

// Models lists the models an agent offers.
func (m *Manager) Models(ctx context.Context, agent domain.AgentKind) ([]ModelInfo, error) {
	if m.cfg.Models == nil {
		return nil, ErrModelsUnsupported
	}
	return m.cfg.Models.Models(ctx, agent)
}

// Interrupt stops the current turn if a runtime is attached.
func (m *Manager) Interrupt(ctx context.Context, id domain.SessionID) error {
	if _, err := m.session(ctx, id); err != nil {
		return err
	}
	m.mu.Lock()
	rt := m.runtimes[id]
	m.mu.Unlock()
	if rt == nil {
		return nil
	}
	return rt.Interrupt(ctx)
}

// Account reports the agent's login state.
func (m *Manager) Account(ctx context.Context, agent domain.AgentKind) (AccountInfo, error) {
	if m.cfg.Accounts == nil {
		return AccountInfo{}, ErrAccountsUnsupported
	}
	return m.cfg.Accounts.Account(ctx, agent)
}

// StartLogin begins the agent's device-code login.
func (m *Manager) StartLogin(ctx context.Context, agent domain.AgentKind) (LoginChallenge, error) {
	if m.cfg.Accounts == nil {
		return LoginChallenge{}, ErrAccountsUnsupported
	}
	return m.cfg.Accounts.StartLogin(ctx, agent)
}

// Close detaches and terminates every attached runtime.
func (m *Manager) Close() {
	m.mu.Lock()
	runtimes := m.runtimes
	m.runtimes = map[domain.SessionID]AgentRuntime{}
	for _, t := range m.idle {
		t.Stop()
	}
	for _, t := range m.resume {
		t.Stop()
	}
	m.mu.Unlock()
	for _, rt := range runtimes {
		_ = rt.Close()
	}
}

func (m *Manager) session(ctx context.Context, id domain.SessionID) (*domain.Session, error) {
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	if s != nil {
		return s, nil
	}
	snap, err := m.cfg.Repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	s, err = domain.RestoreSession(snap)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// A concurrent caller may have loaded it meanwhile; keep one instance.
	if existing := m.sessions[id]; existing != nil {
		return existing, nil
	}
	m.sessions[id] = s
	return s, nil
}

// ensureRuntime attaches a runtime to the session, resuming when the session
// already has a native id.
func (m *Manager) ensureRuntime(ctx context.Context, s *domain.Session) (AgentRuntime, error) {
	return m.ensureRuntimeFor(ctx, s, s.NativeID(), false, false)
}

func (m *Manager) ensureRuntimeFor(ctx context.Context, s *domain.Session, nativeID string, passive, fork bool) (AgentRuntime, error) {
	m.mu.Lock()
	if rt := m.runtimes[s.ID()]; rt != nil {
		m.mu.Unlock()
		return rt, nil
	}
	req := StartRequest{
		SessionID: s.ID(),
		Agent:     s.Agent(),
		Cwd:       s.Cwd(),
		NativeID:  nativeID,
		Fork:      fork,
		Passive:   passive,

		ApprovalReviewer: s.ApprovalReviewer(),
		PermissionMode:   s.PermissionMode(),
	}
	req.Model, req.Effort = s.Model()
	m.mu.Unlock()

	rt, err := m.cfg.Runtimes.Start(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", s.Agent(), err)
	}

	m.mu.Lock()
	if existing := m.runtimes[s.ID()]; existing != nil {
		m.mu.Unlock()
		_ = rt.Close()
		return existing, nil
	}
	m.runtimes[s.ID()] = rt
	err = s.RuntimeAttached(rt.NativeID())
	m.mu.Unlock()
	if err != nil {
		_ = rt.Close()
		return nil, err
	}
	go m.consume(s, rt)
	return rt, nil
}

// spawnSubagent creates and attaches a child session for an agent-spawned
// subagent thread.
func (m *Manager) spawnSubagent(parent *domain.Session, sp *domain.SubagentSpawn) {
	id := domain.SessionID(m.cfg.NewID())
	child, err := domain.NewChildSession(id, parent.Agent(), parent.Cwd(), parent.ID())
	if err != nil {
		return
	}
	if sp.Title != "" {
		child.Rename(sp.Title)
	}
	ctx := context.Background()
	if err := m.cfg.Repo.Save(ctx, child.Snapshot()); err != nil {
		return
	}
	m.mu.Lock()
	m.sessions[id] = child
	m.mu.Unlock()

	snap := child.Snapshot()
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
	if _, err := m.ensureRuntimeFor(ctx, child, sp.ThreadID, true, false); err != nil {
		return
	}
	m.mu.Lock()
	snap = child.Snapshot()
	m.mu.Unlock()
	_ = m.cfg.Repo.Save(ctx, snap)
	m.cfg.Bus.Publish(domain.Event{SessionID: id, Type: domain.EventSessionState, Session: &snap})
}

// consume pumps runtime events into the bus and applies state changes until
// the runtime exits.
func (m *Manager) consume(s *domain.Session, rt AgentRuntime) {
	// open tracks unfinished items, failed if the process dies under them.
	open := map[domain.ItemID]domain.Item{}
	for ev := range rt.Events() {
		if err := ev.Valid(); err != nil {
			continue
		}
		ev.SessionID = s.ID()
		if ev.Type == domain.EventQuota {
			ev.Quota = m.mergeQuota(*ev.Quota)
		}

		// Record request/session state before publishing, so a client that
		// reacts to the event immediately can answer without racing us.
		m.mu.Lock()
		if m.runtimes[s.ID()] != rt {
			// A retired runtime still flushing output; its session moved on.
			m.mu.Unlock()
			continue
		}
		quotaStop := false
		switch ev.Type {
		case domain.EventItemUpdated:
			if ev.Item.Status.Terminal() {
				delete(open, ev.Item.ID)
			} else {
				open[ev.Item.ID] = *ev.Item
			}
		case domain.EventQuota:
			quotaStop = ev.Quota.Reached && s.QuotaExhausted(ev.Quota.ResetsAt()) == nil
		case domain.EventTurnEnded:
			_ = s.TurnCompleted()
		case domain.EventRequestOpened:
			if m.pending[s.ID()] == nil {
				m.pending[s.ID()] = map[domain.RequestID]*domain.Request{}
			}
			m.pending[s.ID()][ev.Request.ID] = ev.Request
		case domain.EventRequestResolved:
			delete(m.pending[s.ID()], ev.Request.ID)
		}
		snap := s.Snapshot()
		m.mu.Unlock()

		ev = m.cfg.Bus.Publish(ev)
		if quotaStop {
			_ = m.cfg.Repo.Save(context.Background(), snap)
			m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventSessionState, Session: &snap})
		}
		switch ev.Type {
		case domain.EventTurnEnded:
			_ = m.cfg.Repo.Save(context.Background(), snap)
			m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventSessionState, Session: &snap})
			m.armIdle(s, rt)
		case domain.EventSubagentSpawned:
			m.spawnSubagent(s, ev.Subagent)
		case domain.EventQuota:
			if m.cfg.Quotas != nil {
				_ = m.cfg.Quotas.SaveQuota(context.Background(), *ev.Quota)
			}
		}
	}
	m.detach(s, rt, open)
}

// armIdle (re)starts the timer that retires an idle Claude process.
func (m *Manager) armIdle(s *domain.Session, rt AgentRuntime) {
	if m.cfg.IdleTimeout <= 0 || s.Agent() != domain.AgentClaude {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if t := m.idle[s.ID()]; t != nil {
		t.Stop()
	}
	entry := &idleTimer{}
	entry.Timer = time.AfterFunc(m.cfg.IdleTimeout, func() { m.retireIdle(s, rt, entry) })
	m.idle[s.ID()] = entry
}

// idleTimer gives a timer an identity its own callback can compare.
type idleTimer struct{ *time.Timer }

// retireIdle closes the runtime if it is still current, idle and has no
// pending requests; the session becomes detached.
func (m *Manager) retireIdle(s *domain.Session, rt AgentRuntime, timer *idleTimer) {
	m.mu.Lock()
	if m.idle[s.ID()] != timer || m.runtimes[s.ID()] != rt ||
		s.Status() != domain.StatusIdle || len(m.pending[s.ID()]) > 0 {
		m.mu.Unlock()
		return
	}
	delete(m.idle, s.ID())
	m.retire(s)
	snap := s.Snapshot()
	m.mu.Unlock()
	_ = m.cfg.Repo.Save(context.Background(), snap)
	m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventSessionState, Session: &snap})
}

// mergeQuota folds a partial quota report into the cached snapshot, so a
// report on one window doesn't erase the others.
// ponytail: read-merge-write without a lock; concurrent reports for one
// agent may drop a window until its next report.
func (m *Manager) mergeQuota(q domain.QuotaSnapshot) *domain.QuotaSnapshot {
	if m.cfg.Quotas != nil {
		if prev, ok, err := m.cfg.Quotas.GetQuota(context.Background(), q.Agent); err == nil && ok {
			q = prev.Merge(q)
		}
	}
	return &q
}

func (m *Manager) detach(s *domain.Session, rt AgentRuntime, open map[domain.ItemID]domain.Item) {
	m.mu.Lock()
	if m.runtimes[s.ID()] != rt {
		m.mu.Unlock()
		return
	}
	delete(m.runtimes, s.ID())
	stale := m.takeStale(s.ID())
	reason := domain.ExitCrashed
	if s.Status() != domain.StatusRunning {
		reason = domain.ExitIdleTimeout
	}
	s.RuntimeExited(reason)
	snap := s.Snapshot()
	m.mu.Unlock()

	for _, req := range stale {
		req.MarkStale()
		m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventRequestResolved, Request: req})
	}
	for _, item := range open {
		if item.SetStatus(domain.ItemFailed) == nil {
			m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventItemUpdated, Item: &item})
		}
	}
	_ = m.cfg.Repo.Save(context.Background(), snap)
	m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventSessionState, Session: &snap})
}

// takeStale removes and returns pending requests belonging to a session.
func (m *Manager) takeStale(id domain.SessionID) []*domain.Request {
	requests := m.pending[id]
	delete(m.pending, id)
	out := make([]*domain.Request, 0, len(requests))
	for _, req := range requests {
		out = append(out, req)
	}
	return out
}

// RespondRequest answers a pending blocking request.
func (m *Manager) RespondRequest(ctx context.Context, sessionID domain.SessionID, requestID domain.RequestID, answer RequestAnswer) error {
	if _, err := m.session(ctx, sessionID); err != nil {
		return err
	}
	m.mu.Lock()
	req := m.pending[sessionID][requestID]
	rt := m.runtimes[sessionID]
	if req != nil && rt != nil {
		// Claim it, so a second answer (double click, another tab) is refused.
		delete(m.pending[sessionID], requestID)
	}
	m.mu.Unlock()
	if req == nil || rt == nil {
		return fmt.Errorf("%w: %s", ErrRequestNotFound, requestID)
	}
	if err := rt.Respond(ctx, requestID, answer); err != nil {
		m.mu.Lock()
		current := m.runtimes[sessionID] == rt
		if current {
			if m.pending[sessionID] == nil {
				m.pending[sessionID] = map[domain.RequestID]*domain.Request{}
			}
			m.pending[sessionID][requestID] = req
		} else {
			// The runtime died while we held the request, so detach never
			// saw it; nobody can answer it now.
			req.MarkStale()
		}
		m.mu.Unlock()
		if !current {
			m.cfg.Bus.Publish(domain.Event{SessionID: sessionID, Type: domain.EventRequestResolved, Request: req})
		}
		return err
	}
	data, _ := json.Marshal(answer)
	m.mu.Lock()
	_ = req.Resolve(data)
	m.mu.Unlock()
	m.recordDecision(req, answer)
	m.cfg.Bus.Publish(domain.Event{SessionID: sessionID, Type: domain.EventRequestResolved, Request: req})
	return nil
}

// recordDecision leaves the user's answer in the transcript as a one-line
// record, so it outlives the request card.
func (m *Manager) recordDecision(req *domain.Request, answer RequestAnswer) {
	item, err := domain.NewItem(domain.ItemID(m.cfg.NewID()), req.SessionID, req.TurnID, "", domain.ItemDecision)
	if err != nil {
		return
	}
	item.Name = req.Title
	item.Decision = domain.DecisionFor(req.Kind, answer.Allow)
	item.Text = decisionText(answer)
	_ = item.SetStatus(domain.ItemCompleted)
	m.cfg.Bus.Publish(domain.Event{SessionID: req.SessionID, Type: domain.EventItemUpdated, Item: item})
}

// decisionText is the detail shown after a decision: the deny reason, the
// session-wide grant, or each question with its chosen answers.
func decisionText(a RequestAnswer) string {
	switch {
	case !a.Allow:
		return a.Message
	case len(a.Answers) > 0:
		questions := make([]string, 0, len(a.Answers))
		for q := range a.Answers {
			questions = append(questions, q)
		}
		sort.Strings(questions)
		lines := make([]string, len(questions))
		for i, q := range questions {
			lines[i] = q + " " + strings.Join(a.Answers[q], ", ")
		}
		return strings.Join(lines, "\n")
	case a.AllowForSession:
		return "for this session"
	}
	return ""
}

// PendingRequests returns every unanswered blocking request.
func (m *Manager) PendingRequests(context.Context) []domain.Request {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []domain.Request
	for _, requests := range m.pending {
		for _, req := range requests {
			out = append(out, *req)
		}
	}
	return out
}

const titleLimit = 60

// titleFromText names a session after its first message: whitespace
// collapsed, cut to titleLimit characters with an ellipsis.
func titleFromText(text string) string {
	title := strings.Join(strings.Fields(text), " ")
	if r := []rune(title); len(r) > titleLimit {
		title = strings.TrimRight(string(r[:titleLimit-1]), " ") + "…"
	}
	return title
}
