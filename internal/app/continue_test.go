package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func sentTexts(rt *fakeRuntime) []string {
	var out []string
	for _, m := range rt.sentMessages() {
		out = append(out, m.text)
	}
	return out
}

func sent(rt *fakeRuntime, text string) bool {
	for _, s := range sentTexts(rt) {
		if s == text {
			return true
		}
	}
	return false
}

func TestContinueResumesAnInterruptedTurn(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	first, second := newFakeRuntime("native-1"), newFakeRuntime("native-1")
	factory.runtimes = []*fakeRuntime{first, second}
	ctx := context.Background()
	if err := m.SendMessage(ctx, snap.ID, "long job"); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()
	eventually(t, "interrupted", func() bool {
		s, _ := repo.Get(ctx, snap.ID)
		return s.Status == domain.StatusInterrupted
	})
	if err := m.Continue(ctx, snap.ID); err != nil {
		t.Fatal(err)
	}
	reqs := factory.requests()
	if len(reqs) != 2 || reqs[1].NativeID != "native-1" || reqs[1].Fork {
		t.Fatalf("start requests = %+v", reqs)
	}
	if !sent(second, ContinuePrompt) {
		t.Fatalf("sent = %v", sentTexts(second))
	}
}

func TestContinueRejectsSessionsWithNothingToContinue(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	if err := m.Continue(ctx, snap.ID); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("fresh session: err = %v", err)
	}
	startWith(t, m, factory, snap.ID, newFakeRuntime("native-1"))
	if err := m.Continue(ctx, snap.ID); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("running session: err = %v", err)
	}
	if err := m.Continue(ctx, "missing"); err == nil {
		t.Fatal("unknown session must fail")
	}
}

func quotaStop(t *testing.T, m *Manager, rt *fakeRuntime, id domain.SessionID, resets time.Time) {
	t.Helper()
	rt.events <- quotaEvent(id, domain.QuotaSnapshot{Agent: domain.AgentClaude, Reached: true,
		Windows: []domain.QuotaWindow{{Name: "five_hour", Status: "rejected", UsedPct: 100, ResetsAt: resets}}})
	eventually(t, "quota interruption", func() bool { return currentStatus(m, id) == domain.StatusInterrupted })
}

func TestAutoContinueAfterTheQuotaResets(t *testing.T) {
	m, _, _, factory, snap := newQuotaManager(t)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	quotaStop(t, m, rt, snap.ID, time.Now().Add(30*time.Millisecond))
	got, err := m.SetAutoContinue(context.Background(), snap.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !got.AutoContinue {
		t.Fatalf("snapshot = %+v", got)
	}
	eventually(t, "continued after the reset", func() bool { return sent(rt, ContinuePrompt) })
	if s, _ := m.GetSession(context.Background(), snap.ID); s.AutoContinue || s.Status != domain.StatusRunning {
		t.Fatalf("after continuing: %+v", s)
	}
}

func TestAutoContinueCanBeCanceled(t *testing.T) {
	m, _, _, factory, snap := newQuotaManager(t)
	rt := newFakeRuntime("n1")
	startWith(t, m, factory, snap.ID, rt)
	quotaStop(t, m, rt, snap.ID, time.Now().Add(40*time.Millisecond))
	ctx := context.Background()
	if _, err := m.SetAutoContinue(ctx, snap.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetAutoContinue(ctx, snap.ID, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	if sent(rt, ContinuePrompt) {
		t.Fatal("canceled auto-continue still fired")
	}
	if _, err := m.SetAutoContinue(ctx, "missing", false); err == nil {
		t.Fatal("unknown session must fail")
	}
}

func TestAutoContinueNeedsAQuotaInterruption(t *testing.T) {
	m, _, _, _, snap := newQuotaManager(t)
	if _, err := m.SetAutoContinue(context.Background(), snap.ID, true); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("err = %v", err)
	}
}

func TestRestoreArmsAutoContinue(t *testing.T) {
	repo, bus, factory := newMemRepo(), newFakeBus(), &fakeFactory{}
	rt := newFakeRuntime("n1")
	factory.runtimes = []*fakeRuntime{rt}
	ctx := context.Background()
	_ = repo.Save(ctx, domain.SessionSnapshot{ID: "q", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n1",
		Status: domain.StatusInterrupted, AutoContinue: true,
		Interruption: domain.Interruption{Reason: domain.ExitQuota, ResumeAfter: time.Now().Add(-time.Minute)}})
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: bus})
	t.Cleanup(m.Close)
	if _, err := m.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	eventually(t, "continued after restart", func() bool { return sent(rt, ContinuePrompt) })
}

