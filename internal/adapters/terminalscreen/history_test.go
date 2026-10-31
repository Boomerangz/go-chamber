package terminalscreen

import "testing"

func TestHistoryPagesHaveStableIDsAndExcludeAlternateScreen(t *testing.T) {
	s := New(20, 2)
	defer s.Close()
	s.Feed([]byte("one\r\ntwo\r\nthree\r\n"))
	page := s.History(0, 1, "")
	if len(page.Lines) != 1 || page.Lines[0].Text != "two" || page.Lines[0].ID != 2 || page.NextBefore != 2 {
		t.Fatalf("page=%+v", page)
	}
	s.Feed([]byte("\x1b[?1049hTUI\r\nredraw\r\nagain\r\n\x1b[?1049l"))
	older := s.History(page.NextBefore, 20, "")
	if len(older.Lines) != 1 || older.Lines[0].Text != "one" {
		t.Fatalf("older=%+v", older)
	}
	if got := s.History(0, 20, "TUI"); len(got.Lines) != 0 {
		t.Fatalf("alternate screen leaked: %+v", got)
	}
}

func TestHistoryEvictsByBytesAndLineCount(t *testing.T) {
	h := historyLog{maxLines: 3, maxBytes: 8}
	for _, text := range []string{"aaa", "bbb", "ccc"} {
		h.push(text)
	}
	p := h.page(0, 20, "")
	if p.EvictedThrough != 1 || len(p.Lines) != 2 {
		t.Fatalf("byte bound: %+v", p)
	}
	for range 5 {
		h.push("")
	}
	p = h.page(0, 20, "")
	if len(p.Lines) != 3 || p.EvictedThrough != 5 {
		t.Fatalf("line bound: %+v", p)
	}
	if got := h.page(3, 20, ""); len(got.Lines) != 0 || got.EvictedThrough != 5 {
		t.Fatalf("evicted range: %+v", got)
	}
}
