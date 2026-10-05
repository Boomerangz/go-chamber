package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/app/apptest"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "gc.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestSessionRepoContract(t *testing.T) {
	apptest.SessionRepoContract(t, func(t *testing.T) app.SessionRepo { return openTest(t).Sessions() })
}

func TestReopenKeepsDataAndMigrationsAreIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gc.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	snap := domain.SessionSnapshot{ID: "x", Agent: domain.AgentCodex, Cwd: "/p", Status: domain.StatusDetached}
	if err := s.Sessions().Save(ctx, snap); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if _, err := s2.Sessions().Get(ctx, "x"); err != nil {
		t.Fatalf("get after reopen: %v", err)
	}
}

func TestOpenFailsOnBadPath(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "missing-dir", "gc.db")); err == nil {
		t.Fatal("want error for missing directory")
	}
}

func TestOperationsFailAfterClose(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "gc.db"))
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	ctx := context.Background()
	repo := s.Sessions()
	if err := repo.Save(ctx, domain.SessionSnapshot{ID: "x", Agent: domain.AgentClaude, Cwd: "/"}); err == nil {
		t.Fatal("save after close: want error")
	}
	if _, err := repo.Get(ctx, "x"); err == nil {
		t.Fatal("get after close: want error")
	}
	if _, err := repo.List(ctx); err == nil {
		t.Fatal("list after close: want error")
	}
}

func TestMigrateAppliesOnlyPendingInOrder(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	two := fstest.MapFS{
		"migrations/0002_b.sql": {Data: []byte("CREATE TABLE b (x TEXT);")},
		"migrations/0001_a.sql": {Data: []byte("CREATE TABLE a (x TEXT);")},
	}
	if err := migrate(db, two); err != nil {
		t.Fatalf("first run: %v", err)
	}
	assertVersion(t, db, 2)
	three := fstest.MapFS{"migrations/0003_c.sql": {Data: []byte("CREATE TABLE c (x TEXT);")}}
	for k, v := range two {
		three[k] = v
	}
	// Re-running 0001/0002 would fail with "table already exists".
	if err := migrate(db, three); err != nil {
		t.Fatalf("second run: %v", err)
	}
	assertVersion(t, db, 3)
}

func TestMigrateStopsOnBrokenMigration(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	fsys := fstest.MapFS{
		"migrations/0001_a.sql": {Data: []byte("CREATE TABLE a (x TEXT);")},
		"migrations/0002_b.sql": {Data: []byte("NOT SQL")},
	}
	if err := migrate(db, fsys); err == nil {
		t.Fatal("want error")
	}
	assertVersion(t, db, 1)
}

func assertVersion(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	var v int
	if err := db.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != want {
		t.Fatalf("user_version = %d (err %v), want %d", v, err, want)
	}
}

func TestQuotaRepoRoundTrip(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "q.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()
	repo := store.Quotas()
	if _, ok, err := repo.GetQuota(ctx, domain.AgentCodex); ok || err != nil {
		t.Fatalf("empty get = %v, %v", ok, err)
	}
	q := domain.QuotaSnapshot{Agent: domain.AgentCodex, Plan: "plus", Windows: []domain.QuotaWindow{{Name: "primary", UsedPct: 33}}}
	if err := repo.SaveQuota(ctx, q); err != nil {
		t.Fatal(err)
	}
	got, ok, err := repo.GetQuota(ctx, domain.AgentCodex)
	if err != nil || !ok || got.Plan != "plus" || got.Windows[0].UsedPct != 33 {
		t.Fatalf("got = %+v, %v, %v", got, ok, err)
	}
	// Upsert overwrites.
	q.Plan = "pro"
	if err := repo.SaveQuota(ctx, q); err != nil {
		t.Fatal(err)
	}
	got, _, _ = repo.GetQuota(ctx, domain.AgentCodex)
	if got.Plan != "pro" {
		t.Fatalf("plan = %q", got.Plan)
	}
	list, err := repo.ListQuotas(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %+v, %v", list, err)
	}
}

func TestEventLogContract(t *testing.T) {
	apptest.EventLogContract(t, func(t *testing.T) interface {
		app.EventLog
		app.MessageSearch
	} {
		return openTest(t).Events()
	})
}

// With WAL, synchronous=NORMAL skips an fsync per commit; every streamed
// fragment is its own commit, so FULL made streaming disk-bound.
func TestOpenUsesNormalSynchronous(t *testing.T) {
	s := openTest(t)
	var mode int
	if err := s.db.QueryRow("PRAGMA synchronous").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != 1 {
		t.Fatalf("synchronous = %d, want 1 (NORMAL)", mode)
	}
}
