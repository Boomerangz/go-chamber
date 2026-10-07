package apptest

import (
	"context"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// RuntimeContract is the common, provider-independent send/event/close contract.
// The supplied runtime is fresh; its fake CLI should echo a plain prompt.
func RuntimeContract(t *testing.T, runtime app.AgentRuntime) {
	t.Helper()
	if runtime.NativeID() == "" {
		t.Fatal("missing native session identity")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runtime.Send(ctx, "contract-turn", "hello"); err != nil {
		t.Fatal(err)
	}
	sawAssistant := false
	for {
		select {
		case ev, ok := <-runtime.Events():
			if !ok {
				t.Fatal("closed before turn completed")
			}
			if err := ev.Valid(); err != nil {
				t.Fatal(err)
			}
			if ev.Item != nil && ev.Item.Kind == domain.ItemAssistantMessage {
				sawAssistant = true
			}
			if ev.Type == domain.EventTurnEnded {
				if !sawAssistant {
					t.Fatal("no assistant item")
				}
				if err := runtime.Close(); err != nil {
					t.Fatal(err)
				}
				if err := runtime.Close(); err != nil {
					t.Fatal("close is not idempotent", err)
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("runtime failed to finish", ctx.Err())
		}
	}
}
