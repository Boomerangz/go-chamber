package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// goalModel answers agent steps and audits from separate scripts, as the
// runtime sends both through one client.
type goalModel struct {
	mu      sync.Mutex
	agent   []domain.ModelRequest
	audits  []domain.ModelRequest
	reply   func(n int, req domain.ModelRequest) (domain.ModelResult, error)
	verdict func(n int) (string, error)
}

func (m *goalModel) Stream(ctx context.Context, req domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
	m.mu.Lock()
	audit := req.Instructions == goalAuditInstructions
	if audit {
		m.audits = append(m.audits, req)
	} else {
		m.agent = append(m.agent, req)
	}
	n := len(m.agent)
	if audit {
		n = len(m.audits)
	}
	m.mu.Unlock()
	if audit {
		text, err := m.verdict(n)
		return domain.ModelResult{Message: domain.ModelMessage{Text: text}, Usage: domain.ModelUsage{Input: 5, Output: 5}}, err
	}
	if m.reply != nil {
		return m.reply(n, req)
	}
	return domain.ModelResult{Message: domain.ModelMessage{Text: "step done"}, Usage: domain.ModelUsage{Input: 70, Output: 30}}, nil
}

func goalRun(t *testing.T, model *goalModel, texts ...string) (*NativeRuntime, *nativeMemory, []domain.Event) {
	t.Helper()
	repo := &nativeMemory{}
	r := nativeTestRuntime(t, model, &nativeTestTools{}, repo)
	var events []domain.Event
	for i, text := range texts {
		if err := r.Send(context.Background(), domain.TurnID("turn"+string(rune('a'+i))), text); err != nil {
			t.Fatal(err)
		}
		events = append(events, nativeEnd(t, r)...)
	}
	return r, repo, events
}

func savedGoal(t *testing.T, repo *nativeMemory) *domain.Goal {
	t.Helper()
	saved, _ := repo.LoadConversation(context.Background(), "native")
	return saved.Goal
}

func notices(events []domain.Event) string {
	var b strings.Builder
	for _, ev := range events {
		if ev.Type == domain.EventItemUpdated && ev.Item.Kind == domain.ItemAssistantMessage && ev.Item.Status == domain.ItemCompleted {
			b.WriteString(ev.Item.Text + "\n")
		}
	}
	return b.String()
}

func TestGoalContinuesInOneTurnUntilTheAuditConfirms(t *testing.T) {
	model := &goalModel{verdict: func(n int) (string, error) {
		if n == 1 {
			return "```json\n{\"verdict\":\"continue\",\"note\":\"tests still red\"}\n```", nil
		}
		return `{"verdict":"complete","note":"tests green"}`, nil
	}}
	_, repo, events := goalRun(t, model, "/goal make <tests> green")
	if len(model.agent) != 2 || len(model.audits) != 2 {
		t.Fatalf("agent steps %d, audits %d", len(model.agent), len(model.audits))
	}
	first := model.agent[0].Messages[0].Text
	if strings.Contains(first, "/goal") || !strings.Contains(first, "make &lt;tests&gt; green") {
		t.Fatalf("kickoff prompt: %s", first)
	}
	last := model.agent[1].Messages
	if next := last[len(last)-1]; next.Role != "user" || !strings.Contains(next.Text, "Continuations used: 1 of 20") {
		t.Fatalf("continuation prompt: %+v", next)
	}
	if audit := model.audits[0]; len(audit.Tools) != 0 || len(audit.Messages) != 1 || !strings.Contains(audit.Messages[0].Text, "step done") || !strings.Contains(audit.Messages[0].Text, "make <tests> green") {
		t.Fatalf("audit request: %+v", audit)
	}
	ended := 0
	for _, ev := range events {
		if ev.Type == domain.EventTurnEnded {
			ended++
			if ev.Result.IsError || ev.Result.InputTokens != 140 {
				t.Fatalf("result %+v", ev.Result)
			}
		}
	}
	g := savedGoal(t, repo)
	if ended != 1 || g.Status != domain.GoalComplete || g.TurnsUsed != 1 || g.TokensUsed != 220 || g.Note != "tests green" {
		t.Fatalf("ended %d goal %+v", ended, g)
	}
	if shown := notices(events); !strings.Contains(shown, "Goal set") || !strings.Contains(shown, "tests still red") || !strings.Contains(shown, "Goal complete") {
		t.Fatalf("notices: %s", shown)
	}
}

