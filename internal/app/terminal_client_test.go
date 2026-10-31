package app

import (
	"context"
	"errors"
	"io"
	"testing"
)

func TestTerminalOwnershipSurvivesReconnectAndTakeoverCancelsOldEpoch(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.Screens = recordingScreenFactory{} })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	a, err := f.terms.AttachClient(term.ID, "tab-a")
	if err != nil {
		t.Fatal(err)
	}
	b, err := f.terms.AttachClient(term.ID, "tab-b")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Detach()
	if !a.State.Owner || b.State.Owner {
		t.Fatalf("initial ownership: %+v %+v", a.State, b.State)
	}
	if _, err := f.terms.WriteInput(term.ID, "tab-b", b.State.Epoch, 0, []byte("x")); !errors.Is(err, ErrTerminalObserver) {
		t.Fatalf("observer input: %v", err)
	}
	if err := f.terms.ResizeClient(term.ID, "tab-b", b.State.Epoch, 100, 30); !errors.Is(err, ErrTerminalObserver) {
		t.Fatalf("observer resize: %v", err)
	}
	a.Detach()
	a, err = f.terms.AttachClient(term.ID, "tab-a")
	if err != nil {
		t.Fatal(err)
	}
	defer a.Detach()
	if !a.State.Owner {
		t.Fatal("reconnect lost ownership")
	}
	state, err := f.terms.TakeControl(term.ID, "tab-b")
	if err != nil || !state.Owner || state.Epoch <= a.State.Epoch {
		t.Fatalf("takeover: %+v %v", state, err)
	}
	update := <-a.Updates
	if update.Owner || update.Epoch != state.Epoch {
		t.Fatalf("old owner not cancelled: %+v", update)
	}
	if _, err := f.terms.WriteInput(term.ID, "tab-a", a.State.Epoch, 0, []byte("old")); !errors.Is(err, ErrTerminalObserver) {
		t.Fatalf("stale input: %v", err)
	}
	if err := f.terms.ResizeClient(term.ID, "tab-b", state.Epoch, 100, 30); err != nil {
		t.Fatal(err)
	}
}

type prefixPTY struct {
	*fakePTY
	limit int
	err   error
}

func (p *prefixPTY) Write(data []byte) (int, error) {
	n, _ := p.fakePTY.Write(data[:min(p.limit, len(data))])
	return n, p.err
}

type prefixFactory struct{ p *prefixPTY }

func (f prefixFactory) Start(PTYSpec) (PTY, error) { return f.p, nil }

func TestTerminalInputAcknowledgesPartialWritesAndDeduplicatesLostACK(t *testing.T) {
	p := &prefixPTY{fakePTY: newFakePTY(), limit: 2}
	f := newTermFixture(t, func(c *TerminalsConfig) { c.PTYs = prefixFactory{p}; c.Screens = recordingScreenFactory{} })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	a, _ := f.terms.AttachClient(term.ID, "tab")
	defer a.Detach()
	input := []byte("界abc")
	for _, want := range []uint64{2, 4, 6, 6} {
		// Always resend from zero: every previous ACK was lost. The first
		// partial write ends in the middle of a UTF-8 character.
		state, err := f.terms.WriteInput(term.ID, "tab", a.State.Epoch, 0, input)
		if err != nil || state.Written != want {
			t.Fatalf("ack: %+v %v, want %d", state, err, want)
		}
	}
	if got, _, _ := p.snapshot(); got != string(input) {
		t.Fatalf("PTY input duplicated: %q", got)
	}
	if _, err := f.terms.WriteInput(term.ID, "tab", a.State.Epoch, 7, []byte("gap")); !errors.Is(err, ErrTerminalInputOffset) {
		t.Fatalf("gap accepted: %v", err)
	}
}

