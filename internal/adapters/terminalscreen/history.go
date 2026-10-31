package terminalscreen

import (
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
)

type historyLog struct {
	lines              []app.TerminalHistoryLine
	head, bytes        int
	next, evicted      uint64
	maxLines, maxBytes int
}

func (h *historyLog) push(text string) {
	h.next++
	h.lines = append(h.lines, app.TerminalHistoryLine{ID: h.next, Text: text})
	h.bytes += len(text)
	for len(h.lines)-h.head > h.maxLines || h.bytes > h.maxBytes {
		line := h.lines[h.head]
		h.bytes -= len(line.Text)
		h.evicted = line.ID
		h.lines[h.head] = app.TerminalHistoryLine{}
		h.head++
	}
	if h.head > 1024 {
		h.lines = append([]app.TerminalHistoryLine(nil), h.lines[h.head:]...)
		h.head = 0
	}
}
func (h *historyLog) page(before uint64, limit int, query string) app.TerminalHistoryPage {
	if limit <= 0 || limit > 200 {
		limit = 200
	}
	p := app.TerminalHistoryPage{Lines: []app.TerminalHistoryLine{}, EvictedThrough: h.evicted}
	query = strings.ToLower(query)
	for i := len(h.lines) - 1; i >= h.head; i-- {
		line := h.lines[i]
		if before > 0 && line.ID >= before || !strings.Contains(strings.ToLower(line.Text), query) {
			continue
		}
		if len(p.Lines) == limit {
			p.NextBefore = p.Lines[len(p.Lines)-1].ID
			break
		}
		p.Lines = append(p.Lines, line)
	}
	for i, j := 0, len(p.Lines)-1; i < j; i, j = i+1, j-1 {
		p.Lines[i], p.Lines[j] = p.Lines[j], p.Lines[i]
	}
	return p
}

func (s *Screen) collectHistory() {
	sb := s.em.Scrollback()
	if sb == nil || sb.Len() == 0 {
		return
	}
	for _, line := range sb.Lines() {
		var text strings.Builder
		for _, cell := range line {
			if cell.Width > 0 {
				text.WriteString(cell.Content)
			}
		}
		s.history.push(strings.TrimRight(text.String(), " "))
	}
	sb.Clear()
}
func (s *Screen) History(before uint64, limit int, query string) app.TerminalHistoryPage {
	return s.history.page(before, limit, query)
}
