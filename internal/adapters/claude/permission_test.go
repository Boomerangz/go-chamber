package claude

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func askMode(t *testing.T, rt *Runtime) string {
	t.Helper()
	if err := rt.Send(context.Background(), "t", "current mode?"); err != nil {
		t.Fatal(err)
	}
	events := drain(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	return events[len(events)-1].Result.Text
}

func TestRuntimePermissionModeSwitchesLive(t *testing.T) {
	rt := startFake(t, app.StartRequest{PermissionMode: "plan"})
	var _ app.PermissionModeSetter = rt
	if got := askMode(t, rt); got != "mode: plan" {
		t.Fatalf("start = %q", got)
	}
	if err := rt.SetPermissionMode(context.Background(), "acceptEdits"); err != nil {
		t.Fatal(err)
	}
	if got := askMode(t, rt); got != "mode: acceptEdits" {
		t.Fatalf("after switch = %q", got)
	}
	if err := rt.SetPermissionMode(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if got := askMode(t, rt); got != "mode: default" {
		t.Fatalf("after reset = %q", got)
	}
}

func TestRuntimeBypassNeedsARestartUnlessStartedWithIt(t *testing.T) {
	rt := startFake(t, app.StartRequest{})
	if err := rt.SetPermissionMode(context.Background(), "bypassPermissions"); !errors.Is(err, app.ErrRestartRequired) {
		t.Fatalf("err = %v, want ErrRestartRequired", err)
	}
	bypass := startFake(t, app.StartRequest{PermissionMode: "bypassPermissions"})
	if err := bypass.SetPermissionMode(context.Background(), "default"); err != nil {
		t.Fatal(err)
	}
	if err := bypass.SetPermissionMode(context.Background(), "bypassPermissions"); err != nil {
		t.Fatalf("back to bypass: %v", err)
	}
}
