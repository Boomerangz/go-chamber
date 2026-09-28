package codex

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestCodexHistoryListsThreads(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	got, err := f.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// The fake pages its list and hides a subagent thread among them.
	if len(got) != 2 {
		t.Fatalf("sessions = %+v", got)
	}
	s := got[0]
	if s.Agent != domain.AgentCodex || s.NativeID != "thread-history" || s.Cwd != "/work" || s.Title != "Tidy the README" ||
		!s.UpdatedAt.Equal(time.Unix(1790000000, 0).UTC()) {
		t.Fatalf("first = %+v", s)
	}
	if got[1].Title != "second page preview" {
		t.Fatalf("title falls back to the preview: %+v", got[1])
	}
}

func TestCodexHistoryReadsATranscript(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	items, err := f.Transcript(context.Background(), "thread-history", "s1")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 4 {
		t.Fatalf("items = %+v", items)
	}
	if items[0].Kind != domain.ItemUserMessage || items[0].Text != "tidy the readme" || items[0].TurnID != "turn-h1" || items[0].SessionID != "s1" {
		t.Fatalf("user = %+v", items[0])
	}
	if items[1].Kind != domain.ItemReasoning || items[1].Text != "Look at the headings." {
		t.Fatalf("reasoning = %+v", items[1])
	}
	if items[2].Kind != domain.ItemAssistantMessage || items[2].Text != "Done." || items[2].Status != domain.ItemCompleted {
		t.Fatalf("assistant = %+v", items[2])
	}
	if items[3].Text != "Pushed." || items[3].TurnID != "turn-h2" {
		t.Fatalf("later turn = %+v", items[3])
	}
	if _, err := f.Transcript(context.Background(), "missing", "s1"); err == nil {
		t.Fatal("expected an error for an unknown thread")
	}
}

// The schema's PatchChangeKind is an object ({"type":"update"}); reading it
// as a string dropped every fileChange item.
func TestMapFileChangeWithObjectKind(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"fileChange","id":"f1","status":"completed","changes":[{"path":"/work/a.go","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-a\n+b\n"}]}}`)
	item := lastItem(t, events, domain.ItemFileChange)
	if item.Path != "/work/a.go" || item.Status != domain.ItemCompleted {
		t.Fatalf("item = %+v", item)
	}
}

// Reasoning summary and content are arrays of strings in the schema, unlike
// a user message's content parts.
func TestMapReasoningWithStringParts(t *testing.T) {
	m := NewMapper("s1")
	m.SetTurn("t1")
	events := feedCodex(t, m, "item/completed", `{"threadId":"th","turnId":"t1","item":{"type":"reasoning","id":"r1","summary":["Plan: ","read the file"],"content":[]}}`)
	item := lastItem(t, events, domain.ItemReasoning)
	if item.Text != "Plan: read the file" {
		t.Fatalf("item = %+v", item)
	}
}

// thread/read and thread/resume return whole histories; a response over the
// old 32 MiB line limit killed the connection and every thread on it.
func TestClientReadsAHugeResponse(t *testing.T) {
	if testing.Short() {
		t.Skip("decodes a 33 MiB line")
	}
	client, peer := newPair(t, nil)
	done := make(chan error, 1)
	var got json.RawMessage
	go func() {
		var err error
		got, err = client.Call(context.Background(), "thread/read", map[string]any{"threadId": "big"})
		done <- err
	}()
	req := peer.read()
	big := `"` + strings.Repeat("x", 33<<20) + `"`
	go func() {
		_, _ = peer.w.WriteString(`{"jsonrpc":"2.0","id":` + string(req.ID) + `,"result":` + big + "}\n")
	}()
	if err := <-done; err != nil || len(got) != len(big) {
		t.Fatalf("call: %d bytes, %v", len(got), err)
	}
}
