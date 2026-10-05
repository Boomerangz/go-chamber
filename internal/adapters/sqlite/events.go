package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type eventLog struct{ db *sql.DB }

const messageDeleteSQL = `DELETE FROM messages_fts WHERE rowid =
	(SELECT id FROM message_keys WHERE session_id = ? AND item_id = ?)`

// Events returns the persistent event log with full-text message search.
func (s *Store) Events() interface {
	app.EventLog
	app.MessageSearch
} {
	return eventLog{s.db}
}

func (l eventLog) Append(ctx context.Context, ev domain.Event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	var itemID domain.ItemID
	var text string
	if ev.Type == domain.EventTextDelta && ev.Delta != nil {
		itemID, text = ev.Delta.ItemID, ev.Delta.Text
	}
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO events (session_id, seq, type, item_id, text, body) VALUES (?,?,?,?,?,?)`,
		ev.SessionID, ev.Seq, ev.Type, itemID, text, string(body)); err != nil {
		return err
	}
	if searchable(ev) {
		if err := index(ctx, tx, ev.SessionID, ev.Item); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// searchable reports whether ev completes a user or assistant message.
func searchable(ev domain.Event) bool {
	if ev.Type != domain.EventItemUpdated || ev.Item == nil || ev.Item.Status != domain.ItemCompleted {
		return false
	}
	return ev.Item.Kind == domain.ItemUserMessage || ev.Item.Kind == domain.ItemAssistantMessage
}

func index(ctx context.Context, tx *sql.Tx, session domain.SessionID, item *domain.Item) error {
	text := item.Text
	if text == "" {
		rows, err := tx.QueryContext(ctx,
			`SELECT text FROM events WHERE session_id = ? AND item_id = ? ORDER BY seq`, session, item.ID)
		if err != nil {
			return err
		}
		var b strings.Builder
		for rows.Next() {
			var part string
			if err := rows.Scan(&part); err != nil {
				_ = rows.Close()
				return err
			}
			b.WriteString(part)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		text = b.String()
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO message_keys (session_id, item_id) VALUES (?,?)
		 ON CONFLICT(session_id, item_id) DO NOTHING`, session, item.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, messageDeleteSQL, session, item.ID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx,
		`INSERT INTO messages_fts (rowid, text, session_id, item_id)
		 VALUES ((SELECT id FROM message_keys WHERE session_id = ? AND item_id = ?),?,?,?)`,
		session, item.ID, text, session, item.ID)
	return err
}

func (l eventLog) History(ctx context.Context, session domain.SessionID, since domain.Seq) ([]domain.Event, error) {
	rows, err := l.db.QueryContext(ctx,
		`SELECT body FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`, session, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Event{}
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		var ev domain.Event
		if err := json.Unmarshal([]byte(body), &ev); err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	return out, rows.Err()
}

func (l eventLog) LastSeq(ctx context.Context, session domain.SessionID) (domain.Seq, error) {
	var seq domain.Seq
	err := l.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) FROM events WHERE session_id = ?`, session).Scan(&seq)
	return seq, err
}

// Search returns sessions whose messages contain every query word (as a
// prefix), best match first.
func (l eventLog) Search(ctx context.Context, query string, limit int) ([]app.SearchHit, error) {
	match := ftsQuery(query)
	if match == "" {
		return []app.SearchHit{}, nil
	}
	rows, err := l.db.QueryContext(ctx, `
		SELECT session_id, item_id, snippet(messages_fts, 0, '[[', ']]', '…', 14)
		FROM messages_fts WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 1000`, match)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bySession := map[domain.SessionID]*app.SearchHit{}
	var order []domain.SessionID
	for rows.Next() {
		var h app.SearchHit
		if err := rows.Scan(&h.SessionID, &h.ItemID, &h.Snippet); err != nil {
			return nil, err
		}
		if best, ok := bySession[h.SessionID]; ok {
			best.Matches++
			continue
		}
		h.Matches = 1
		bySession[h.SessionID] = &h
		order = append(order, h.SessionID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]app.SearchHit, 0, len(order))
	for _, id := range order {
		out = append(out, *bySession[id])
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ftsQuery turns free text into an FTS5 query: every word must occur, as a
// prefix. Quotes are dropped so user input can't break the syntax.
func ftsQuery(query string) string {
	var terms []string
	for _, w := range strings.Fields(strings.ReplaceAll(query, `"`, " ")) {
		terms = append(terms, `"`+w+`"*`)
	}
	return strings.Join(terms, " ")
}
