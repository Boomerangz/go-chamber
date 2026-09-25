// Package apptest holds contract tests every port implementation must pass.
package apptest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// SessionRepoContract verifies an app.SessionRepo implementation. newRepo
// must return an empty repository.
func SessionRepoContract(t *testing.T, newRepo func(t *testing.T) app.SessionRepo) {
	ctx := context.Background()
	reset := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	full := domain.SessionSnapshot{
		ID: "a", Agent: domain.AgentClaude, Cwd: "/p", NativeID: "n1", ParentID: "parent",
		Status: domain.StatusInterrupted, Title: "title",
		Interruption:     domain.Interruption{Reason: domain.ExitQuota, ResumeAfter: reset},
		ApprovalReviewer: domain.ReviewerAuto,
	}

	t.Run("get missing", func(t *testing.T) {
		if _, err := newRepo(t).Get(ctx, "nope"); !errors.Is(err, app.ErrSessionNotFound) {
			t.Fatalf("want ErrSessionNotFound, got %v", err)
		}
	})

	t.Run("save and get round-trips all fields", func(t *testing.T) {
		r := newRepo(t)
		if err := r.Save(ctx, full); err != nil {
			t.Fatal(err)
		}
		got, err := r.Get(ctx, "a")
		if err != nil {
			t.Fatal(err)
		}
		if !equal(got, full) {
			t.Fatalf("got %+v, want %+v", got, full)
		}
	})

	t.Run("save overwrites", func(t *testing.T) {
		r := newRepo(t)
		if err := r.Save(ctx, full); err != nil {
			t.Fatal(err)
		}
		upd := full
		upd.Status, upd.Title, upd.Interruption = domain.StatusIdle, "new", domain.Interruption{}
		if err := r.Save(ctx, upd); err != nil {
			t.Fatal(err)
		}
		got, err := r.Get(ctx, "a")
		if err != nil {
			t.Fatal(err)
		}
		if !equal(got, upd) {
			t.Fatalf("got %+v, want %+v", got, upd)
		}
	})

	t.Run("list returns all in insertion order", func(t *testing.T) {
		r := newRepo(t)
		if got, err := r.List(ctx); err != nil || len(got) != 0 {
			t.Fatalf("empty list: %v, %v", got, err)
		}
		b := full
		b.ID, b.Agent = "b", domain.AgentCodex
		for _, s := range []domain.SessionSnapshot{full, b} {
			if err := r.Save(ctx, s); err != nil {
				t.Fatal(err)
			}
		}
		got, err := r.List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[0].ID != "a" || got[1].ID != "b" || got[1].Agent != domain.AgentCodex {
			t.Fatalf("list = %+v", got)
		}
	})
}

func equal(a, b domain.SessionSnapshot) bool {
	ai, bi := a.Interruption, b.Interruption
	a.Interruption, b.Interruption = domain.Interruption{}, domain.Interruption{}
	return a == b && ai.Reason == bi.Reason && ai.ResumeAfter.Equal(bi.ResumeAfter)
}