func TestTerminalAmbiguousWriteRequiresExplicitControlReset(t *testing.T) {
	p := &prefixPTY{fakePTY: newFakePTY(), limit: 2, err: io.ErrUnexpectedEOF}
	f := newTermFixture(t, func(c *TerminalsConfig) { c.PTYs = prefixFactory{p}; c.Screens = recordingScreenFactory{} })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	a, _ := f.terms.AttachClient(term.ID, "tab")
	defer a.Detach()
	state, err := f.terms.WriteInput(term.ID, "tab", a.State.Epoch, 0, []byte("secret"))
	if !errors.Is(err, ErrTerminalInputUncertain) || state.Written != 2 || !state.Uncertain {
		t.Fatalf("ambiguous write: %+v %v", state, err)
	}
	if _, err := f.terms.WriteInput(term.ID, "tab", a.State.Epoch, 2, []byte("cret")); !errors.Is(err, ErrTerminalInputUncertain) {
		t.Fatalf("uncertain input replayed: %v", err)
	}
	p.err = nil
	state, err = f.terms.TakeControl(term.ID, "tab")
	if err != nil || state.Uncertain || state.Epoch == a.State.Epoch {
		t.Fatalf("explicit reset: %+v %v", state, err)
	}
	state, err = f.terms.WriteInput(term.ID, "tab", state.Epoch, 2, []byte("new"))
	if err != nil || state.Written != 4 {
		t.Fatalf("fresh input: %+v %v", state, err)
	}
	if got, _, _ := p.snapshot(); got != "sene" {
		t.Fatalf("cancelled suffix replayed: %q", got)
	}
}

type blockedInputPTY struct {
	*fakePTY
	entered, release chan struct{}
}

func (p *blockedInputPTY) Write(data []byte) (int, error) {
	close(p.entered)
	<-p.release
	return p.fakePTY.Write(data)
}

type blockedInputFactory struct{ p *blockedInputPTY }

func (f blockedInputFactory) Start(PTYSpec) (PTY, error) { return f.p, nil }

func TestTerminalControlTransferIsSerializedWithPTYWrite(t *testing.T) {
	p := &blockedInputPTY{fakePTY: newFakePTY(), entered: make(chan struct{}), release: make(chan struct{})}
	f := newTermFixture(t, func(c *TerminalsConfig) { c.PTYs = blockedInputFactory{p}; c.Screens = recordingScreenFactory{} })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	a, _ := f.terms.AttachClient(term.ID, "a")
	defer a.Detach()
	b, _ := f.terms.AttachClient(term.ID, "b")
	defer b.Detach()
	written := make(chan error, 1)
	go func() { _, err := f.terms.WriteInput(term.ID, "a", a.State.Epoch, 0, []byte("abc")); written <- err }()
	<-p.entered
	taken := make(chan error, 1)
	go func() { _, err := f.terms.TakeControl(term.ID, "b"); taken <- err }()
	select {
	case err := <-taken:
		t.Fatalf("ownership changed during a PTY write: %v", err)
	default:
	}
	close(p.release)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-taken; err != nil {
		t.Fatal(err)
	}
	state := <-a.Updates
	if state.Owner || state.Written != 3 {
		t.Fatalf("old owner's committed prefix: %+v", state)
	}
}

func TestTerminalClientRejectsInvalidAndOversizedInput(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.Screens = recordingScreenFactory{} })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	if _, err := f.terms.AttachClient(term.ID, ""); !errors.Is(err, ErrTerminalClient) {
		t.Fatal(err)
	}
	if _, err := f.terms.AttachClient(term.ID, string(make([]byte, 129))); !errors.Is(err, ErrTerminalClient) {
		t.Fatal(err)
	}
	if _, err := f.terms.TakeControl(term.ID, "unknown"); !errors.Is(err, ErrTerminalClient) {
		t.Fatal(err)
	}
	if _, err := f.terms.WriteInput(term.ID, "unknown", 0, 0, nil); !errors.Is(err, ErrTerminalClient) {
		t.Fatal(err)
	}
	if err := f.terms.ResizeClient(term.ID, "unknown", 0, 10, 10); !errors.Is(err, ErrTerminalClient) {
		t.Fatal(err)
	}
	a, _ := f.terms.AttachClient(term.ID, "a")
	defer a.Detach()
	if _, err := f.terms.WriteInput(term.ID, "a", a.State.Epoch, 0, make([]byte, 65537)); !errors.Is(err, ErrTerminalInputTooLarge) {
		t.Fatal(err)
	}
	if err := f.terms.ResizeClient(term.ID, "a", a.State.Epoch, 0, 10); !errors.Is(err, ErrInvalidTerminalSize) {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := f.terms.TakeControl(term.ID, "a"); err != nil {
			t.Fatal(err)
		}
	}
	if state := <-a.Updates; state.Epoch != 4 {
		t.Fatalf("control queue did not coalesce: %+v", state)
	}
	a.Detach()
	a.Detach()
	plain := newTermFixture(t)
	other, _ := plain.terms.Open(context.Background(), OpenTerminal{})
	if _, err := plain.terms.AttachClient(other.ID, "a"); err == nil {
		t.Fatal("client attached without screen support")
	}
}