func TestGoalPausesWhenTheTurnIsStoppedOrFails(t *testing.T) {
	started := make(chan struct{})
	model := &goalModel{reply: func(_ int, _ domain.ModelRequest) (domain.ModelResult, error) {
		return domain.ModelResult{}, errors.New("provider down")
	}}
	_, repo, events := goalRun(t, model, "/goal ship")
	if g := savedGoal(t, repo); g.Status != domain.GoalPaused || !strings.Contains(g.Note, "provider down") || len(model.audits) != 0 {
		t.Fatalf("failed turn left %+v, audits %d", g, len(model.audits))
	}
	if !strings.Contains(notices(events), "Goal paused") {
		t.Fatal("pause not shown")
	}

	repo = &nativeMemory{}
	r := nativeTestRuntime(t, nativeModelFunc(func(ctx context.Context, req domain.ModelRequest, e func(domain.ModelDelta) error) (domain.ModelResult, error) {
		close(started)
		<-ctx.Done()
		return domain.ModelResult{}, ctx.Err()
	}), &nativeTestTools{}, repo)
	if err := r.Send(context.Background(), "turn", "/goal ship"); err != nil {
		t.Fatal(err)
	}
	<-started
	_ = r.Interrupt(context.Background())
	nativeEnd(t, r)
	if g := savedGoal(t, repo); g.Status != domain.GoalPaused || g.Note != "stopped by the user" {
		t.Fatalf("stopped turn left %+v", g)
	}
}

func TestGoalStopsAtItsBudgetAndTurnCapWithoutAnAuditVerdict(t *testing.T) {
	model := &goalModel{verdict: func(int) (string, error) { return `{"verdict":"continue","note":""}`, nil }}
	_, repo, _ := goalRun(t, model, "/goal ship")
	if g := savedGoal(t, repo); g.Status != domain.GoalPaused || g.TurnsUsed != domain.GoalMaxAutoTurns || len(model.agent) != domain.GoalMaxAutoTurns+1 {
		t.Fatalf("turn cap: %+v after %d steps", g, len(model.agent))
	}

	model = &goalModel{verdict: func(int) (string, error) { return `{"verdict":"continue","note":""}`, nil }}
	model.reply = func(n int, _ domain.ModelRequest) (domain.ModelResult, error) {
		if n == 1 {
			return domain.ModelResult{}, errors.New("provider down")
		}
		return domain.ModelResult{Message: domain.ModelMessage{Text: "step done"}, Usage: domain.ModelUsage{Input: 70, Output: 30}}, nil
	}
	_, repo, events := goalRun(t, model, "/goal ship", "/goal budget 150", "/goal resume")
	g := savedGoal(t, repo)
	if g.Status != domain.GoalBudgetLimited || g.TokensUsed != 210 || len(model.audits) != 1 {
		t.Fatalf("budget: %+v after %d audits", g, len(model.audits))
	}
	if !strings.Contains(notices(events), "Goal budgetLimited") {
		t.Fatal("budget stop not shown")
	}
}

func TestGoalAuditSeesTheEndOfALongReplyAsValidText(t *testing.T) {
	model := &goalModel{verdict: func(int) (string, error) { return `{"verdict":"complete","note":"ok"}`, nil }}
	model.reply = func(int, domain.ModelRequest) (domain.ModelResult, error) {
		return domain.ModelResult{Message: domain.ModelMessage{Text: "начало" + strings.Repeat("ж", goalReplyLimit) + " итог: готово"}}, nil
	}
	goalRun(t, model, "/goal ship")
	seen := model.audits[0].Messages[0].Text
	if !utf8.ValidString(seen) || strings.Contains(seen, "начало") || !strings.Contains(seen, "итог: готово") {
		t.Fatalf("audit input cut badly: valid=%v", utf8.ValidString(seen))
	}
}

func TestGoalDoesNotRunBlindWhenTheAuditorKeepsFailing(t *testing.T) {
	model := &goalModel{verdict: func(int) (string, error) { return "I think it is fine", nil }}
	_, repo, _ := goalRun(t, model, "/goal ship")
	if g := savedGoal(t, repo); g.Status != domain.GoalPaused || len(model.agent) != domain.GoalAuditFailLimit || !strings.Contains(g.Note, "audit") {
		t.Fatalf("%+v after %d steps", g, len(model.agent))
	}
	model = &goalModel{verdict: func(int) (string, error) { return `{"verdict":"maybe"}`, nil }}
	_, repo, _ = goalRun(t, model, "/goal ship")
	if g := savedGoal(t, repo); g.Status != domain.GoalPaused {
		t.Fatalf("unknown verdict accepted: %+v", g)
	}
}

