package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// History reads the transcripts Claude Code keeps under
// ~/.claude/projects/<project>/<session-id>.jsonl.
type History struct {
	root string

	mu    sync.Mutex
	cache map[string]cachedSummary // by path
}

type cachedSummary struct {
	size    int64
	modTime time.Time
	summary app.ExternalSession
	ok      bool
}

// NewHistory reads transcripts under root (normally ~/.claude/projects).
func NewHistory(root string) *History {
	return &History{root: root, cache: map[string]cachedSummary{}}
}

// Sessions lists recorded conversations. Transcripts are summarized once per
// size and modification time, so listing again is cheap.
func (h *History) Sessions(ctx context.Context) ([]app.ExternalSession, error) {
	paths, err := filepath.Glob(filepath.Join(h.root, "*", "*.jsonl"))
	if err != nil {
		return nil, err
	}
	out := []app.ExternalSession{}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if strings.HasPrefix(filepath.Base(path), "agent-") {
			continue // a subagent's sidechain, not a conversation of its own
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		if s, ok := h.summary(path, info); ok {
			out = append(out, s)
		}
	}
	return out, nil
}

func (h *History) summary(path string, info os.FileInfo) (app.ExternalSession, bool) {
	h.mu.Lock()
	c, hit := h.cache[path]
	h.mu.Unlock()
	if hit && c.size == info.Size() && c.modTime.Equal(info.ModTime()) {
		return c.summary, c.ok
	}
	s, ok := summarize(path)
	s.UpdatedAt = info.ModTime().UTC()
	h.mu.Lock()
	h.cache[path] = cachedSummary{size: info.Size(), modTime: info.ModTime(), summary: s, ok: ok}
	h.mu.Unlock()
	return s, ok
}

// transcriptRecord is the subset of a transcript line History reads.
type transcriptRecord struct {
	Type        string          `json:"type"`
	Cwd         string          `json:"cwd"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	UUID        string          `json:"uuid"`
	CustomTitle string          `json:"customTitle"`
	Summary     string          `json:"summary"`
	Message     json.RawMessage `json:"message"`
}

const titleRunes = 80

// summarize reads cwd and title; a transcript without a prompt is not a
// conversation worth listing.
func summarize(path string) (app.ExternalSession, bool) {
	s := app.ExternalSession{Agent: domain.AgentClaude, NativeID: strings.TrimSuffix(filepath.Base(path), ".jsonl")}
	var custom, summary, prompt string
	_ = eachLine(path, func(line []byte) {
		// Decoding every line is what makes listing slow: tool results are
		// huge. Only titles and, until found, the first prompt matter.
		wanted := bytes.Contains(line, []byte(`"type":"custom-title"`)) || bytes.Contains(line, []byte(`"type":"summary"`)) ||
			(prompt == "" || s.Cwd == "") && bytes.Contains(line, []byte(`"type":"user"`))
		if !wanted {
			return
		}
		var r transcriptRecord
		if json.Unmarshal(line, &r) != nil {
			return
		}
		if s.Cwd == "" && r.Cwd != "" {
			s.Cwd = r.Cwd
		}
		switch r.Type {
		case "custom-title":
			custom = r.CustomTitle
		case "summary":
			summary = r.Summary
		case "user":
			if prompt == "" && !r.IsMeta && !r.IsSidechain {
				prompt = promptText(r.Message)
			}
		}
	})
	s.Title = firstNonEmpty(custom, summary, prompt)
	if r := []rune(s.Title); len(r) > titleRunes {
		s.Title = strings.TrimSpace(string(r[:titleRunes-1])) + "…"
	}
	return s, prompt != "" && s.Cwd != ""
}

// Transcript maps the conversation to items: prompts become user messages
// opening a turn, assistant and tool-result lines go through the stream
// mapper. Items cut off by the end of the transcript are failed.
func (h *History) Transcript(ctx context.Context, nativeID string, session domain.SessionID) ([]domain.Item, error) {
	if nativeID == "" || strings.ContainsAny(nativeID, `/\`) || strings.Contains(nativeID, "..") {
		return nil, fmt.Errorf("%w: claude %q", app.ErrHistoryNotFound, nativeID)
	}
	paths, err := filepath.Glob(filepath.Join(h.root, "*", nativeID+".jsonl"))
	if err != nil || len(paths) == 0 {
		return nil, fmt.Errorf("%w: claude %s", app.ErrHistoryNotFound, nativeID)
	}
	mapper := NewMapper(session)
	var (
		order []domain.ItemID
		items = map[domain.ItemID]domain.Item{}
		turns int
	)
	keep := func(it domain.Item) {
		// Keep imported items in a separate namespace from live runtime output.
		it.ID = "h-" + it.ID
		if it.ParentItemID != "" {
			it.ParentItemID = "h-" + it.ParentItemID
		}
		if _, ok := items[it.ID]; !ok {
			order = append(order, it.ID)
		}
		items[it.ID] = it
	}
	err = eachRecord(paths[0], func(r transcriptRecord, line []byte) {
		if r.IsSidechain || r.IsMeta {
			return
		}
		switch r.Type {
		case "user":
			if text := promptText(r.Message); text != "" {
				turns++
				turn := domain.TurnID(fmt.Sprintf("h-turn-%d", turns))
				mapper.SetTurn(turn)
				it, _ := domain.NewItem(domain.ItemID("user-"+r.UUID), session, turn, "", domain.ItemUserMessage)
				it.Text = text
				_ = it.SetStatus(domain.ItemCompleted)
				keep(*it)
				return
			}
		case "assistant":
		default:
			return
		}
		events, _ := mapper.Map(line)
		for _, ev := range events {
			if ev.Type == domain.EventItemUpdated && ev.Item != nil {
				keep(*ev.Item)
			}
		}
	})
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out := make([]domain.Item, 0, len(order))
	for _, id := range order {
		it := items[id]
		if !it.Status.Terminal() {
			_ = it.SetStatus(domain.ItemFailed)
		}
		out = append(out, it)
	}
	return out, nil
}

// eachRecord calls fn for every well-formed line of a transcript.
func eachRecord(path string, fn func(transcriptRecord, []byte)) error {
	return eachLine(path, func(line []byte) {
		line = bytes.Clone(line) // the reader reuses its buffer; mapped items keep raw input
		var rec transcriptRecord
		if json.Unmarshal(line, &rec) == nil {
			fn(rec, line)
		}
	})
}

// eachLine calls fn for every non-empty line of a file.
func eachLine(path string, fn func([]byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			// A line longer than the buffer: collect it whole.
			long := append([]byte(nil), line...)
			for errors.Is(err, bufio.ErrBufferFull) {
				line, err = r.ReadSlice('\n')
				long = append(long, line...)
			}
			line = long
		}
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			fn(trimmed)
		}
		if err != nil {
			return nil
		}
	}
}

// promptText is the user's own text in a user line; tool results and
// attachments have none.
func promptText(raw json.RawMessage) string {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return ""
	}
	var s string
	if json.Unmarshal(msg.Content, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []rawBlock
	if json.Unmarshal(msg.Content, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "tool_result" {
			return ""
		}
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, strings.TrimSpace(b.Text))
		}
	}
	return strings.Join(parts, "\n")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}
