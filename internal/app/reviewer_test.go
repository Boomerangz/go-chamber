package app

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// reviewerRuntime is a runtime that can switch the approval reviewer live.
type reviewerRuntime struct {
	*fakeRuntime
	mu  sync.Mutex
	set []domain.ApprovalReviewer
	err error
}

func (r *reviewerRuntime) SetApprovalReviewer(_ context.Context, rev domain.ApprovalReviewer) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.set = append(r.set, rev)
	return r.err
}

func TestSetApprovalReviewerIsSavedPublishedAndUsedOnStart(t *testing.T) {
	m, repo, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()

	got, err := m.SetApprovalReviewer(ctx, snap.ID, domain.ReviewerAuto)
	if err != nil {
		t.Fatalf("SetApprovalReviewer: %v", err)
	}
	if got.ApprovalReviewer != domain.ReviewerAuto {
		t.Fatalf("returned snapshot = %+v", got)
	}
	if stored, _ := repo.Get(ctx, snap.ID); stored.ApprovalReviewer != domain.ReviewerAuto {
		t.Fatalf("stored = %+v", stored)
	}
	events := bus.snapshot()
	last := events[len(events)-1]
	if last.Type != domain.EventSessionState || last.Session.ApprovalReviewer != domain.ReviewerAuto {
		t.Fatalf("last event = %+v", last)
	}

	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if reqs := factory.requests(); reqs[0].ApprovalReviewer != domain.ReviewerAuto {
		t.Fatalf("start request = %+v", reqs[0])
	}
}

func TestSetApprovalReviewerAppliesToRunningRuntime(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	rt := &reviewerRuntime{fakeRuntime: newFakeRuntime("n1")}
	factory.next = rt
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetApprovalReviewer(ctx, snap.ID, domain.ReviewerUser); err != nil {
		t.Fatalf("SetApprovalReviewer: %v", err)
	}
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.set) != 1 || rt.set[0] != domain.ReviewerUser {
		t.Fatalf("runtime got %v", rt.set)
	}
}

func TestSetApprovalReviewerRuntimeError(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	boom := errors.New("boom")
	factory.next = &reviewerRuntime{fakeRuntime: newFakeRuntime("n1"), err: boom}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetApprovalReviewer(ctx, snap.ID, domain.ReviewerUser); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
}

// A runtime without live switching picks the value up on its next start.
func TestSetApprovalReviewerWithPlainRuntime(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	factory.runtimes = []*fakeRuntime{newFakeRuntime("n1")}
	if err := m.SendMessage(ctx, snap.ID, "hi"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetApprovalReviewer(ctx, snap.ID, domain.ReviewerAuto); err != nil {
		t.Fatalf("SetApprovalReviewer: %v", err)
	}
}

func TestSetApprovalReviewerErrors(t *testing.T) {
	m, _, _, _, _ := newTestManager(t)
	snap := createClaude(t, m)
	ctx := context.Background()
	if _, err := m.SetApprovalReviewer(ctx, snap.ID, "robot"); !errors.Is(err, domain.ErrInvalidReviewer) {
		t.Fatalf("invalid err = %v", err)
	}
	if _, err := m.SetApprovalReviewer(ctx, "nope", domain.ReviewerUser); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("unknown session err = %v", err)
	}
}

func TestSetApprovalReviewerReportsSaveError(t *testing.T) {
	repo := &flakyRepo{memRepo: newMemRepo(), failAt: 2}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: newFakeBus(), NewID: func() string { return "x" }})
	snap := createClaude(t, m)
	if _, err := m.SetApprovalReviewer(context.Background(), snap.ID, domain.ReviewerAuto); err == nil {
		t.Fatal("want save error")
	}
}
