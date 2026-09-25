package domain

import (
	"errors"
	"testing"
	"time"
)

func newTestSession(t *testing.T) *Session {
	t.Helper()
	s, err := NewSession("s1", AgentClaude, "/tmp/proj")
	if err != nil {
		t.Fatalf("NewSession: %v", err)
	}
	return s
}

func TestNewSessionValidates(t *testing.T) {
	cases := []struct {
		name  string
		id    SessionID
		agent AgentKind
		cwd   string
	}{
		{"empty id", "", AgentClaude, "/x"},
		{"unknown agent", "s", AgentKind("gemini"), "/x"},
		{"empty cwd", "s", AgentCodex, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewSession(tc.id, tc.agent, tc.cwd); !errors.Is(err, ErrInvalidSession) {
				t.Fatalf("want ErrInvalidSession, got %v", err)
			}
		})
	}
}

func TestNewSessionStartsDetachedWithoutNativeID(t *testing.T) {
	s := newTestSession(t)
	if s.Status() != StatusDetached {
		t.Fatalf("status = %s, want detached", s.Status())
	}
	if s.NativeID() != "" {
		t.Fatalf("native id = %q, want empty", s.NativeID())
	}
	if !s.NeedsRuntime() {
		t.Fatal("new session must need a runtime")
	}
	if s.ID() != "s1" || s.Agent() != AgentClaude || s.Cwd() != "/tmp/proj" {
		t.Fatal("accessors return wrong values")
	}
}

func TestAttachRuntimeFlow(t *testing.T) {
	s := newTestSession(t)
	if err := s.RuntimeAttached("native-1"); err != nil {
		t.Fatalf("RuntimeAttached: %v", err)
	}
	if s.Status() != StatusIdle || s.NativeID() != "native-1" || s.NeedsRuntime() {
		t.Fatalf("after attach: status=%s native=%q", s.Status(), s.NativeID())
	}
}

func TestAttachRuntimeRejectsEmptyNativeID(t *testing.T) {
	s := newTestSession(t)
	if err := s.RuntimeAttached(""); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("want ErrInvalidTransition, got %v", err)
	}
}

func TestReattachMustKeepNativeID(t *testing.T) {
	s := newTestSession(t)
	mustNoErr(t, s.RuntimeAttached("native-1"))
	s.RuntimeExited(ExitIdleTimeout)
	if err := s.RuntimeAttached("native-2"); !errors.Is(err, ErrNativeIDMismatch) {
		t.Fatalf("want ErrNativeIDMismatch, got %v", err)
	}
	mustNoErr(t, s.RuntimeAttached("native-1"))
	if s.Status() != StatusIdle {
		t.Fatalf("status = %s, want idle", s.Status())
	}
}

func TestAttachWhileAttachedIsInvalid(t *testing.T) {
	s := newTestSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	if err := s.RuntimeAttached("n"); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("want ErrInvalidTransition, got %v", err)
	}
}

func TestTurnLifecycle(t *testing.T) {
	s := newTestSession(t)
	if err := s.TurnStarted(); !errors.Is(err, ErrNeedsRuntime) {
		t.Fatalf("turn without runtime: want ErrNeedsRuntime, got %v", err)
	}
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	if s.Status() != StatusRunning {
		t.Fatalf("status = %s, want running", s.Status())
	}
	if err := s.TurnStarted(); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("second turn: want ErrInvalidTransition, got %v", err)
	}
	mustNoErr(t, s.TurnCompleted())
	if s.Status() != StatusIdle {
		t.Fatalf("status = %s, want idle", s.Status())
	}
	if err := s.TurnCompleted(); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("complete idle: want ErrInvalidTransition, got %v", err)
	}
}

func TestRuntimeExitDuringTurnInterrupts(t *testing.T) {
	s := newTestSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	s.RuntimeExited(ExitCrashed)
	if s.Status() != StatusInterrupted {
		t.Fatalf("status = %s, want interrupted", s.Status())
	}
	if s.Interruption().Reason != ExitCrashed {
		t.Fatalf("reason = %s, want crashed", s.Interruption().Reason)
	}
	if !s.NeedsRuntime() {
		t.Fatal("interrupted session must need runtime")
	}
	mustNoErr(t, s.RuntimeAttached("n"))
	if s.Status() != StatusIdle || s.Interruption().Reason != "" {
		t.Fatalf("after resume: status=%s interruption=%+v", s.Status(), s.Interruption())
	}
}

