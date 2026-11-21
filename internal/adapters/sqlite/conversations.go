package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type conversationRepo struct{ db *sql.DB }

func (s *Store) Conversations() app.ConversationRepo { return conversationRepo{s.db} }
func (r conversationRepo) LoadConversation(ctx context.Context, id string) (domain.Conversation, error) {
	var body []byte
	err := r.db.QueryRowContext(ctx, `SELECT body FROM native_conversations WHERE id=?`, id).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Conversation{}, app.ErrConversationNotFound
	}
	if err != nil {
		return domain.Conversation{}, err
	}
	var conv domain.Conversation
	if err = json.Unmarshal(body, &conv); err != nil {
		return conv, err
	}
	return conv, nil
}
func (r conversationRepo) SaveConversation(ctx context.Context, conv domain.Conversation) error {
	if conv.ID == "" {
		return errors.New("conversation ID required")
	}
	body, err := json.Marshal(conv)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO native_conversations(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`, conv.ID, body)
	return err
}
