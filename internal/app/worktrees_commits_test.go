package app

import (
	"context"
	"errors"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestChangesCountAWorktreeBranchsCommits(t *testing.T) {
	w, m, git, _ := newTestWorktrees(t)
	ctx := context.Background()
	wt, _ := w.Create(ctx, domain.AgentClaude, "/src/app", "x")
	git.commits = 3
	ch, err := w.Changes(ctx, wt.ID)
	if err != nil || ch.Commits != 3 || git.gotCommits != wt.Cwd+"|base1" {
		t.Fatalf("changes = %+v, %v; asked %q", ch, err, git.gotCommits)
	}
	// A plain folder is compared with HEAD: it has no branch of its own.
	plain, _ := m.CreateSession(ctx, domain.AgentClaude, "/src/app")
	git.gotCommits = ""
	if ch, _ := w.Changes(ctx, plain.ID); ch.Commits != 0 || git.gotCommits != "" {
		t.Fatalf("plain = %+v, asked %q", ch, git.gotCommits)
	}
	git.commitsErr = errors.New("boom")
	if _, err := w.Changes(ctx, wt.ID); err == nil {
		t.Fatal("a failed count is reported")
	}
}
