package codex

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func startSupervised(t *testing.T, binary string, env ...string) (*Factory, *Runtime) {
	t.Helper()
	f := &Factory{Binary: binary, Env: env, Stderr: os.Stderr, InitTimeout: 10 * time.Second,
		RestartBackoff: 10 * time.Millisecond, RestartAttempts: 3}
	rt, err := f.Start(context.Background(), app.StartRequest{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = rt.Close()
		f.Close()
	})
	return f, rt.(*Runtime)
}

func killServer(t *testing.T, f *Factory) *Server {
	t.Helper()
	f.mu.Lock()
	srv := f.server
	f.mu.Unlock()
	_ = srv.cmd.Process.Kill()
	return srv
}

func TestCrashedServerIsRestartedAndThreadsResumed(t *testing.T) {
	f, rt := startSupervised(t, fakeBin)
	old := killServer(t, f)
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		srv := f.server
		f.mu.Unlock()
		if srv != nil && srv != old && srv.alive() && rt.current() == srv {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server not restarted or thread not resumed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := rt.Send(context.Background(), "t2", "after crash"); err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if got := events[len(events)-1].Result.Text; got != "echo: after crash" {
		t.Fatalf("result = %q", got)
	}
}

func TestCrashDuringTurnEndsItAndStalesRequests(t *testing.T) {
	f, rt := startSupervised(t, fakeBin, "FAKECODEX_MODE=permission")
	if err := rt.Send(context.Background(), "t1", "run"); err != nil {
		t.Fatal(err)
	}
	req := waitCodexRequest(t, rt)
	killServer(t, f)
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	var stale bool
	last := map[domain.ItemID]domain.ItemStatus{}
	for _, ev := range events {
		if ev.Type == domain.EventRequestResolved && ev.Request.ID == req.ID && ev.Request.State == domain.RequestStale {
			stale = true
		}
		if ev.Type == domain.EventItemUpdated {
			last[ev.Item.ID] = ev.Item.Status
		}
	}
	for id, st := range last {
		if !st.Terminal() {
			t.Fatalf("item %s left %s", id, st)
		}
	}
	end := events[len(events)-1].Result
	if !stale || end == nil || !end.IsError || !strings.Contains(end.Error, "restarted") {
		t.Fatalf("stale = %v, result = %+v", stale, end)
	}
}

func TestServerThatCannotRestartClosesThreads(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "codex")
	data, err := os.ReadFile(fakeBin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, data, 0o755); err != nil {
		t.Fatal(err)
	}
	f, rt := startSupervised(t, bin)
	_ = os.Remove(bin)
	killServer(t, f)
	drainCodex(t, rt, func(domain.Event) bool { return false })
}
