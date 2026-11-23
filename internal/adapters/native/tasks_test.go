package native

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestNativeTasksSpawnAttachWaitAndOwnership(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	parent, err := f.Start(ctx, app.StartRequest{SessionID: "parent", Agent: domain.AgentNative, Cwd: t.TempDir(), PermissionMode: "read-only"})
	if err != nil {
		t.Fatal(err)
	}
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: parent.NativeID(), Model: "codex:fresh", PermissionMode: "read-only"}, cwd: t.TempDir(), emit: parent.(*app.NativeRuntime).Emit}
	raw, err := tasks.Execute(ctx, domain.ModelToolCall{Name: "spawn_agent", Arguments: json.RawMessage(`{"task":"inspect code","title":"Review","background":true}`)})
	if err != nil {
		t.Fatal(err)
	}
	var spawned struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal([]byte(raw), &spawned); err != nil || spawned.ID == "" {
		t.Fatalf("%s %v", raw, err)
	}
	select {
	case ev := <-parent.Events():
		if ev.Type != domain.EventSubagentSpawned || ev.Subagent.ThreadID != spawned.ID {
			t.Fatalf("%+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("missing spawn event")
	}
	saved, _ := f.Repo.LoadConversation(ctx, spawned.ID)
	if saved.Parent != parent.NativeID() || saved.PendingPrompt != "inspect code" || saved.PermissionMode != "read-only" {
		t.Fatalf("%+v", saved)
	}
	child, err := f.Start(ctx, app.StartRequest{SessionID: "child", Agent: domain.AgentNative, NativeID: spawned.ID, Passive: true, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	endTurn(t, child)
	args, _ := json.Marshal(map[string]string{"id": spawned.ID})
	result, err := tasks.Execute(ctx, domain.ModelToolCall{Name: "wait_agent", Arguments: args})
	if err != nil || !strings.Contains(result, "hello") {
		t.Fatalf("%s %v", result, err)
	}
	tasks.parent.ID = "unrelated"
	if _, err = tasks.Execute(ctx, domain.ModelToolCall{Name: "stop_agent", Arguments: args}); err == nil {
		t.Fatal("stopped another parent's agent")
	}
}

type blockModel struct{ started chan struct{} }

func (b blockModel) Stream(ctx context.Context, _ domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
	b.started <- struct{}{}
	<-ctx.Done()
	return domain.ModelResult{}, ctx.Err()
}
func TestNativeTaskCancellationLimitsAndGuidance(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	parent, err := f.Start(ctx, app.StartRequest{SessionID: "p", Agent: domain.AgentNative, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: parent.NativeID(), Model: "codex:fresh"}, emit: parent.(*app.NativeRuntime).Emit}
	for _, name := range []string{"spawn_agent", "wait_agent", "stop_agent", "send_agent"} {
		if tasks.NeedsApproval(domain.ModelToolCall{Name: name}) {
			t.Fatal("child management unexpectedly needs approval")
		}
	}
	if tasks.NeedsApproval(domain.ModelToolCall{Name: "local"}) {
		t.Fatal("changed base policy")
	}
	if _, err = tasks.Execute(ctx, domain.ModelToolCall{Name: "local"}); err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.Execute(ctx, domain.ModelToolCall{Name: "spawn_agent", Arguments: []byte(`{`)}); err == nil {
		t.Fatal("malformed args accepted")
	}
	if _, err = tasks.spawn(ctx, "", "", false); err == nil {
		t.Fatal("empty task accepted")
	}
	tasks.parent.Depth = 3
	if _, err = tasks.spawn(ctx, "task", "", false); err == nil {
		t.Fatal("depth exceeded")
	}
	tasks.parent.Depth = 0
	for i := 0; i < 4; i++ {
		if _, err = tasks.spawn(ctx, "task", "", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tasks.spawn(ctx, "task", "", false); err == nil {
		t.Fatal("concurrency exceeded")
	}
	// Pending tasks are represented in the same ownership map as attached tasks.
	f.tasks = map[string]string{"child": parent.NativeID(), "sibling": "another-parent"}
	started := make(chan struct{}, 2)
	for _, id := range []string{"child", "sibling"} {
		r := app.NewNativeRuntime(app.NativeRuntimeConfig{SessionID: domain.SessionID(id), Conversation: domain.Conversation{ID: id, Parent: f.tasks[id]}, Model: blockModel{started}, Tools: noTools{}, Repo: f.Repo})
		f.runtimes[id] = r
		if err = r.Send(ctx, "turn", "work"); err != nil {
			t.Fatal(err)
		}
	}
	<-started
	<-started
	args := []byte(`{"id":"child","message":"guidance"}`)
	if _, err = tasks.Execute(ctx, domain.ModelToolCall{Name: "send_agent", Arguments: args}); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err = tasks.Execute(cancelled, domain.ModelToolCall{Name: "wait_agent", Arguments: args}); err == nil {
		t.Fatal("wait ignored cancellation")
	}
	if err = parent.Interrupt(ctx); err != nil {
		t.Fatal(err)
	}
	child := f.runtimes["child"]
	for ev := range child.Events() {
		if ev.Type == domain.EventTurnEnded {
			break
		}
	}
	if !f.runtimes["sibling"].Running() {
		t.Fatal("interrupted unrelated child")
	}
	result, err := tasks.Execute(ctx, domain.ModelToolCall{Name: "wait_agent", Arguments: args})
	if err != nil || !strings.Contains(result, "canceled") {
		t.Fatalf("%s %v", result, err)
	}
	saved, _ := f.Repo.LoadConversation(ctx, "child")
	if saved.Messages[len(saved.Messages)-1].Text != "guidance" {
		t.Fatal("lost accepted guidance")
	}
	if _, err = tasks.Execute(ctx, domain.ModelToolCall{Name: "stop_agent", Arguments: args}); err != nil {
		t.Fatal(err)
	}
}

func TestNativeInterruptCancelsPendingChildrenBeforeAttachment(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	parent, err := f.Start(ctx, app.StartRequest{Agent: domain.AgentNative, SessionID: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: parent.NativeID(), Model: "codex:fresh"}, emit: parent.(*app.NativeRuntime).Emit}
	raw, err := tasks.spawn(ctx, "pending task", "", false)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	if err = parent.Interrupt(ctx); err != nil {
		t.Fatal(err)
	}
	child, err := f.Repo.LoadConversation(ctx, result.ID)
	if err != nil || child.Busy || child.PendingPrompt != "" || child.LastError == "" {
		t.Fatalf("pending task survived interruption: %+v %v", child, err)
	}
}

func TestDeletedChildDoesNotBlockFutureSpawns(t *testing.T) {
	f, _ := testFactory(t)
	f.tasks = map[string]string{"deleted": "parent"}
	tools := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: "parent", Model: "codex:fresh"}, emit: func(domain.Event) {}}
	if _, err := tools.spawn(context.Background(), "new task", "", false); err != nil {
		t.Fatal("deleted journal blocked next child", err)
	}
}

func TestWaitAfterRestartReportsUnattachedInterruptedChild(t *testing.T) {
	f, _ := testFactory(t)
	if err := f.Repo.SaveConversation(context.Background(), domain.Conversation{ID: "orphan", Parent: "parent", Busy: true}); err != nil {
		t.Fatal(err)
	}
	tools := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: "parent"}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	output, err := tools.Execute(ctx, domain.ModelToolCall{Name: "wait_agent", Arguments: []byte(`{"id":"orphan"}`)})
	if err != nil || !strings.Contains(output, "interrupted") {
		t.Fatalf("unattached child reported as running: %s %v", output, err)
	}
}

func TestOnlyRootCanSpawnAgents(t *testing.T) {
	for _, tc := range []struct {
		name         string
		conversation domain.Conversation
		allowed      bool
	}{
		{"root", domain.Conversation{ID: "root", Model: "codex:fresh"}, true},
		{"child", domain.Conversation{ID: "child", Parent: "root", Depth: 1}, false},
		{"legacy grandchild", domain.Conversation{ID: "child", Parent: "parent", Depth: 3}, false},
		{"parent marker", domain.Conversation{ID: "child", Parent: "root"}, false},
		{"depth marker", domain.Conversation{ID: "child", Depth: 1}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _ := testFactory(t)
			emitted := 0
			tools := &taskTools{base: noTools{}, factory: f, parent: tc.conversation, emit: func(domain.Event) { emitted++ }}
			offered := false
			for _, def := range tools.Definitions() {
				if def.Name == "spawn_agent" {
					offered = true
				}
			}
			if offered != tc.allowed {
				t.Errorf("spawn advertised=%v, want %v", offered, tc.allowed)
			}
			_, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "spawn_agent", Arguments: []byte(`{"task":"inspect code","background":true}`)})
			if tc.allowed {
				if err != nil || emitted != 1 {
					t.Fatalf("root spawn: emitted=%d err=%v", emitted, err)
				}
			} else if err == nil || emitted != 0 || len(f.tasks) != 0 {
				t.Fatalf("nested spawn accepted: emitted=%d tasks=%d err=%v", emitted, len(f.tasks), err)
			}
		})
	}
}