func TestForkStartsANewSessionFromTheParent(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	parent := createClaude(t, m)
	ctx := context.Background()
	if _, err := m.Fork(ctx, parent.ID); !errors.Is(err, domain.ErrInvalidTransition) {
		t.Fatalf("fork before the first turn: err = %v", err)
	}
	startWith(t, m, factory, parent.ID, newFakeRuntime("native-1"))
	forked := newFakeRuntime("native-2")
	factory.next = forked
	fork, err := m.Fork(ctx, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fork.ID == parent.ID || fork.ForkOf != parent.ID || fork.NativeID != "native-2" || fork.Status != domain.StatusIdle {
		t.Fatalf("fork = %+v", fork)
	}
	reqs := factory.requests()
	last := reqs[len(reqs)-1]
	if !last.Fork || last.NativeID != "native-1" || last.SessionID != fork.ID {
		t.Fatalf("start request = %+v", last)
	}
	if saved, _ := repo.Get(ctx, fork.ID); saved.NativeID != "native-2" || saved.ForkOf != parent.ID {
		t.Fatalf("saved = %+v", saved)
	}
	published := false
	for _, ev := range bus.snapshot() {
		if ev.SessionID == fork.ID && ev.Type == domain.EventSessionState {
			published = true
		}
	}
	if !published {
		t.Fatal("fork not announced")
	}
	if err := m.SendMessage(ctx, fork.ID, "go on"); err != nil {
		t.Fatal(err)
	}
	if !sent(forked, "go on") {
		t.Fatal("fork does not take messages")
	}
	if _, err := m.Fork(ctx, "missing"); err == nil {
		t.Fatal("unknown session must fail")
	}
}

func TestForkStartFailureKeepsNoSession(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	parent := createClaude(t, m)
	startWith(t, m, factory, parent.ID, newFakeRuntime("native-1"))
	factory.err = errors.New("boom")
	if _, err := m.Fork(context.Background(), parent.ID); err == nil {
		t.Fatal("start failure must be reported")
	}
	if all, _ := repo.List(context.Background()); len(all) != 1 {
		t.Fatalf("sessions = %+v", all)
	}
}

type fakeTranscriptFiles struct {
	text string
	err  error
}

func (f *fakeTranscriptFiles) WriteTranscript(_ context.Context, _ domain.SessionID, text string) (string, error) {
	f.text = text
	return "/data/transcript.md", f.err
}
func TestForkToAnotherAgentUsesATranscriptAndFreshRuntime(t *testing.T) {
	for _, agent := range []domain.AgentKind{domain.AgentCodex, domain.AgentOpenCode, domain.AgentClaude} {
		t.Run(string(agent), func(t *testing.T) {
			m, _, bus, factory, _ := newTestManager(t)
			t.Cleanup(m.Close)
			source := domain.AgentClaude
			if agent == source {
				source = domain.AgentCodex
			}
			parent, err := m.CreateSession(context.Background(), source, "/project")
			if err != nil {
				t.Fatal(err)
			}
			rt := newFakeRuntime("source-native")
			startWith(t, m, factory, parent.ID, rt)
			endTurn(t, m, rt, parent.ID)
			files := &fakeTranscriptFiles{}
			m.cfg.Transcripts = files
			m.cfg.History = forkHistory{bus}
			child := newFakeRuntime("target-native")
			factory.next = child
			fork, err := m.ForkTo(context.Background(), parent.ID, agent)
			if err != nil {
				t.Fatal(err)
			}
			if fork.Agent != agent || fork.ForkOf != parent.ID || fork.Cwd != parent.Cwd || fork.NativeID != "target-native" {
				t.Fatalf("fork = %+v", fork)
			}
			reqs := factory.requests()
			req := reqs[len(reqs)-1]
			if req.Fork || req.NativeID != "" || req.Agent != agent || req.Model != "" || req.PermissionMode != "" {
				t.Fatalf("request = %+v", req)
			}
			if !strings.Contains(files.text, "hi") || !strings.Contains(files.text, string(parent.ID)) {
				t.Fatalf("transcript = %s", files.text)
			}
			texts := sentTexts(child)
			if len(texts) != 1 || !strings.Contains(texts[0], "/data/transcript.md") || strings.Contains(texts[0], "user_message") {
				t.Fatalf("prompt = %v", texts)
			}
		})
	}
}
func TestForkToTranscriptFailureDoesNotStartOrSaveAChild(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	t.Cleanup(m.Close)
	parent := createClaude(t, m)
	rt := newFakeRuntime("n")
	startWith(t, m, factory, parent.ID, rt)
	m.cfg.Transcripts = &fakeTranscriptFiles{err: errors.New("disk full")}
	m.cfg.History = forkHistory{newFakeBus()}
	if _, err := m.ForkTo(context.Background(), parent.ID, domain.AgentCodex); err == nil {
		t.Fatal("expected failure")
	}
	all, _ := repo.List(context.Background())
	if len(all) != 1 || len(factory.requests()) != 1 {
		t.Fatalf("sessions=%v starts=%v", all, factory.requests())
	}
}

type forkHistory struct{ bus *fakeBus }

func (h forkHistory) History(id domain.SessionID, _ domain.Seq) []domain.Event {
	var out []domain.Event
	for _, ev := range h.bus.snapshot() {
		if ev.SessionID == id {
			out = append(out, ev)
		}
	}
	return out
}
func (h forkHistory) Requests(domain.SessionID) []domain.Event { return nil }
func TestForkTranscriptFoldsStreamingAndKeepsToolDetails(t *testing.T) {
	events := []domain.Event{
		{Type: domain.EventItemUpdated, Item: &domain.Item{ID: "a", Kind: domain.ItemAssistantMessage, Text: "first"}},
		{Type: domain.EventTextDelta, Delta: &domain.Delta{ItemID: "a", Text: " fragment"}},
		{Type: domain.EventItemUpdated, Item: &domain.Item{ID: "b", Kind: domain.ItemCommand, Text: "output", Input: []byte(`{"cmd":"pwd"}`)}},
	}
	text := forkTranscript(domain.SessionSnapshot{ID: "p", Agent: domain.AgentClaude, Cwd: "/p"}, events)
	for _, want := range []string{"first fragment", "pwd", "output", "claude", "/p"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %s", want, text)
		}
	}
}

