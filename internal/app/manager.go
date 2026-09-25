package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"

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
}

func NewManager(cfg ManagerConfig) *Manager {
	if cfg.NewID == nil {
		cfg.NewID = randomID
	}
	return &Manager{
		cfg:      cfg,
		sessions: map[domain.SessionID]*domain.Session{},
		runtimes: map[domain.SessionID]AgentRuntime{},
		pending:  map[domain.SessionID]map[domain.RequestID]*domain.Request{},
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
		if cur != snap {
			if err := m.cfg.Repo.Save(ctx, cur); err != nil {
				return out, err
			}
		}
		out = append(out, cur)
	}
	return out, nil
}

// SendMessage starts a new turn: it lazily attaches (or resumes) the agent
// runtime, records the user message and forwards it to the agent.
func (m *Manager) SendMessage(ctx context.Context, id domain.SessionID, text string) error {
	s, err := m.session(ctx, id)
	if err != nil {
		return err
	}
	turn := domain.TurnID(m.cfg.NewID())
	rt, err := m.ensureRuntime(ctx, s)
	if err != nil {
		return err
	}

	m.mu.Lock()
	err = s.TurnStarted()
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
	return rt.Send(ctx, turn, text)
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
	m.sessions[id] = s
	m.mu.Unlock()
	return s, nil
}

// ensureRuntime attaches a runtime to the session, resuming when the session
// already has a native id.
func (m *Manager) ensureRuntime(ctx context.Context, s *domain.Session) (AgentRuntime, error) {
	return m.ensureRuntimeFor(ctx, s, s.NativeID(), false)
}

func (m *Manager) ensureRuntimeFor(ctx context.Context, s *domain.Session, nativeID string, passive bool) (AgentRuntime, error) {
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
		Passive:   passive,
	}
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
	if _, err := m.ensureRuntimeFor(ctx, child, sp.ThreadID, true); err != nil {
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
	for ev := range rt.Events() {
		if err := ev.Valid(); err != nil {
			continue
		}
		ev.SessionID = s.ID()

		// Record request/session state before publishing, so a client that
		// reacts to the event immediately can answer without racing us.
		m.mu.Lock()
		switch ev.Type {
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
		switch ev.Type {
		case domain.EventTurnEnded:
			_ = m.cfg.Repo.Save(context.Background(), snap)
			m.cfg.Bus.Publish(domain.Event{SessionID: s.ID(), Type: domain.EventSessionState, Session: &snap})
		case domain.EventSubagentSpawned:
			m.spawnSubagent(s, ev.Subagent)
		case domain.EventQuota:
			if m.cfg.Quotas != nil {
				_ = m.cfg.Quotas.SaveQuota(context.Background(), *ev.Quota)
			}
		}
	}
	m.detach(s, rt)
}

func (m *Manager) detach(s *domain.Session, rt AgentRuntime) {
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
	m.mu.Unlock()
	if req == nil || rt == nil {
		return fmt.Errorf("%w: %s", ErrRequestNotFound, requestID)
	}
	if err := rt.Respond(ctx, requestID, answer); err != nil {
		return err
	}
	data, _ := json.Marshal(answer)
	m.mu.Lock()
	_ = req.Resolve(data)
	delete(m.pending[sessionID], requestID)
	m.mu.Unlock()
	m.cfg.Bus.Publish(domain.Event{SessionID: sessionID, Type: domain.EventRequestResolved, Request: req})
	return nil
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
