package domain

import (
	"errors"
	"testing"
	"time"
)

func TestArchiveHidesUntilUnarchived(t *testing.T) {
	s := newTestSession(t)
	if s.Archived() {
		t.Fatal("a new session is not archived")
	}
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.FixedZone("x", 3600))
	if err := s.Archive(at); err != nil {
		t.Fatal(err)
	}
	if !s.Archived() || !s.Snapshot().ArchivedAt.Equal(at) || s.Snapshot().ArchivedAt.Location() != time.UTC {
		t.Fatalf("archived=%v at %v", s.Archived(), s.Snapshot().ArchivedAt)
	}
	// Archiving again keeps when it was first put away.
	if err := s.Archive(at.Add(time.Hour)); err != nil || !s.Snapshot().ArchivedAt.Equal(at) {
		t.Fatalf("second archive: %v at %v", err, s.Snapshot().ArchivedAt)
	}
	s.Unarchive()
	if s.Archived() || !s.Snapshot().ArchivedAt.IsZero() {
		t.Fatalf("unarchive left %v", s.Snapshot().ArchivedAt)
	}
}

func TestArchiveNeedsATime(t *testing.T) {
	s := newTestSession(t)
	if err := s.Archive(time.Time{}); !errors.Is(err, ErrInvalidTransition) || s.Archived() {
		t.Fatalf("zero time: %v, archived=%v", err, s.Archived())
	}
}

func TestArchivedSurvivesRestore(t *testing.T) {
	s := newTestSession(t)
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	_ = s.Archive(at)
	r, err := RestoreSession(s.Snapshot())
	if err != nil || !r.Archived() || !r.Snapshot().ArchivedAt.Equal(at) {
		t.Fatalf("restored %+v, %v", r.Snapshot(), err)
	}
}

func TestOnlyASessionAtRestCanBeDeleted(t *testing.T) {
	s := newTestSession(t)
	if err := s.Deletable(); err != nil {
		t.Fatalf("detached: %v", err)
	}
	_ = s.RuntimeAttached("n1")
	if err := s.Deletable(); err != nil {
		t.Fatalf("idle: %v", err)
	}
	_ = s.TurnStarted()
	if err := s.Deletable(); !errors.Is(err, ErrSessionBusy) {
		t.Fatalf("running: %v", err)
	}
	_ = s.TurnInterrupted(ExitCrashed)
	if err := s.Deletable(); err != nil {
		t.Fatalf("interrupted: %v", err)
	}
}

func TestSessionRemovedEventNeedsNoPayload(t *testing.T) {
	if err := (Event{SessionID: "s1", Type: EventSessionRemoved}).Valid(); err != nil {
		t.Fatal(err)
	}
	if err := (Event{Type: EventSessionRemoved}).Valid(); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("no session: %v", err)
	}
}