func TestChildReceivesExecutorInstructions(t *testing.T) {
	f, model := testFactory(t)
	ctx := context.Background()
	if err := f.Repo.SaveConversation(ctx, domain.Conversation{ID: "child", Parent: "parent", Depth: 1, Model: "codex:fresh"}); err != nil {
		t.Fatal(err)
	}
	rt, err := f.Start(ctx, app.StartRequest{SessionID: "child-session", Agent: domain.AgentNative, NativeID: "child", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Send(ctx, "turn", "inspect files"); err != nil {
		t.Fatal(err)
	}
	endTurn(t, rt)
	model.mu.Lock()
	defer model.mu.Unlock()
	req := model.requests[len(model.requests)-1]
	if !strings.Contains(req.Instructions, "Complete the assigned task yourself") {
		t.Fatalf("missing executor role: %s", req.Instructions)
	}
	for _, tool := range req.Tools {
		if tool.Name == "spawn_agent" {
			t.Fatal("child model received spawn_agent")
		}
	}
}

func TestSpawnReturnsChildResultUnlessBackground(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	parent, err := f.Start(ctx, app.StartRequest{SessionID: "parent", Agent: domain.AgentNative, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: parent.NativeID(), Model: "codex:fresh"}, emit: parent.(*app.NativeRuntime).Emit}
	type outcome struct {
		output string
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		output, err := tasks.Execute(ctx, domain.ModelToolCall{Name: "spawn_agent", Arguments: []byte(`{"task":"inspect code"}`)})
		done <- outcome{output, err}
	}()
	var spawned string
	select {
	case ev := <-parent.Events():
		spawned = ev.Subagent.ThreadID
	case <-time.After(time.Second):
		t.Fatal("missing spawn event")
	}
	select {
	case got := <-done:
		t.Fatalf("spawn returned before the child finished: %+v", got)
	case <-time.After(100 * time.Millisecond):
	}
	child, err := f.Start(ctx, app.StartRequest{SessionID: "child", Agent: domain.AgentNative, NativeID: spawned, Passive: true, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	endTurn(t, child)
	select {
	case got := <-done:
		if got.err != nil || !strings.Contains(got.output, "hello") || !strings.Contains(got.output, spawned) || !strings.Contains(got.output, `"completed"`) {
			t.Fatalf("%+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("spawn did not return the child result")
	}
}

func TestSpawnFailsWhenChildNeverStarts(t *testing.T) {
	f, _ := testFactory(t)
	old := childStartTimeout
	childStartTimeout = 20 * time.Millisecond
	t.Cleanup(func() { childStartTimeout = old })
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: "parent", Model: "codex:fresh"}, emit: func(domain.Event) {}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := tasks.Execute(ctx, domain.ModelToolCall{Name: "spawn_agent", Arguments: []byte(`{"task":"inspect code"}`)})
	if err == nil || !strings.Contains(err.Error(), "did not start") {
		t.Fatalf("unstarted child kept the parent waiting: %v", err)
	}
	for id := range f.tasks {
		child, _ := f.Repo.LoadConversation(ctx, id)
		if child.Busy || child.PendingPrompt != "" {
			t.Fatalf("unstarted child still counts as active: %+v", child)
		}
	}
}

func TestRootIsToldToPlanAndDelegateSparingly(t *testing.T) {
	f, model := testFactory(t)
	ctx := context.Background()
	rt, err := f.Start(ctx, app.StartRequest{SessionID: "root", Agent: domain.AgentNative, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Send(ctx, "turn", "do the work"); err != nil {
		t.Fatal(err)
	}
	endTurn(t, rt)
	model.mu.Lock()
	defer model.mu.Unlock()
	instructions := model.requests[len(model.requests)-1].Instructions
	for _, want := range []string{"update_plan", "do the steps yourself", "same files"} {
		if !strings.Contains(instructions, want) {
			t.Errorf("root instructions lack %q: %s", want, instructions)
		}
	}
}

func TestGoalDoesNotOutliveItsRunAcrossRestartOrFork(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	goal, _ := domain.NewGoal("ship it")
	if err := f.Repo.SaveConversation(ctx, domain.Conversation{ID: "root", Model: "codex:fresh", Busy: true, Goal: goal}); err != nil {
		t.Fatal(err)
	}
	fork, err := f.Start(ctx, app.StartRequest{SessionID: "fork", Agent: domain.AgentNative, NativeID: "root", Fork: true, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if forked, _ := f.Repo.LoadConversation(ctx, fork.NativeID()); forked.Goal != nil {
		t.Fatalf("fork inherited the goal: %+v", forked.Goal)
	}
	root, err := f.Start(ctx, app.StartRequest{SessionID: "root", Agent: domain.AgentNative, NativeID: "root", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-root.Events():
		if ev.Type != domain.EventGoal || ev.Goal == nil || ev.Goal.Status != domain.GoalPaused {
			t.Fatalf("attached session not told its goal: %+v", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("attached session not told its goal")
	}
	resumed, _ := f.Repo.LoadConversation(ctx, "root")
	if resumed.Goal == nil || resumed.Goal.Status != domain.GoalPaused || resumed.Goal.Note == "" {
		t.Fatalf("goal left active with nothing pursuing it: %+v", resumed.Goal)
	}
	commands, err := f.Commands(ctx, domain.AgentNative, t.TempDir())
	if err != nil || len(commands) < 2 || commands[1].Name != "goal" || commands[1].Insert != "/goal " {
		t.Fatalf("%+v %v", commands, err)
	}
}

func backgroundChild(t *testing.T, f *Factory, parent app.AgentRuntime) (*taskTools, string) {
	t.Helper()
	ctx := context.Background()
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: parent.NativeID(), Model: "codex:fresh"}, emit: parent.(*app.NativeRuntime).Emit}
	raw, err := tasks.Execute(ctx, domain.ModelToolCall{Name: "spawn_agent", Arguments: []byte(`{"task":"inspect code","title":"Review","background":true}`)})
	if err != nil || !strings.Contains(raw, "notified") {
		t.Fatalf("%s %v", raw, err)
	}
	var spawned struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(raw), &spawned)
	if ev := <-parent.Events(); ev.Type != domain.EventSubagentSpawned {
		t.Fatalf("%+v", ev)
	}
	return tasks, spawned.ID
}

func TestBackgroundChildWakesItsIdleParentWithTheResult(t *testing.T) {
	f, model := testFactory(t)
	ctx := context.Background()
	parent, err := f.Start(ctx, app.StartRequest{SessionID: "parent", Agent: domain.AgentNative, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	_, id := backgroundChild(t, f, parent)
	child, err := f.Start(ctx, app.StartRequest{SessionID: "child", Agent: domain.AgentNative, NativeID: id, Passive: true, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	endTurn(t, child)
	var shown string
	for ev := range parent.Events() {
		if ev.Type == domain.EventItemUpdated && ev.Item.Kind == domain.ItemUserMessage {
			shown = ev.Item.Text
		}
		if ev.Type == domain.EventTurnEnded {
			break
		}
	}
	if !strings.Contains(shown, "Review") {
		t.Fatalf("wake-up not shown in the parent transcript: %q", shown)
	}
	model.mu.Lock()
	defer model.mu.Unlock()
	messages := model.requests[len(model.requests)-1].Messages
	woke := messages[len(messages)-1]
	if woke.Role != "user" || !strings.Contains(woke.Text, id) || !strings.Contains(woke.Text, "hello") || !strings.Contains(woke.Text, "not a message from the user") {
		t.Fatalf("parent did not receive the child's result: %+v", woke)
	}
}

func TestBackgroundChildReportsIntoARunningParentTurn(t *testing.T) {
	f, _ := testFactory(t)
	ctx := context.Background()
	started := make(chan struct{}, 1)
	f.Providers["slow"] = Provider{Client: blockModel{started}, Catalog: f.Providers["codex"].Catalog}
	parent, err := f.Start(ctx, app.StartRequest{SessionID: "parent", Agent: domain.AgentNative, Model: "slow:fresh", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	_, id := backgroundChild(t, f, parent)
	if err = parent.Send(ctx, "turn", "long work"); err != nil {
		t.Fatal(err)
	}
	<-started
	saved, _ := f.Repo.LoadConversation(ctx, id)
	saved.Model = "codex:fresh"
	_ = f.Repo.SaveConversation(ctx, saved)
	child, err := f.Start(ctx, app.StartRequest{SessionID: "child", Agent: domain.AgentNative, NativeID: id, Passive: true, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	endTurn(t, child)
	_ = child.Close() // Returns once the child has delivered its report.
	_ = parent.Interrupt(ctx)
	shown := false
	for ev := range parent.Events() {
		shown = shown || ev.Type == domain.EventItemUpdated && ev.Item.Kind == domain.ItemUserMessage && strings.Contains(ev.Item.Text, "Review") && ev.Item.TurnID == "turn"
		if ev.Type == domain.EventTurnEnded {
			break
		}
	}
	if !shown {
		t.Fatal("report into a running turn not shown in the transcript")
	}
	got, _ := f.Repo.LoadConversation(ctx, parent.NativeID())
	last := got.Messages[len(got.Messages)-1]
	if last.Role != "user" || !strings.Contains(last.Text, id) || !strings.Contains(last.Text, "hello") {
		t.Fatalf("running parent lost the child's result: %+v", got.Messages)
	}
}

func TestForegroundChildDoesNotWakeItsParent(t *testing.T) {
	f, model := testFactory(t)
	ctx := context.Background()
	parent, err := f.Start(ctx, app.StartRequest{SessionID: "parent", Agent: domain.AgentNative, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	tasks := &taskTools{base: noTools{}, factory: f, parent: domain.Conversation{ID: parent.NativeID(), Model: "codex:fresh"}, emit: parent.(*app.NativeRuntime).Emit}
	raw, err := tasks.spawn(ctx, "inspect code", "", false)
	if err != nil {
		t.Fatal(err)
	}
	var spawned struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(raw), &spawned)
	<-parent.Events()
	child, err := f.Start(ctx, app.StartRequest{SessionID: "child", Agent: domain.AgentNative, NativeID: spawned.ID, Passive: true, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	endTurn(t, child)
	select {
	case ev := <-parent.Events():
		t.Fatalf("parent woken for a result it already holds: %+v", ev)
	case <-time.After(200 * time.Millisecond):
	}
	model.mu.Lock()
	defer model.mu.Unlock()
	if len(model.requests) != 1 {
		t.Fatalf("model called %d times", len(model.requests))
	}
}
