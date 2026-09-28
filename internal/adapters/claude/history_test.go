package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

const historySession = "11111111-2222-3333-4444-555555555555"

func TestHistoryListsTranscripts(t *testing.T) {
	root := filepath.Join("testdata", "history")
	mtime := time.Date(2026, 9, 20, 10, 6, 0, 0, time.UTC)
	path := filepath.Join(root, "-tmp-proj", historySession+".jsonl")
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	got, err := NewHistory(root).Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]app.ExternalSession{}
	for _, s := range got {
		byID[s.NativeID] = s
	}
	if len(got) != 2 {
		t.Fatalf("sessions = %+v", got)
	}
	s := byID[historySession]
	if s.Agent != domain.AgentClaude || s.Cwd != "/tmp/proj" || s.Title != "Fix tests" || !s.UpdatedAt.Equal(mtime) {
		t.Fatalf("session = %+v", s)
	}
	other := byID["22222222-2222-3333-4444-555555555555"]
	if other.Cwd != "/tmp/other" || len([]rune(other.Title)) > 80 || other.Title == "" {
		t.Fatalf("fallback title = %+v", other)
	}
}

func TestHistoryMissingRootIsEmpty(t *testing.T) {
	got, err := NewHistory(filepath.Join(t.TempDir(), "none")).Sessions(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestHistoryTranscriptBecomesItems(t *testing.T) {
	items, err := NewHistory(filepath.Join("testdata", "history")).Transcript(context.Background(), historySession, "s1")
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		kind   domain.ItemKind
		status domain.ItemStatus
		text   string
	}{
		{domain.ItemUserMessage, domain.ItemCompleted, "fix the tests"},
		{domain.ItemReasoning, domain.ItemCompleted, "Look at the failing test first."},
		{domain.ItemAssistantMessage, domain.ItemCompleted, "Running the suite."},
		{domain.ItemCommand, domain.ItemCompleted, "ok  example 0.1s"},
		{domain.ItemAssistantMessage, domain.ItemCompleted, "All tests pass."},
		{domain.ItemUserMessage, domain.ItemCompleted, "now lint"},
		{domain.ItemCommand, domain.ItemFailed, ""},
	}
	if len(items) != len(want) {
		for _, it := range items {
			t.Logf("%s %s %q", it.Kind, it.Status, it.Text)
		}
		t.Fatalf("got %d items, want %d", len(items), len(want))
	}
	for i, w := range want {
		it := items[i]
		if it.Kind != w.kind || it.Status != w.status || it.Text != w.text || it.SessionID != "s1" {
			t.Errorf("item %d = %s %s %q (session %s), want %s %s %q", i, it.Kind, it.Status, it.Text, it.SessionID, w.kind, w.status, w.text)
		}
	}
	if items[0].TurnID == "" || items[0].TurnID != items[4].TurnID || items[5].TurnID == items[0].TurnID || items[6].TurnID != items[5].TurnID {
		t.Errorf("turns = %s %s %s %s", items[0].TurnID, items[4].TurnID, items[5].TurnID, items[6].TurnID)
	}
}

func TestHistoryTranscriptOfAnUnknownSession(t *testing.T) {
	_, err := NewHistory(filepath.Join("testdata", "history")).Transcript(context.Background(), "nope", "s1")
	if !errors.Is(err, app.ErrHistoryNotFound) {
		t.Fatalf("err = %v", err)
	}
	if _, err := NewHistory("testdata").Transcript(context.Background(), "../history/-tmp-proj/"+historySession, "s1"); !errors.Is(err, app.ErrHistoryNotFound) {
		t.Fatalf("path in id: %v", err)
	}
}

// Tool results make transcript lines far longer than the read buffer.
func TestHistoryReadsLinesLongerThanTheBuffer(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "-p")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("y", 3<<20)
	lines := `{"type":"user","uuid":"u1","cwd":"/p","message":{"role":"user","content":"` + long + `"}}` + "\n" +
		`{"type":"assistant","uuid":"a1","cwd":"/p","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"ok"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := NewHistory(root).Transcript(context.Background(), "s", "x")
	if err != nil || len(items) != 2 || len(items[0].Text) != len(long) || items[1].Text != "ok" {
		t.Fatalf("items = %d, err = %v", len(items), err)
	}
}
