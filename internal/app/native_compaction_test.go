package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestNativeCompactionPreservesRecentToolGroupsAndRollsBackFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			repo := &nativeMemory{}
			history := []domain.ModelMessage{{Role: "user", Text: strings.Repeat("old context ", 1000)}, {Role: "assistant", Text: "old answer"}, {Role: "user", Text: "recent task"}, {Role: "assistant", ToolCalls: []domain.ModelToolCall{{ID: "a", Name: "read", Arguments: []byte(`{}`)}}}, {Role: "tool", CallID: "a", Text: "recent result"}, {Role: "assistant", Text: "recent answer"}}
			model := nativeModelFunc(func(_ context.Context, req domain.ModelRequest, _ func(domain.ModelDelta) error) (domain.ModelResult, error) {
				if len(req.Tools) != 0 {
					t.Error("summary can execute tools")
				}
				if fail {
					return domain.ModelResult{}, errors.New("offline")
				}
				return domain.ModelResult{Message: domain.ModelMessage{Text: "Decisions and unfinished work."}}, nil
			})
			r := NewNativeRuntime(NativeRuntimeConfig{SessionID: "s", Conversation: domain.Conversation{ID: "n", Messages: history}, Tools: &nativeTestTools{}, Repo: repo, Model: model})
			defer func() { _ = r.Close() }()
			if err := r.Send(context.Background(), "t", "/compact"); err != nil {
				t.Fatal(err)
			}
			events := nativeEnd(t, r)
			saved, _ := repo.LoadConversation(context.Background(), "n")
			if fail {
				if len(saved.Messages) != len(history) || saved.Messages[0].Text != history[0].Text || !events[len(events)-1].Result.IsError {
					t.Fatal("failed compaction changed history")
				}
				return
			}
			if len(saved.Messages) != 5 || !strings.Contains(saved.Messages[0].Text, "Decisions") || saved.Messages[2].ToolCalls[0].ID != "a" || saved.Messages[3].CallID != "a" {
				t.Fatalf("%+v", saved.Messages)
			}
		})
	}
}

func TestNativeCompactsWithinLongSingleTaskWithoutOrphanToolResults(t *testing.T) {
	history := []domain.ModelMessage{{Role: "user", Text: "large task"}}
	for i := 0; i < 8; i++ {
		id := fmt.Sprint(i)
		history = append(history, domain.ModelMessage{Role: "assistant", ToolCalls: []domain.ModelToolCall{{ID: id, Name: "read", Arguments: []byte(`{}`)}}}, domain.ModelMessage{Role: "tool", CallID: id, Text: strings.Repeat("data", 1000)})
	}
	model := nativeModelFunc(func(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error) {
		return domain.ModelResult{Message: domain.ModelMessage{Text: "task and findings"}}, nil
	})
	r := NewNativeRuntime(NativeRuntimeConfig{Conversation: domain.Conversation{ID: "n", Messages: history}, Model: model, Repo: &nativeMemory{}, Tools: &nativeTestTools{}})
	defer func() { _ = r.Close() }()
	if err := r.compact(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := r.cfg.Conversation.Messages
	if len(got) >= len(history) || got[0].Role != "user" || got[1].Role != "assistant" {
		t.Fatal("single long task was not compacted at a tool-group boundary")
	}
	for i := 1; i < len(got); i += 2 {
		if len(got[i].ToolCalls) != 1 || got[i+1].CallID != got[i].ToolCalls[0].ID {
			t.Fatal("orphaned tool result")
		}
	}
}
