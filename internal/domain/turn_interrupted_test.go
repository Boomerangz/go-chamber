package domain

import "testing"

func TestTurnInterruptedKeepsRuntime(t *testing.T) {
	s := newTestSession(t)
	if err := s.TurnInterrupted(ExitServerRestart); err == nil {
		t.Fatal("accepted without running turn")
	}
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	mustNoErr(t, s.TurnInterrupted(ExitServerRestart))
	if !s.Continuable() || s.NeedsRuntime() || s.Interruption().Reason != ExitServerRestart {
		t.Fatal(s.Snapshot())
	}
	mustNoErr(t, s.TurnStarted())
}
