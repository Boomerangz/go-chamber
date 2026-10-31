package app

import "github.com/igorzygin/go-chamber/internal/domain"

type TerminalHistoryLine struct {
	ID   uint64 `json:"id"`
	Text string `json:"text"`
}
type TerminalHistoryPage struct {
	Lines          []TerminalHistoryLine `json:"lines"`
	NextBefore     uint64                `json:"nextBefore"`
	EvictedThrough uint64                `json:"evictedThrough"`
}
type TerminalHistory interface {
	History(before uint64, limit int, query string) TerminalHistoryPage
}

func (t *Terminals) History(id domain.TerminalID, before uint64, limit int, query string) (TerminalHistoryPage, error) {
	rt, err := t.find(id)
	if err != nil {
		return TerminalHistoryPage{}, err
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if source, ok := rt.screen.(TerminalHistory); ok {
		return source.History(before, limit, query), nil
	}
	return TerminalHistoryPage{Lines: []TerminalHistoryLine{}}, nil
}
