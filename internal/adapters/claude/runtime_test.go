package claude

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

var fakeBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakeclaude")
	if err != nil {
		panic(err)
	}
	fakeBin = filepath.Join(dir, "fakeclaude")
	out, err := exec.Command("go", "build", "-o", fakeBin, "../../../testutil/fakeclaude").CombinedOutput()
	if err != nil {
		_, _ = os.Stderr.WriteString("build fakeclaude: " + err.Error() + "\n" + string(out))
		os.Exit(1)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func startFake(t *testing.T, req app.StartRequest, env ...string) *Runtime {
	t.Helper()
	f := &Factory{Binary: fakeBin, Env: env, Stderr: os.Stderr}
	if req.SessionID == "" {
		req.SessionID = "s1"
	}
	if req.Agent == "" {
		req.Agent = domain.AgentClaude
	}
	if req.Cwd == "" {
		req.Cwd = t.TempDir()
	}
	rt, err := f.Start(context.Background(), req)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	concrete, ok := rt.(*Runtime)
	if !ok {
		t.Fatalf("Start returned %T", rt)
	}
	t.Cleanup(func() { _ = concrete.Close() })
	return concrete
}

// drain collects events until done returns true or the channel closes.
func drain(t *testing.T, rt *Runtime, done func(domain.Event) bool) []domain.Event {
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

func TestRuntimeStreamsTextTurn(t *testing.T) {
	rt := startFake(t, app.StartRequest{})
	if !uuidRe.MatchString(rt.NativeID()) {
		t.Fatalf("native = %q, want a UUID chosen before the first message", rt.NativeID())
	}
	if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
		t.Fatal(err)
	}
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })

	var text string
	var assistant *domain.Item
	for _, ev := range events {
		switch ev.Type {
		case domain.EventTextDelta:
			text += ev.Delta.Text
		case domain.EventItemUpdated:
			if ev.Item.Kind == domain.ItemAssistantMessage {
				assistant = ev.Item
			}
		}
	}
	if text != "echo: hi" {
		t.Fatalf("text = %q", text)
	}
	if assistant == nil || assistant.Text != "echo: hi" || assistant.TurnID != "t1" {
		t.Fatalf("assistant = %+v", assistant)
	}
	if events[len(events)-1].Result.Text != "echo: hi" {
		t.Fatalf("result = %+v", events[len(events)-1].Result)
	}
}

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func TestRuntimeResumesWithGivenID(t *testing.T) {
	rt := startFake(t, app.StartRequest{NativeID: "native-42"})
	if rt.NativeID() != "native-42" {
		t.Fatalf("native = %q", rt.NativeID())
	}
}

// The real CLI writes system/init only after the first user message, so the
// session id is chosen up front with --session-id instead of awaited.
func TestNativeIDIsKnownBeforeTheFirstMessage(t *testing.T) {
	for _, req := range []app.StartRequest{{}, {NativeID: "native-42", Fork: true}} {
		rt := startFake(t, req)
		native := rt.NativeID()
		if !uuidRe.MatchString(native) || native == req.NativeID {
			t.Fatalf("req %+v: native = %q, want a fresh UUID", req, native)
		}
		if err := rt.Send(context.Background(), "t1", "hi"); err != nil {
			t.Fatal(err)
		}
		drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
		if rt.NativeID() != native {
			t.Fatalf("native changed to %q after init", rt.NativeID())
		}
	}
}

func TestRuntimeToolTurn(t *testing.T) {
	rt := startFake(t, app.StartRequest{}, "FAKECLAUDE_MODE=tool")
	if err := rt.Send(context.Background(), "t1", "x"); err != nil {
		t.Fatal(err)
	}
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	var cmdItem *domain.Item
	for _, ev := range events {
		if ev.Item != nil && ev.Item.Kind == domain.ItemCommand {
			cmdItem = ev.Item
		}
	}
	if cmdItem == nil || cmdItem.Name != "Bash" || cmdItem.Text != "ran: x" {
		t.Fatalf("command item = %+v", cmdItem)
	}
	if string(cmdItem.Input) != `{"command":"echo x"}` {
		t.Fatalf("input = %s", cmdItem.Input)
	}
}

func TestRuntimeExitsMidTurnClosesEvents(t *testing.T) {
	rt := startFake(t, app.StartRequest{}, "FAKECLAUDE_MODE=die")
	if err := rt.Send(context.Background(), "t1", "bye"); err != nil {
		t.Fatal(err)
	}
	// Channel must close without a turn-ended event.
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	for _, ev := range events {
		if ev.Type == domain.EventTurnEnded {
			t.Fatal("unexpected turn end from dying process")
		}
	}
}

func TestRuntimeInterrupt(t *testing.T) {
	rt := startFake(t, app.StartRequest{})
	if err := rt.Interrupt(context.Background()); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
}