func TestForkToBootstrapFailureKeepsARetryableChild(t *testing.T) {
	for _, failure := range []error{errors.New("transport unavailable"), context.Canceled} {
		t.Run(failure.Error(), func(t *testing.T) {
			m, repo, bus, factory, _ := newTestManager(t)
			t.Cleanup(m.Close)
			parent := createClaude(t, m)
			rt := newFakeRuntime("source")
			startWith(t, m, factory, parent.ID, rt)
			endTurn(t, m, rt, parent.ID)
			m.cfg.Transcripts = &fakeTranscriptFiles{}
			m.cfg.History = forkHistory{bus}
			child := newFakeRuntime("child")
			child.sendErr = failure
			factory.next = child
			fork, err := m.ForkTo(context.Background(), parent.ID, domain.AgentCodex)
			if err != nil {
				t.Fatalf("creation succeeded; bootstrap must be shown in child: %v", err)
			}
			if fork.ID == "" || fork.ForkOf != parent.ID || fork.Status != domain.StatusIdle {
				t.Fatalf("fork=%+v", fork)
			}
			all, _ := repo.List(context.Background())
			if len(all) != 2 {
				t.Fatalf("sessions=%+v", all)
			}
			saved, _ := repo.Get(context.Background(), fork.ID)
			if saved.Status != fork.Status || saved.EndedAt.IsZero() {
				t.Fatalf("saved=%+v", saved)
			}
			var prompt string
			var failed bool
			for _, ev := range bus.snapshot() {
				if ev.SessionID != fork.ID {
					continue
				}
				if ev.Item != nil && ev.Item.Kind == domain.ItemUserMessage {
					prompt = ev.Item.Text
				}
				if ev.Type == domain.EventTurnEnded && ev.Result != nil && ev.Result.IsError && strings.Contains(ev.Result.Error, failure.Error()) {
					failed = true
				}
			}
			if !failed || !strings.Contains(prompt, "/data/transcript.md") {
				t.Fatalf("failed=%v prompt=%q", failed, prompt)
			}
			child.mu.Lock()
			child.sendErr = nil
			child.mu.Unlock()
			if err := m.SendMessage(context.Background(), fork.ID, prompt); err != nil {
				t.Fatal(err)
			}
			if !sent(child, prompt) || len(factory.requests()) != 2 {
				t.Fatal("retry created a new child or lost bootstrap")
			}
		})
	}
}
