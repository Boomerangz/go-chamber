// Package sqlite implements persistence ports on SQLite (pure Go driver).
package sqlite

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"time"

	_ "modernc.org/sqlite"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct{ db *sql.DB }

// Open opens (creating if needed) the database at path and applies pending
// migrations. Schema version is tracked in PRAGMA user_version.
func Open(path string) (*Store, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db, migrations); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate %s: %w", path, err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Sessions() app.SessionRepo { return sessionRepo{s.db} }

func (s *Store) Quotas() app.QuotaRepo { return quotaRepo{s.db} }

// migrate applies migrations/*.sql from fsys that are newer than the schema
// version. Each file runs in its own transaction together with the version bump.
func migrate(db *sql.DB, fsys fs.FS) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	names, _ := fs.Glob(fsys, "migrations/*.sql")
	sort.Strings(names)
	for i := version; i < len(names); i++ {
		if err := applyMigration(db, fsys, names[i], i+1); err != nil {
			return fmt.Errorf("%s: %w", names[i], err)
		}
	}
	return nil
}

func applyMigration(db *sql.DB, fsys fs.FS, name string, version int) error {
	body, err := fs.ReadFile(fsys, name)
	if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if _, err := tx.Exec(string(body)); err != nil {
		return err
	}
	if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", version)); err != nil {
		return err
	}
	return tx.Commit()
}

type sessionRepo struct{ db *sql.DB }

const sessionCols = "id, agent, cwd, native_id, parent_id, status, title, interruption_reason, resume_after, approval_reviewer"

func (r sessionRepo) Save(ctx context.Context, s domain.SessionSnapshot) error {
	resume := ""
	if !s.Interruption.ResumeAfter.IsZero() {
		resume = s.Interruption.ResumeAfter.UTC().Format(time.RFC3339Nano)
	}
	_, err := r.db.ExecContext(ctx, `INSERT INTO sessions (`+sessionCols+`) VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, cwd=excluded.cwd, native_id=excluded.native_id,
		parent_id=excluded.parent_id, status=excluded.status, title=excluded.title,
		interruption_reason=excluded.interruption_reason, resume_after=excluded.resume_after,
		approval_reviewer=excluded.approval_reviewer`,
		s.ID, s.Agent, s.Cwd, s.NativeID, s.ParentID, s.Status, s.Title, s.Interruption.Reason, resume, s.ApprovalReviewer)
	return err
}

func (r sessionRepo) Get(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	s, err := scanSession(r.db.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM sessions WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, fmt.Errorf("%w: %s", app.ErrSessionNotFound, id)
	}
	return s, err
}

func (r sessionRepo) List(ctx context.Context) ([]domain.SessionSnapshot, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+sessionCols+` FROM sessions ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SessionSnapshot{}
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

type scanner interface{ Scan(dest ...any) error }

func scanSession(row scanner) (domain.SessionSnapshot, error) {
	var s domain.SessionSnapshot
	var resume string
	err := row.Scan(&s.ID, &s.Agent, &s.Cwd, &s.NativeID, &s.ParentID, &s.Status, &s.Title, &s.Interruption.Reason, &resume, &s.ApprovalReviewer)
	if err != nil {
		return domain.SessionSnapshot{}, err
	}
	if resume != "" {
		if s.Interruption.ResumeAfter, err = time.Parse(time.RFC3339Nano, resume); err != nil {
			return domain.SessionSnapshot{}, fmt.Errorf("session %s: bad resume_after: %w", s.ID, err)
		}
	}
	return s, nil
}

type quotaRepo struct{ db *sql.DB }

func (r quotaRepo) SaveQuota(ctx context.Context, q domain.QuotaSnapshot) error {
	if q.UpdatedAt.IsZero() {
		q.UpdatedAt = time.Now().UTC()
	}
	blob, err := json.Marshal(q)
	if err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO quotas (agent, snapshot, updated_at) VALUES (?,?,?)
		ON CONFLICT(agent) DO UPDATE SET snapshot=excluded.snapshot, updated_at=excluded.updated_at`,
		q.Agent, string(blob), q.UpdatedAt.UTC().Format(time.RFC3339Nano))
	return err
}

func (r quotaRepo) GetQuota(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, bool, error) {
	var blob string
	err := r.db.QueryRowContext(ctx, `SELECT snapshot FROM quotas WHERE agent = ?`, agent).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.QuotaSnapshot{}, false, nil
	}
	if err != nil {
		return domain.QuotaSnapshot{}, false, err
	}
	q, err := decodeQuota(blob)
	return q, err == nil, err
}

func (r quotaRepo) ListQuotas(ctx context.Context) ([]domain.QuotaSnapshot, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT snapshot FROM quotas ORDER BY agent`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.QuotaSnapshot{}
	for rows.Next() {
		var blob string
		if err := rows.Scan(&blob); err != nil {
			return nil, err
		}
		q, err := decodeQuota(blob)
		if err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

func decodeQuota(blob string) (domain.QuotaSnapshot, error) {
	var q domain.QuotaSnapshot
	if err := json.Unmarshal([]byte(blob), &q); err != nil {
		return domain.QuotaSnapshot{}, fmt.Errorf("quota snapshot: %w", err)
	}
	return q, nil
}