func TestGoalCommandsManageTheGoalWithoutCallingTheModel(t *testing.T) {
	model := &goalModel{verdict: func(int) (string, error) { return `{"verdict":"complete","note":"ok"}`, nil }}
	r, repo, events := goalRun(t, model, "/goal", "/goal pause", "/goal resume", "/goal budget 10")
	if len(model.agent) != 0 || savedGoal(t, repo) != nil {
		t.Fatalf("commands without a goal reached the model %d times", len(model.agent))
	}
	if shown := notices(events); strings.Count(shown, "No goal is set") != 4 || !strings.Contains(shown, goalUsage) {
		t.Fatalf("notices: %s", shown)
	}
	send := func(text string) string {
		t.Helper()
		if err := r.Send(context.Background(), "turn", text); err != nil {
			t.Fatal(err)
		}
		return notices(nativeEnd(t, r))
	}
	send("/goal budget cuts analysis")
	if g := savedGoal(t, repo); g == nil || g.Objective != "budget cuts analysis" || g.Status != domain.GoalComplete {
		t.Fatalf("objective starting with a command word: %+v", g)
	}
	steps := len(model.agent)
	if shown := send("/goal"); !strings.Contains(shown, "budget cuts analysis") {
		t.Fatalf("summary: %s", shown)
	}
	send("/goal budget 9000")
	send("/goal pause")
	if g := savedGoal(t, repo); g.TokenBudget != 9000 || g.Status != domain.GoalComplete || len(model.agent) != steps {
		t.Fatalf("%+v after %d steps", g, len(model.agent))
	}
	send("/goal resume")
	if g := savedGoal(t, repo); g.Status != domain.GoalComplete || len(model.agent) != steps+1 {
		t.Fatalf("resume did not run: %+v", g)
	}
	send("/goal clear")
	send("/goalkeeper stats")
	saved, _ := repo.LoadConversation(context.Background(), "native")
	if saved.Goal != nil || saved.Messages[len(saved.Messages)-2].Text != "/goalkeeper stats" {
		t.Fatalf("goal %+v messages %+v", saved.Goal, saved.Messages)
	}
	send("/goal " + strings.Repeat("x", domain.GoalObjectiveLimit+1))
	if savedGoal(t, repo) != nil {
		t.Fatal("oversized objective accepted")
	}
}

func TestGoalCommandSentDuringTheRunIsAppliedNotShownToTheModel(t *testing.T) {
	repo := &nativeMemory{}
	tools := &nativeTestTools{}
	model := &goalModel{verdict: func(int) (string, error) { return `{"verdict":"continue","note":""}`, nil }}
	model.reply = func(n int, _ domain.ModelRequest) (domain.ModelResult, error) {
		if n == 1 {
			return domain.ModelResult{Message: domain.ModelMessage{ToolCalls: []domain.ModelToolCall{{ID: "c", Name: "write", Arguments: json.RawMessage(`{}`)}}}}, nil
		}
		return domain.ModelResult{Message: domain.ModelMessage{Text: "step done"}}, nil
	}
	r := nativeTestRuntime(t, model, tools, repo)
	tools.exec = func(context.Context, domain.ModelToolCall) (string, error) {
		return "written", r.Steer(context.Background(), "/goal pause")
	}
	if err := r.Send(context.Background(), "turn", "/goal ship"); err != nil {
		t.Fatal(err)
	}
	events := nativeEnd(t, r)
	saved, _ := repo.LoadConversation(context.Background(), "native")
	if saved.Goal.Status != domain.GoalPaused || saved.Goal.Note != "paused by the user" || len(model.audits) != 0 || len(model.agent) != 2 {
		t.Fatalf("goal %+v audits %d steps %d", saved.Goal, len(model.audits), len(model.agent))
	}
	for _, m := range saved.Messages {
		if strings.Contains(m.Text, "/goal pause") {
			t.Fatalf("command reached the model: %+v", m)
		}
	}
	if !strings.Contains(notices(events), "Goal paused") {
		t.Fatal("pause not shown")
	}
}

func TestSubagentTreatsGoalTextAsItsTask(t *testing.T) {
	repo := &nativeMemory{}
	model := &goalModel{verdict: func(int) (string, error) { return "", errors.New("audited a subagent") }}
	r := NewNativeRuntime(NativeRuntimeConfig{SessionID: "s", Conversation: domain.Conversation{ID: "native", Model: "test", Parent: "root", Depth: 1}, Model: model, Tools: &nativeTestTools{}, Repo: repo})
	t.Cleanup(func() { _ = r.Close() })
	if err := r.Send(context.Background(), "turn", "/goal ship"); err != nil {
		t.Fatal(err)
	}
	nativeEnd(t, r)
	saved, _ := repo.LoadConversation(context.Background(), "native")
	if saved.Goal != nil || saved.Messages[0].Text != "/goal ship" || len(model.audits) != 0 {
		t.Fatalf("%+v", saved)
	}
}

func TestImageOnlyMessageStillReachesTheModel(t *testing.T) {
	model := &goalModel{}
	repo := &nativeMemory{}
	r := NewNativeRuntime(NativeRuntimeConfig{SessionID: "s", Conversation: domain.Conversation{ID: "native", Model: "test"}, Model: model, Tools: &nativeTestTools{}, Repo: repo, LoadImages: func(context.Context, []Image) ([]domain.ModelImage, error) {
		return []domain.ModelImage{{URL: "data:image/png;base64,AA=="}}, nil
	}})
	t.Cleanup(func() { _ = r.Close() })
	if err := r.SendImages(context.Background(), "turn", "", []Image{{}}); err != nil {
		t.Fatal(err)
	}
	nativeEnd(t, r)
	if len(model.agent) != 1 || len(model.agent[0].Messages) != 1 || len(model.agent[0].Messages[0].Images) != 1 {
		t.Fatalf("image-only input dropped: %+v", model.agent)
	}
}
