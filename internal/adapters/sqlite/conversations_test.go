package sqlite

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestNativeConversationJournalKeepsReplayAndPendingOutcomes(t *testing.T) {
	store := openTest(t)
	repo := store.Conversations()
	ctx := context.Background()
	if _, err := repo.LoadConversation(ctx, "missing"); !errors.Is(err, app.ErrConversationNotFound) {
		t.Fatal(err)
	}
	conv := domain.Conversation{ID: "native", Model: "codex:model", Messages: []domain.ModelMessage{{Role: "assistant", Replay: domain.ModelReplay{Format: "responses-v1", Data: json.RawMessage(`[{"encrypted_content":"opaque"}]`)}, ToolCalls: []domain.ModelToolCall{{ID: "call", Name: "write", Arguments: json.RawMessage(`{}`)}}}, {Role: "tool", CallID: "call", Text: "outcome unknown"}}, Busy: true}
	if err := repo.SaveConversation(ctx, conv); err != nil {
		t.Fatal(err)
	}
	loaded, err := repo.LoadConversation(ctx, "native")
	if err != nil || !loaded.Busy || string(loaded.Messages[0].Replay.Data) != string(conv.Messages[0].Replay.Data) {
		t.Fatalf("%+v %v", loaded, err)
	}
	loaded.Busy = false
	if err = repo.SaveConversation(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	snap := domain.SessionSnapshot{ID: "session", Agent: domain.AgentCodex, NativeID: "native", Cwd: "/tmp", Status: domain.StatusIdle}
	if err = store.Sessions().Save(ctx, snap); err != nil {
		t.Fatal(err)
	}
	if err = store.EraseSession(ctx, "session"); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.LoadConversation(ctx, "native"); !errors.Is(err, app.ErrConversationNotFound) {
		t.Fatal("conversation survived deletion", err)
	}
}
