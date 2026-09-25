package codex

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

var fakeBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakecodex")
	if err != nil {
		panic(err)
	}
	fakeBin = filepath.Join(dir, "codex")
	out, err := exec.Command("go", "build", "-o", fakeBin, "../../../testutil/fakecodex").CombinedOutput()
	if err != nil {
		_, _ = os.Stderr.WriteString("build fakecodex: " + err.Error() + "\n" + string(out))
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func startCodex(t *testing.T, req app.StartRequest, env ...string) *Runtime {
	t.Helper()
	f := &Factory{Binary: fakeBin, Env: env, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	if req.SessionID == "" {
		req.SessionID = "s1"
	}
	if req.Cwd == "" {
		req.Cwd = t.TempDir()
	}
	rt, err := f.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	concrete := rt.(*Runtime)
	t.Cleanup(func() {
		_ = concrete.Close()
		f.Close()
	})
	return concrete
}

func drainCodex(t *testing.T, rt *Runtime, done func(domain.Event) bool) []domain.Event {
	t.Helper()
	var out []domain.Event
	timeout := time.After(10 * time.Second)
	for {
		select {
		case ev, ok := <-rt.Events():
			if !ok {
				return out
			}
			out = append(out, ev)
			if done(ev) {
				return out
			}
		case <-timeout:
			t.Fatalf("timed out; got %+v", out)
		}
	}
}

func TestCodexEchoTurn(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	if !strings.HasPrefix(rt.NativeID(), "thread-") {
		t.Fatalf("native = %q", rt.NativeID())
	}
	if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	var assistant *domain.Item
	var text string
	for _, ev := range events {
		if ev.Type == domain.EventTextDelta {
			text += ev.Delta.Text
		}
		if ev.Item != nil && ev.Item.Kind == domain.ItemAssistantMessage {
			assistant = ev.Item
		}
	}
	if !strings.Contains(text, "echo: hi") {
		t.Fatalf("streamed = %q", text)
	}
	if assistant == nil || assistant.Status != domain.ItemCompleted {
		t.Fatalf("assistant = %+v", assistant)
	}
	if events[len(events)-1].Result.Text != "echo: hi" {
		t.Fatalf("result = %+v", events[len(events)-1].Result)
	}
}

func TestCodexResumeKeepsThreadID(t *testing.T) {
	rt := startCodex(t, app.StartRequest{NativeID: "thread-42"})
	if rt.NativeID() != "thread-42" {
		t.Fatalf("native = %q", rt.NativeID())
	}
}

func TestCodexSharedServerAcrossThreads(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	a, err := f.Start(context.Background(), app.StartRequest{SessionID: "a", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.Start(context.Background(), app.StartRequest{SessionID: "b", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	ra, rb := a.(*Runtime), b.(*Runtime)
	if ra.NativeID() == rb.NativeID() {
		t.Fatal("threads must differ")
	}
	if err := ra.Send(context.Background(), "t", "one"); err != nil {
		t.Fatal(err)
	}
	if err := rb.Send(context.Background(), "t", "two"); err != nil {
		t.Fatal(err)
	}
	drainCodex(t, ra, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	drainCodex(t, rb, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
}

func TestCodexPermissionApproval(t *testing.T) {
	rt := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=permission")
	if err := rt.Send(context.Background(), "t1", "rm -rf x"); err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventRequestOpened })
	var req *domain.Request
	for _, ev := range events {
		if ev.Request != nil {
			req = ev.Request
		}
	}
	if req == nil || req.Kind != domain.RequestPermission {
		t.Fatalf("request = %+v", req)
	}
	if err := rt.Respond(context.Background(), req.ID, app.RequestAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
	res := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if last := res[len(res)-1].Result; last == nil || !strings.Contains(last.Text, "approved") {
		t.Fatalf("result = %+v", last)
	}
}

func TestCodexPermissionDecline(t *testing.T) {
	rt := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=permission")
	if err := rt.Send(context.Background(), "t1", "rm -rf x"); err != nil {
		t.Fatal(err)
	}
	req := waitCodexRequest(t, rt)
	if err := rt.Respond(context.Background(), req.ID, app.RequestAnswer{Allow: false}); err != nil {
		t.Fatal(err)
	}
	res := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if last := res[len(res)-1].Result; last == nil || last.Text != "denied" {
		t.Fatalf("result = %+v", last)
	}
}

func TestCodexQuestion(t *testing.T) {
	rt := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=question")
	if err := rt.Send(context.Background(), "t1", "ask me"); err != nil {
		t.Fatal(err)
	}
	req := waitCodexRequest(t, rt)
	if req.Kind != domain.RequestQuestion {
		t.Fatalf("request = %+v", req)
	}
	answer := app.RequestAnswer{Allow: true, Answers: map[string][]string{"Which option should we use?": {"Alpha"}}}
	if err := rt.Respond(context.Background(), req.ID, answer); err != nil {
		t.Fatal(err)
	}
	res := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if last := res[len(res)-1].Result; last == nil || !strings.Contains(last.Text, "Alpha") {
		t.Fatalf("result = %+v", last)
	}
}

func TestCodexInterruptAndUnknownRespond(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
		t.Fatal(err)
	}
	if err := rt.Interrupt(context.Background()); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	if err := rt.Respond(context.Background(), "missing", app.RequestAnswer{}); err == nil {
		t.Fatal("want error for unknown request")
	}
}

func TestCodexFactoryMissingBinary(t *testing.T) {
	f := &Factory{Binary: filepath.Join(t.TempDir(), "nope"), InitTimeout: time.Second}
	if _, err := f.Start(context.Background(), app.StartRequest{SessionID: "s", Cwd: t.TempDir()}); err == nil {
		t.Fatal("want error for missing binary")
	}
}

func waitCodexRequest(t *testing.T, rt *Runtime) *domain.Request {
	t.Helper()
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventRequestOpened })
	for _, ev := range events {
		if ev.Request != nil {
			return ev.Request
		}
	}
	t.Fatalf("no request in %+v", events)
	return nil
}

func TestCodexFactoryDefaults(t *testing.T) {
	f := &Factory{}
	if f.binary() != "codex" {
		t.Fatalf("binary = %q", f.binary())
	}
	if f.stderr() != os.Stderr {
		t.Fatal("default stderr must be os.Stderr")
	}
}

func TestCodexDecisionBranches(t *testing.T) {
	cmd := pendingServerRequest{method: "item/commandExecution/requestApproval"}
	if res, _ := codexDecision(cmd, app.RequestAnswer{Allow: true, AllowForSession: true}); res.(map[string]any)["decision"] != "acceptForSession" {
		t.Fatalf("acceptForSession = %+v", res)
	}
	if res, _ := codexDecision(cmd, app.RequestAnswer{Allow: true}); res.(map[string]any)["decision"] != "accept" {
		t.Fatalf("accept = %+v", res)
	}
	if res, _ := codexDecision(cmd, app.RequestAnswer{Allow: false, Message: "cancel"}); res.(map[string]any)["decision"] != "cancel" {
		t.Fatalf("cancel = %+v", res)
	}
	if res, _ := codexDecision(cmd, app.RequestAnswer{Allow: false}); res.(map[string]any)["decision"] != "decline" {
		t.Fatalf("decline = %+v", res)
	}

	file := pendingServerRequest{method: "item/fileChange/requestApproval"}
	if res, _ := codexDecision(file, app.RequestAnswer{Allow: true}); res.(map[string]any)["decision"] != "accept" {
		t.Fatalf("file = %+v", res)
	}

	perms := pendingServerRequest{method: "item/permissions/requestApproval", params: json.RawMessage(`{"permissions":{"network":true}}`)}
	if res, _ := codexDecision(perms, app.RequestAnswer{Allow: true}); res.(map[string]any)["permissions"] == nil {
		t.Fatalf("permissions = %+v", res)
	}
	if res, _ := codexDecision(perms, app.RequestAnswer{Allow: false}); string(res.(map[string]any)["permissions"].(json.RawMessage)) != `{}` {
		t.Fatalf("denied permissions = %+v", res)
	}

	input := pendingServerRequest{method: "item/tool/requestUserInput", params: json.RawMessage(`{"questions":[{"id":"q1","question":"Pick?"}]}`)}
	res, err := codexDecision(input, app.RequestAnswer{Allow: true, Answers: map[string][]string{"Pick?": {"A", "B"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.(map[string]any)["answers"].(map[string]any)["q1"] == nil {
		t.Fatalf("answers = %+v", res)
	}

	elicit := pendingServerRequest{method: "mcpServer/elicitation/request"}
	if res, _ := codexDecision(elicit, app.RequestAnswer{Allow: true}); res.(map[string]any)["action"] != "accept" {
		t.Fatalf("elicit accept = %+v", res)
	}
	if res, _ := codexDecision(elicit, app.RequestAnswer{}); res.(map[string]any)["action"] != "decline" {
		t.Fatalf("elicit decline = %+v", res)
	}
	if _, err := codexDecision(pendingServerRequest{method: "weird"}, app.RequestAnswer{}); err == nil {
		t.Fatal("want error for unsupported method")
	}
}

func TestCodexInterruptWithoutTurnIsNoop(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	if err := rt.Interrupt(context.Background()); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
}

func TestCodexUnknownThreadMessages(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	rt.server.handleNotification("item/started", json.RawMessage(`{"threadId":"nope","item":{"type":"agentMessage","id":"x"}}`))
	rt.server.handleNotification("item/started", json.RawMessage(`not json`))
	rt.server.handleServerRequest(json.RawMessage(`1`), "x", json.RawMessage(`{"threadId":"nope"}`))
	rt.server.handleServerRequest(json.RawMessage(`2`), "weird/method", json.RawMessage(`{"threadId":"`+rt.threadID+`"}`))
	if !rt.server.alive() {
		t.Fatal("server should still be alive")
	}
}

func TestCodexCloseIsIdempotent(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCodexAccountAndLogin(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	ctx := context.Background()
	info, err := f.Account(ctx, domain.AgentCodex)
	if err != nil || info.LoggedIn {
		t.Fatalf("account = %+v, %v", info, err)
	}
	ch, err := f.StartLogin(ctx, domain.AgentCodex)
	if err != nil || ch.UserCode != "ABCD-EFGH" || ch.URL == "" {
		t.Fatalf("challenge = %+v, %v", ch, err)
	}
	if _, err := f.Account(ctx, domain.AgentClaude); err == nil {
		t.Fatal("codex factory must reject claude")
	}
	if _, err := f.StartLogin(ctx, domain.AgentClaude); err == nil {
		t.Fatal("codex factory must reject claude")
	}
}

func TestCodexAccountLoggedIn(t *testing.T) {
	f := &Factory{Binary: fakeBin, Env: []string{"FAKECODEX_LOGGED_IN=1"}, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	info, err := f.Account(context.Background(), domain.AgentCodex)
	if err != nil || !info.LoggedIn || info.Email != "dev@example.com" || info.Plan != "plus" || info.AuthMode != "chatgpt" {
		t.Fatalf("account = %+v, %v", info, err)
	}
}

func TestCodexSteer(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	if err := rt.Steer(context.Background(), "before"); err == nil {
		t.Fatal("steer without an active turn should fail")
	}
	if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
		t.Fatal(err)
	}
	if err := rt.Steer(context.Background(), "more"); err != nil {
		t.Fatalf("steer: %v", err)
	}
}

func TestCodexStopTaskInterrupts(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
		t.Fatal(err)
	}
	drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if err := rt.StopTask(context.Background(), "any"); err != nil {
		t.Fatalf("stop task: %v", err)
	}
}

func TestCodexAttachThreadReplaysOrphans(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	srv := rt.server
	srv.handleNotification("item/started", json.RawMessage(`{"threadId":"child","turnId":"t","item":{"type":"agentMessage","id":"i1","text":""}}`))
	child, err := srv.attachThread("child", "child-session")
	if err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, child, func(ev domain.Event) bool { return ev.Item != nil })
	if len(events) == 0 || events[0].SessionID != "child-session" {
		t.Fatalf("events = %+v", events)
	}
	// Second attach returns the same runtime.
	again, err := srv.attachThread("child", "child-session")
	if err != nil || again != child {
		t.Fatalf("reattach = %v, %v", again, err)
	}
}

func TestCodexRateLimits(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	q, err := f.RateLimits(context.Background(), domain.AgentCodex)
	if err != nil {
		t.Fatal(err)
	}
	if q.Plan != "plus" || len(q.Windows) != 2 || q.Windows[0].UsedPct != 25 {
		t.Fatalf("quota = %+v", q)
	}
	if _, err := f.RateLimits(context.Background(), domain.AgentClaude); err == nil {
		t.Fatal("codex factory must reject claude")
	}
}

func TestCodexStartEmitsQuota(t *testing.T) {
	rt := startCodex(t, app.StartRequest{})
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventQuota })
	last := events[len(events)-1]
	if last.Quota == nil || last.Quota.Agent != domain.AgentCodex {
		t.Fatalf("quota event = %+v", last)
	}
}

func permissionResult(t *testing.T, rt *Runtime) (req *domain.Request, result string) {
	t.Helper()
	if err := rt.Send(context.Background(), "t", "rm -rf x"); err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, rt, func(ev domain.Event) bool {
		return ev.Type == domain.EventRequestOpened || ev.Type == domain.EventTurnEnded
	})
	last := events[len(events)-1]
	if last.Request != nil {
		return last.Request, ""
	}
	return nil, last.Result.Text
}

func TestCodexApprovalReviewerOnStartAndLive(t *testing.T) {
	rt := startCodex(t, app.StartRequest{ApprovalReviewer: domain.ReviewerAuto}, "FAKECODEX_MODE=permission")
	if req, res := permissionResult(t, rt); req != nil || !strings.Contains(res, "auto-approved") {
		t.Fatalf("auto reviewer: request %+v, result %q", req, res)
	}
	var _ app.ApprovalReviewerSetter = rt
	if err := rt.SetApprovalReviewer(context.Background(), domain.ReviewerUser); err != nil {
		t.Fatal(err)
	}
	if req, _ := permissionResult(t, rt); req == nil {
		t.Fatal("user reviewer: want an approval request")
	}
}

func TestCodexApprovalReviewerOnResume(t *testing.T) {
	first := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=permission")
	rt := startCodex(t, app.StartRequest{NativeID: first.NativeID(), ApprovalReviewer: domain.ReviewerAuto}, "FAKECODEX_MODE=permission")
	if req, res := permissionResult(t, rt); req != nil || !strings.Contains(res, "auto-approved") {
		t.Fatalf("request %+v, result %q", req, res)
	}
}

func TestCodexDefaultReviewerIsNotSent(t *testing.T) {
	rt := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=permission")
	if req, _ := permissionResult(t, rt); req == nil {
		t.Fatal("want an approval request with the agent's default reviewer")
	}
}
