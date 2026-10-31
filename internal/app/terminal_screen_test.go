package app

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type recordingScreen struct {
	data       []byte
	cols, rows uint16
	closed     bool
}

func (s *recordingScreen) Feed(p []byte) []byte      { s.data = append(s.data, p...); return nil }
func (s *recordingScreen) Resize(c, r uint16) []byte { s.cols, s.rows = c, r; return nil }
func (s *recordingScreen) Snapshot() TerminalScreenSnapshot {
	return TerminalScreenSnapshot{Data: append([]byte("screen:"), s.data...), Cols: s.cols, Rows: s.rows}
}
func (s *recordingScreen) Close() { s.closed = true }

type recordingScreenFactory struct{}

func (recordingScreenFactory) New(c, r uint16) TerminalScreen {
	return &recordingScreen{cols: c, rows: r}
}

func TestScreenAttachmentHasAtomicPositionAndLiveContinuation(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.Screens = recordingScreenFactory{}; c.ScrollbackBytes = 2 })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{Cols: 20, Rows: 5})
	_, p := f.factory.last(t)
	barrier, _ := f.terms.Attach(term.ID)
	p.emit(t, "before")
	recv(t, barrier.Output)
	barrier.Detach()
	// Output is interpreted without attached clients, beyond the byte tail.
	p.emit(t, "offline")
	// The pipe write returns on read, not on publish; lock via a live barrier.
	watch, _ := f.terms.Attach(term.ID)
	defer watch.Detach()
	p.emit(t, "!")
	for recvFrame(t, watch.Output).Position < 14 {
	}
	if err := f.terms.Resize(term.ID, 30, 8); err != nil {
		t.Fatal(err)
	}
	a, err := f.terms.AttachScreen(term.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Detach()
	if a.Screen.Position != 14 || string(a.Screen.Data) != "screen:beforeoffline!" || a.Screen.Cols != 30 || a.Screen.Rows != 8 {
		t.Fatalf("snapshot = %+v", a.Screen)
	}
	p.emit(t, "live")
	out := recvFrame(t, a.Output)
	if out.Position != 18 || string(out.Data) != "live" {
		t.Fatalf("continuation = %+v", out)
	}
}

func TestScreenLagRecoversCurrentDisplayAtPosition(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.Screens = recordingScreenFactory{}; c.LagBytes = 4 })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	a, _ := f.terms.AttachScreen(term.ID)
	defer a.Detach()
	rt, _ := f.terms.find(term.ID)
	rt.publish([]byte("too much"))
	out := recvFrame(t, a.Output)
	if !out.Resync || out.Position != 8 || string(out.Data) != "screen:too much" {
		t.Fatalf("resync = %+v", out)
	}
}

func TestScreenUnavailableDoesNotChangeLegacyAttachment(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	if _, err := f.terms.AttachScreen(term.ID); err == nil {
		t.Fatal("screen attachment without emulator")
	}
	if _, err := f.terms.AttachScreen(domain.TerminalID("missing")); err == nil {
		t.Fatal("missing terminal")
	}
}
