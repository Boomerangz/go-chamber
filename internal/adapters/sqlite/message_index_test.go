package sqlite

import (
	"context"
	"database/sql"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestMessageReplacementUsesRowIDLookup(t *testing.T) {
	s := openTest(t)
	rows, err := s.db.Query("EXPLAIN QUERY PLAN "+messageDeleteSQL, "s", "i")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	bounded := false
	for rows.Next() {
		var id, parent, unused int
		var plan string
		if err := rows.Scan(&id, &parent, &unused, &plan); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(plan, "messages_fts") && strings.Contains(plan, "INDEX 0:=") {
			bounded = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !bounded {
		t.Fatal("message replacement scans the global search archive instead of looking up a rowid")
	}
}

func TestMessageLookupMigrationBackfillsLegacyArchive(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	old := fstest.MapFS{}
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if name > "migrations/0009_session_worktree.sql" {
			continue
		}
		body, err := fs.ReadFile(migrations, name)
		if err != nil {
			t.Fatal(err)
		}
		old[name] = &fstest.MapFile{Data: body}
	}
	if err := migrate(db, old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO messages_fts(rowid,text,session_id,item_id) VALUES(99,'legacytext','s','i')`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db, migrations); err != nil {
		t.Fatal(err)
	}
	var rowid int
	if err := db.QueryRow(`SELECT id FROM message_keys WHERE session_id='s' AND item_id='i'`).Scan(&rowid); err != nil {
		t.Fatal(err)
	}
	if rowid != 99 {
		t.Fatalf("backfilled rowid = %d, want 99", rowid)
	}
	log := eventLog{db}
	ctx := context.Background()
	hits, err := log.Search(ctx, "legacytext", 10)
	if err != nil || len(hits) != 1 {
		t.Fatalf("legacy search: hits=%v err=%v", hits, err)
	}
	ev := domain.Event{SessionID: "s", Seq: 1, Type: domain.EventItemUpdated, Item: &domain.Item{ID: "i", Kind: domain.ItemAssistantMessage, Status: domain.ItemCompleted, Text: "replacementtext"}}
	if err := log.Append(ctx, ev); err != nil {
		t.Fatal(err)
	}
	hits, err = log.Search(ctx, "legacytext", 10)
	if err != nil || len(hits) != 0 {
		t.Fatalf("obsolete search: hits=%v err=%v", hits, err)
	}
	hits, err = log.Search(ctx, "replacementtext", 10)
	if err != nil || len(hits) != 1 {
		t.Fatalf("replacement search: hits=%v err=%v", hits, err)
	}
	if err := migrate(db, migrations); err != nil {
		t.Fatal(err)
	}
}