func TestRuntimeExitWhileIdleDetaches(t *testing.T) {
	for _, reason := range []ExitReason{ExitIdleTimeout, ExitServerRestart, ExitCrashed} {
		s := newTestSession(t)
		mustNoErr(t, s.RuntimeAttached("n"))
		s.RuntimeExited(reason)
		if s.Status() != StatusDetached {
			t.Fatalf("%s: status = %s, want detached", reason, s.Status())
		}
	}
}

func TestRuntimeExitWhenDetachedIsNoop(t *testing.T) {
	s := newTestSession(t)
	s.RuntimeExited(ExitCrashed)
	if s.Status() != StatusDetached {
		t.Fatalf("status = %s, want detached", s.Status())
	}
}

func TestQuotaInterruptionKeepsResetTime(t *testing.T) {
	s := newTestSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	reset := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	mustNoErr(t, s.QuotaExhausted(reset))
	if s.Status() != StatusInterrupted {
		t.Fatalf("status = %s, want interrupted", s.Status())
	}
	got := s.Interruption()
	if got.Reason != ExitQuota || !got.ResumeAfter.Equal(reset) {
		t.Fatalf("interruption = %+v", got)
	}
	// The process is still alive: the session doesn't need a new runtime,
	// the next turn may start once the quota window resets.
	if s.NeedsRuntime() {
		t.Fatal("quota interruption keeps runtime")
	}
	mustNoErr(t, s.TurnStarted())
	if s.Status() != StatusRunning || s.Interruption().Reason != "" {
		t.Fatalf("after continue: status=%s interruption=%+v", s.Status(), s.Interruption())
	}
}

func TestQuotaExhaustedOutsideTurnIsInvalid(t *testing.T) {
	s := newTestSession(t)
	if err := s.QuotaExhausted(time.Now()); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("want ErrInvalidTransition, got %v", err)
	}
}

func TestQuotaInterruptedThenProcessExitNeedsRuntime(t *testing.T) {
	s := newTestSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	mustNoErr(t, s.QuotaExhausted(time.Now()))
	s.RuntimeExited(ExitCrashed)
	if s.Status() != StatusInterrupted || !s.NeedsRuntime() {
		t.Fatalf("status=%s needsRuntime=%v", s.Status(), s.NeedsRuntime())
	}
	if s.Interruption().Reason != ExitQuota {
		t.Fatalf("original quota reason must be kept, got %s", s.Interruption().Reason)
	}
}

func TestRestoreRehydratesAfterServerRestart(t *testing.T) {
	s, err := RestoreSession(SessionSnapshot{
		ID: "s1", Agent: AgentCodex, Cwd: "/p", NativeID: "thr", Status: StatusRunning, Title: "t",
	})
	mustNoErr(t, err)
	if s.Status() != StatusInterrupted || s.Interruption().Reason != ExitServerRestart {
		t.Fatalf("running session after restart: status=%s interruption=%+v", s.Status(), s.Interruption())
	}
	idle, err := RestoreSession(SessionSnapshot{ID: "s2", Agent: AgentCodex, Cwd: "/p", NativeID: "thr", Status: StatusIdle})
	mustNoErr(t, err)
	if idle.Status() != StatusDetached {
		t.Fatalf("idle session after restart: status=%s", idle.Status())
	}
	if s.Title() != "t" || s.Snapshot().NativeID != "thr" {
		t.Fatal("snapshot fields not restored")
	}
}

func TestRestoreKeepsInterruption(t *testing.T) {
	reset := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s, err := RestoreSession(SessionSnapshot{
		ID: "s", Agent: AgentClaude, Cwd: "/p", NativeID: "n", Status: StatusInterrupted,
		Interruption: Interruption{Reason: ExitQuota, ResumeAfter: reset},
	})
	mustNoErr(t, err)
	if s.Interruption().Reason != ExitQuota || !s.Interruption().ResumeAfter.Equal(reset) {
		t.Fatalf("interruption = %+v", s.Interruption())
	}
	if !s.NeedsRuntime() {
		t.Fatal("restored session must need runtime")
	}
}

