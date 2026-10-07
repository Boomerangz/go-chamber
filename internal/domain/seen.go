package domain

import (
	"errors"
	"time"
)

// ErrInvalidSeen rejects a look at a session without a time.
var ErrInvalidSeen = errors.New("invalid seen mark")

// Seen is how far the owner has looked at a session, on whichever device:
// when they last did, and the last item they had read then (kept from an
// earlier look when they looked without reaching the end).
type Seen struct {
	Item ItemID    `json:"item,omitempty"`
	At   time.Time `json:"at,omitzero"`
}

// MarkSeen records that the owner looked at the session at the given time,
// having read up to item. Marks only move forward: a late report from
// another device does not take back a newer one.
func (s *Session) MarkSeen(item ItemID, at time.Time) error {
	if at.IsZero() {
		return ErrInvalidSeen
	}
	if at.Before(s.seen.At) {
		return nil
	}
	s.seen.At = at.UTC()
	if item != "" {
		s.seen.Item = item
	}
	return nil
}

// NoteTurnEnd records when a turn last ended, so every device can tell
// whether the owner has looked since.
func (s *Session) NoteTurnEnd(at time.Time) {
	if at.After(s.endedAt) {
		s.endedAt = at.UTC()
	}
}

// Unseen tells a session whose turn ended after the owner last looked.
// A running session says so itself.
func (snap SessionSnapshot) Unseen() bool {
	return snap.Status != StatusRunning && snap.EndedAt.After(snap.Seen.At)
}
