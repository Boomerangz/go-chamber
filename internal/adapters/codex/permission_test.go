package codex

import (
	"context"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func askMode(t *testing.T, rt *Runtime) string {
	t.Helper()
	if err := rt.Send(context.Background(), "t", "current mode?"); err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	return events[len(events)-1].Result.Text
}

func TestCodexPermissionModePresets(t *testing.T) {
	rt := startCodex(t, app.StartRequest{PermissionMode: "read-only"})
	if got := askMode(t, rt); got != "mode: on-request readOnly" {
		t.Fatalf("start = %q", got)
	}
	var _ app.PermissionModeSetter = rt
	for mode, want := range map[string]string{
		"auto":        "mode: on-request workspaceWrite",
		"full-access": "mode: never dangerFullAccess",
	} {
		if err := rt.SetPermissionMode(context.Background(), mode); err != nil {
			t.Fatal(err)
		}
		if got := askMode(t, rt); got != want {
			t.Fatalf("%s = %q, want %q", mode, got, want)
		}
	}
}

func TestCodexFullAccessRunsWithoutAsking(t *testing.T) {
	rt := startCodex(t, app.StartRequest{PermissionMode: "full-access"}, "FAKECODEX_MODE=permission")
	if req, res := permissionResult(t, rt); req != nil || !strings.Contains(res, "approved") {
		t.Fatalf("request %+v, result %q", req, res)
	}
}
