package domain

import (
	"errors"
	"testing"
	"time"
)

var seenBase = time.Date(2026, 10, 7, 9, 0, 0, 0, time.UTC)

func TestMarkSeenMovesForwardOnly(t *testing.T) {
	s := newTestSession(t)
	if !s.Snapshot().Seen.At.IsZero() {
		t.Fatal("a new session has not been seen")
	}
	if err := s.MarkSeen("i2", seenBase.In(time.FixedZone("x", 3600))); err != nil {
		t.Fatal(err)
	}
	got := s.Snapshot().Seen
	if got.Item != "i2" || !got.At.Equal(seenBase) || got.At.Location() != time.UTC {
		t.Fatalf("seen %+v", got)
	}
	// A late report from another device does not take the mark back.
	if err := s.MarkSeen("i1", seenBase.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := s.Snapshot().Seen; got.Item != "i2" || !got.At.Equal(seenBase) {
		t.Fatalf("older mark won: %+v", got)
	}
	// A look without an item (scrolled up) moves the time, keeps the item.
	if err := s.MarkSeen("", seenBase.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if got := s.Snapshot().Seen; got.Item != "i2" || !got.At.Equal(seenBase.Add(time.Second)) {
		t.Fatalf("itemless look: %+v", got)
	}
	if err := s.MarkSeen("i3", seenBase.Add(time.Second)); err != nil || s.Snapshot().Seen.Item != "i3" {
		t.Fatalf("same instant, new item: %+v %v", s.Snapshot().Seen, err)
	}
}

func TestMarkSeenNeedsATime(t *testing.T) {
	s := newTestSession(t)
	if err := s.MarkSeen("i1", time.Time{}); !errors.Is(err, ErrInvalidSeen) || s.Snapshot().Seen.Item != "" {
		t.Fatalf("zero time: %v, %+v", err, s.Snapshot().Seen)
	}
}

func TestUnseenIsATurnEndedAfterTheLastLook(t *testing.T) {
	s := newTestSession(t)
	if s.Snapshot().Unseen() {
		t.Fatal("a session that never ran a turn has nothing new")
	}
	s.NoteTurnEnd(seenBase)
	if !s.Snapshot().Unseen() {
		t.Fatal("a turn that ended before any look is new")
	}
	_ = s.MarkSeen("i1", seenBase)
	if s.Snapshot().Unseen() {
		t.Fatal("looked at as the turn ended")
	}
	s.NoteTurnEnd(seenBase.Add(time.Minute).In(time.FixedZone("x", 3600)))
	snap := s.Snapshot()
	if !snap.Unseen() || snap.EndedAt.Location() != time.UTC {
		t.Fatalf("a later turn end is new: %+v", snap)
	}
	snap.Status = StatusRunning
	if snap.Unseen() {
		t.Fatal("a running session says so itself")
	}
	// An end noted out of order does not move the time back.
	s.NoteTurnEnd(seenBase)
	if !s.Snapshot().EndedAt.Equal(seenBase.Add(time.Minute)) {
		t.Fatalf("ended at %v", s.Snapshot().EndedAt)
	}
}

func TestSeenSurvivesRestore(t *testing.T) {
	s := newTestSession(t)
	_ = s.MarkSeen("i1", seenBase)
	s.NoteTurnEnd(seenBase.Add(time.Minute))
	r, err := RestoreSession(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	snap := r.Snapshot()
	if snap.Seen != s.Snapshot().Seen || !snap.EndedAt.Equal(seenBase.Add(time.Minute)) {
		t.Fatalf("restored %+v", snap)
	}
}
