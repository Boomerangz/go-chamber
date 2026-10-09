package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
)

func (s *Store) OAuthTokens() app.OAuthTokens { return oauthTokens{s.db} }

type oauthTokens struct{ db *sql.DB }

func (r oauthTokens) PutToken(ctx context.Context, key string, g app.OAuthGrant) error {
	_, err := r.db.ExecContext(ctx, `INSERT OR REPLACE INTO oauth_tokens (key, client, resource, expires) VALUES (?,?,?,?)`,
		key, g.Client, g.Resource, g.Expires.UnixNano())
	return err
}

func (r oauthTokens) Token(ctx context.Context, key string) (app.OAuthGrant, bool, error) {
	return scanGrant(r.db.QueryRowContext(ctx, `SELECT client, resource, expires FROM oauth_tokens WHERE key = ?`, key))
}

func (r oauthTokens) TakeToken(ctx context.Context, key string) (app.OAuthGrant, bool, error) {
	return scanGrant(r.db.QueryRowContext(ctx, `DELETE FROM oauth_tokens WHERE key = ? RETURNING client, resource, expires`, key))
}

func (r oauthTokens) DeleteTokensExpiredBy(ctx context.Context, t time.Time) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM oauth_tokens WHERE expires <= ?`, t.UnixNano())
	return err
}

func scanGrant(row *sql.Row) (app.OAuthGrant, bool, error) {
	var g app.OAuthGrant
	var expires int64
	err := row.Scan(&g.Client, &g.Resource, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return app.OAuthGrant{}, false, nil
	}
	if err != nil {
		return app.OAuthGrant{}, false, err
	}
	g.Expires = time.Unix(0, expires)
	return g, true, nil
}