func TestRestoreValidates(t *testing.T) {
	if _, err := RestoreSession(SessionSnapshot{ID: "", Agent: AgentClaude, Cwd: "/p"}); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("want ErrInvalidSession, got %v", err)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	s := newTestSession(t)
	s.Rename("hello")
	mustNoErr(t, s.RuntimeAttached("n"))
	snap := s.Snapshot()
	want := SessionSnapshot{ID: "s1", Agent: AgentClaude, Cwd: "/tmp/proj", NativeID: "n", Status: StatusIdle, Title: "hello"}
	if snap != want {
		t.Fatalf("snapshot = %+v, want %+v", snap, want)
	}
}

func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNewChildSession(t *testing.T) {
	s, err := NewChildSession("c1", AgentCodex, "/p", "p1")
	if err != nil {
		t.Fatal(err)
	}
	if s.ParentID() != "p1" || s.Snapshot().ParentID != "p1" {
		t.Fatalf("parent = %q", s.ParentID())
	}
	if _, err := NewChildSession("c1", AgentCodex, "/p", ""); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("want ErrInvalidSession, got %v", err)
	}
	restored, err := RestoreSession(SessionSnapshot{ID: "c1", Agent: AgentCodex, Cwd: "/p", ParentID: "p1"})
	if err != nil || restored.ParentID() != "p1" {
		t.Fatalf("restored parent = %q, %v", restored.ParentID(), err)
	}
}

func TestApprovalReviewerDefaultsToAgentConfig(t *testing.T) {
	s, _ := NewSession("s", AgentCodex, "/w")
	if got := s.Snapshot().ApprovalReviewer; got != ReviewerDefault {
		t.Fatalf("reviewer = %q, want agent default", got)
	}
}

func TestSetApprovalReviewer(t *testing.T) {
	s, _ := NewSession("s", AgentCodex, "/w")
	for _, r := range []ApprovalReviewer{ReviewerAuto, ReviewerUser, ReviewerDefault} {
		if err := s.SetApprovalReviewer(r); err != nil {
			t.Fatalf("SetApprovalReviewer(%q): %v", r, err)
		}
		if got := s.ApprovalReviewer(); got != r {
			t.Fatalf("reviewer = %q, want %q", got, r)
		}
	}
	if err := s.SetApprovalReviewer("robot"); !errors.Is(err, ErrInvalidReviewer) {
		t.Fatalf("err = %v, want ErrInvalidReviewer", err)
	}
	if got := s.ApprovalReviewer(); got != ReviewerDefault {
		t.Fatalf("invalid value changed reviewer to %q", got)
	}
}

func TestRestoreKeepsApprovalReviewer(t *testing.T) {
	s, _ := NewSession("s", AgentCodex, "/w")
	_ = s.SetApprovalReviewer(ReviewerAuto)
	r, err := RestoreSession(s.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if r.ApprovalReviewer() != ReviewerAuto || r.Snapshot().ApprovalReviewer != ReviewerAuto {
		t.Fatalf("restored reviewer = %q", r.ApprovalReviewer())
	}
}

func TestSessionTouchStampsCreationOnceAndActivity(t *testing.T) {
	s, _ := NewSession("s", AgentClaude, "/p")
	t0 := time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)
	s.Touch(t0)
	s.Touch(t0.Add(time.Hour))
	snap := s.Snapshot()
	if !snap.CreatedAt.Equal(t0) || !snap.ActiveAt.Equal(t0.Add(time.Hour)) {
		t.Fatalf("snapshot times = %v / %v", snap.CreatedAt, snap.ActiveAt)
	}
	restored, err := RestoreSession(snap)
	if err != nil {
		t.Fatal(err)
	}
	if got := restored.Snapshot(); !got.CreatedAt.Equal(t0) || !got.ActiveAt.Equal(t0.Add(time.Hour)) {
		t.Fatalf("restored times = %v / %v", got.CreatedAt, got.ActiveAt)
	}
}