func TestFactoryArgsFor(t *testing.T) {
	f := &Factory{Args: []string{"--debug"}}
	cases := []struct {
		req      app.StartRequest
		native   string
		want     []string
		unwanted []string
	}{
		{app.StartRequest{Model: "m", PermissionMode: "plan"}, "u1",
			[]string{"-p", "--input-format stream-json", "--output-format stream-json",
				"--include-partial-messages", "--permission-prompt-tool stdio", "--session-id u1", "--model m", "--permission-mode plan", "--debug"},
			[]string{"--resume", "--fork-session"}},
		{app.StartRequest{NativeID: "n"}, "n", []string{"--resume n"}, []string{"--session-id", "--fork-session"}},
		{app.StartRequest{NativeID: "n", Fork: true}, "u2", []string{"--resume n --fork-session --session-id u2"}, nil},
	}
	for _, tc := range cases {
		joined := strings.Join(f.argsFor(tc.req, tc.native), " ")
		for _, want := range tc.want {
			if !strings.Contains(joined, want) {
				t.Errorf("args %q missing %q", joined, want)
			}
		}
		for _, bad := range tc.unwanted {
			if strings.Contains(joined, bad) {
				t.Errorf("args %q must not contain %q", joined, bad)
			}
		}
	}
}

func TestFactoryStartMissingBinary(t *testing.T) {
	f := &Factory{Binary: filepath.Join(t.TempDir(), "nope")}
	if _, err := f.Start(context.Background(), app.StartRequest{SessionID: "s", Cwd: t.TempDir()}); err == nil {
		t.Fatal("want error for missing binary")
	}
}

func TestFactoryDefaults(t *testing.T) {
	f := &Factory{}
	if f.binary() != "claude" {
		t.Fatalf("binary = %q", f.binary())
	}
	if f.stderr() != os.Stderr {
		t.Fatal("default stderr must be os.Stderr")
	}
}

func TestProcessExitingBeforeFirstMessageClosesEvents(t *testing.T) {
	f := &Factory{Binary: "/bin/sh", Args: []string{"-c", "exit 7"}, Stderr: io.Discard}
	rt, err := f.Start(context.Background(), app.StartRequest{SessionID: "s", Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	select {
	case _, ok := <-rt.Events():
		if ok {
			t.Fatal("unexpected event from a dead process")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("events not closed after the process exited")
	}
}

func TestStartHonorsContextCancellation(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: io.Discard}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.Start(ctx, app.StartRequest{SessionID: "s", Cwd: t.TempDir()}); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

func TestRuntimeInjectInputError(t *testing.T) {
	rt := startFake(t, app.StartRequest{})
	_ = rt.Close()
	if err := rt.Send(context.Background(), "t", "after close"); err == nil {
		t.Fatal("want write error after close")
	}
}

func waitRequest(t *testing.T, rt *Runtime) *domain.Request {
	t.Helper()
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventRequestOpened })
	for _, ev := range events {
		if ev.Request != nil {
			return ev.Request
		}
	}
	t.Fatalf("no request in %+v", events)
	return nil
}

func waitTurnEnd(t *testing.T, rt *Runtime) domain.TurnResult {
	t.Helper()
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	last := events[len(events)-1]
	if last.Result == nil {
		t.Fatalf("turn ended without result: %+v", last)
	}
	return *last.Result
}

func TestRuntimePermissionAllow(t *testing.T) {
	rt := startFake(t, app.StartRequest{}, "FAKECLAUDE_MODE=permission")
	if err := rt.Send(context.Background(), "t1", "rm -rf x"); err != nil {
		t.Fatal(err)
	}
	req := waitRequest(t, rt)
	if req.Kind != domain.RequestPermission || req.Title != "Run command" {
		t.Fatalf("request = %+v", req)
	}
	if err := rt.Respond(context.Background(), req.ID, app.RequestAnswer{Allow: true}); err != nil {
		t.Fatal(err)
	}
	res := waitTurnEnd(t, rt)
	if res.Text != "approved: run "+string(req.ID) {
		t.Fatalf("result = %+v", res)
	}
}

func TestRuntimePermissionDeny(t *testing.T) {
	rt := startFake(t, app.StartRequest{}, "FAKECLAUDE_MODE=permission")
	if err := rt.Send(context.Background(), "t1", "rm -rf x"); err != nil {
		t.Fatal(err)
	}
	req := waitRequest(t, rt)
	if err := rt.Respond(context.Background(), req.ID, app.RequestAnswer{Allow: false, Message: "nope"}); err != nil {
		t.Fatal(err)
	}
	if res := waitTurnEnd(t, rt); res.Text != "denied: nope" {
		t.Fatalf("result = %+v", res)
	}
}

func TestRuntimeQuestionAnswer(t *testing.T) {
	rt := startFake(t, app.StartRequest{}, "FAKECLAUDE_MODE=question")
	if err := rt.Send(context.Background(), "t1", "ask me"); err != nil {
		t.Fatal(err)
	}
	req := waitRequest(t, rt)
	if req.Kind != domain.RequestQuestion {
		t.Fatalf("request = %+v", req)
	}
	answer := app.RequestAnswer{Allow: true, Answers: map[string][]string{
		"Which option should we use?": {"Alpha"},
	}}
	if err := rt.Respond(context.Background(), req.ID, answer); err != nil {
		t.Fatal(err)
	}
	res := waitTurnEnd(t, rt)
	if !strings.Contains(res.Text, "Alpha") {
		t.Fatalf("result = %+v", res)
	}
}

func TestRuntimeRespondUnknownRequest(t *testing.T) {
	rt := startFake(t, app.StartRequest{})
	if err := rt.Respond(context.Background(), "missing", app.RequestAnswer{Allow: true}); err == nil {
		t.Fatal("want error for unknown request")
	}
}

func TestRuntimeStopTask(t *testing.T) {
	rt := startFake(t, app.StartRequest{})
	if err := rt.StopTask(context.Background(), "task-1"); err != nil {
		t.Fatalf("stop task: %v", err)
	}
}
