package app

import (
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakePTY struct {
	out   *io.PipeReader
	outW  *io.PipeWriter
	exitc chan int

	mu     sync.Mutex
	input  []byte
	sizes  [][2]uint16
	closed bool
	once   sync.Once
}

func newFakePTY() *fakePTY {
	r, w := io.Pipe()
	return &fakePTY{out: r, outW: w, exitc: make(chan int, 1)}
}

func (p *fakePTY) Read(b []byte) (int, error) { return p.out.Read(b) }

func (p *fakePTY) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.input = append(p.input, b...)
	return len(b), nil
}

func (p *fakePTY) Resize(cols, rows uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sizes = append(p.sizes, [2]uint16{cols, rows})
	return nil
}

func (p *fakePTY) Wait() (int, error) { return <-p.exitc, nil }

func (p *fakePTY) Close() error {
	p.mu.Lock()
	p.closed = true
	p.mu.Unlock()
	p.exit(-1)
	return nil
}

// exit simulates the shell exiting with code.
func (p *fakePTY) exit(code int) {
	p.once.Do(func() {
		_ = p.outW.Close()
		p.exitc <- code
	})
}

// emit writes shell output; it blocks until the terminal pump reads it.
func (p *fakePTY) emit(t *testing.T, s string) {
	t.Helper()
	if _, err := p.outW.Write([]byte(s)); err != nil {
		t.Fatalf("emit: %v", err)
	}
}

func (p *fakePTY) snapshot() (input string, sizes [][2]uint16, closed bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return string(p.input), append([][2]uint16(nil), p.sizes...), p.closed
}

type fakePTYFactory struct {
	mu    sync.Mutex
	specs []PTYSpec
	ptys  []*fakePTY
	err   error
}

func (f *fakePTYFactory) Start(spec PTYSpec) (PTY, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.specs = append(f.specs, spec)
	if f.err != nil {
		return nil, f.err
	}
	p := newFakePTY()
	f.ptys = append(f.ptys, p)
	return p, nil
}

func (f *fakePTYFactory) last(t *testing.T) (PTYSpec, *fakePTY) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ptys) == 0 {
		t.Fatal("no pty started")
	}
	return f.specs[len(f.specs)-1], f.ptys[len(f.ptys)-1]
}

type termFixture struct {
	terms   *Terminals
	factory *fakePTYFactory
	repo    *memRepo
}

func newTermFixture(t *testing.T, mods ...func(*TerminalsConfig)) termFixture {
	t.Helper()
	f := termFixture{factory: &fakePTYFactory{}, repo: newMemRepo()}
	n := 0
	start := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	cfg := TerminalsConfig{
		PTYs:     f.factory,
		Sessions: f.repo,
		Home:     "/home/me",
		Shell:    "/bin/zsh",
		NewID: func() string {
			n++
			return "t" + string(rune('0'+n))
		},
		Now: func() time.Time { return start.Add(time.Duration(n) * time.Second) },
	}
	for _, m := range mods {
		m(&cfg)
	}
	f.terms = NewTerminals(cfg)
	t.Cleanup(f.terms.CloseAll)
	return f
}

func recv(t *testing.T, ch <-chan TerminalOutput) string {
	t.Helper()
	return string(recvFrame(t, ch).Data)
}

func recvFrame(t *testing.T, ch <-chan TerminalOutput) TerminalOutput {
	t.Helper()
	select {
	case b, ok := <-ch:
		if !ok {
			t.Fatal("output closed")
		}
		return b
	case <-time.After(2 * time.Second):
		t.Fatal("no output")
	}
	return TerminalOutput{}
}

func waitClosed(t *testing.T, ch <-chan TerminalOutput) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("output not closed")
		}
	}
}

func waitStatus(t *testing.T, terms *Terminals, id domain.TerminalID, want domain.TerminalStatus) domain.Terminal {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		term, err := terms.Get(id)
		if err == nil && term.Status == want {
			return term
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal %s: %+v, %v; want status %s", id, term, err, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestOpenTerminalInDirectory(t *testing.T) {
	f := newTermFixture(t)
	term, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "/srv/app", Cols: 120, Rows: 40})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	want := domain.Terminal{
		ID: "t1", Cwd: "/srv/app", Shell: "/bin/zsh", Title: "app",
		Status: domain.TerminalRunning, CreatedAt: time.Date(2026, 9, 25, 12, 0, 1, 0, time.UTC),
	}
	if term != want {
		t.Fatalf("terminal = %+v, want %+v", term, want)
	}
	spec, _ := f.factory.last(t)
	if spec != (PTYSpec{Cwd: "/srv/app", Shell: "/bin/zsh", Cols: 120, Rows: 40}) {
		t.Fatalf("spec = %+v", spec)
	}
	if got := f.terms.List(); len(got) != 1 || got[0] != term {
		t.Fatalf("list = %+v", got)
	}
}

func TestOpenTerminalDefaultsToHomeAndSize(t *testing.T) {
	f := newTermFixture(t)
	term, err := f.terms.Open(context.Background(), OpenTerminal{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if term.Cwd != "/home/me" {
		t.Fatalf("cwd = %q, want home", term.Cwd)
	}
	spec, _ := f.factory.last(t)
	if spec.Cols != 80 || spec.Rows != 24 {
		t.Fatalf("size = %dx%d, want 80x24", spec.Cols, spec.Rows)
	}
}

func TestOpenTerminalDefaultShell(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.Shell = "" })
	term, err := f.terms.Open(context.Background(), OpenTerminal{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if term.Shell != "/bin/sh" {
		t.Fatalf("shell = %q, want /bin/sh", term.Shell)
	}
}

func TestOpenTerminalInSessionDirectory(t *testing.T) {
	f := newTermFixture(t)
	_ = f.repo.Save(context.Background(), domain.SessionSnapshot{ID: "s1", Agent: domain.AgentClaude, Cwd: "/work/repo"})
	term, err := f.terms.Open(context.Background(), OpenTerminal{SessionID: "s1", Cwd: "/ignored"})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if term.Cwd != "/work/repo" || term.SessionID != "s1" {
		t.Fatalf("terminal = %+v", term)
	}
}

func TestOpenTerminalUnknownSession(t *testing.T) {
	f := newTermFixture(t)
	if _, err := f.terms.Open(context.Background(), OpenTerminal{SessionID: "nope"}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
	if len(f.factory.specs) != 0 {
		t.Fatal("pty started for unknown session")
	}
}

func TestOpenTerminalRejectsRelativeCwd(t *testing.T) {
	f := newTermFixture(t)
	if _, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "rel"}); !errors.Is(err, domain.ErrInvalidTerminal) {
		t.Fatalf("err = %v, want ErrInvalidTerminal", err)
	}
	if len(f.factory.specs) != 0 {
		t.Fatal("pty started for invalid terminal")
	}
}

func TestOpenTerminalStartFailure(t *testing.T) {
	boom := errors.New("boom")
	f := newTermFixture(t)
	f.factory.err = boom
	if _, err := f.terms.Open(context.Background(), OpenTerminal{}); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if got := f.terms.List(); len(got) != 0 {
		t.Fatalf("list = %+v, want empty", got)
	}
}

func TestListTerminalsInCreationOrder(t *testing.T) {
	f := newTermFixture(t)
	for range 3 {
		if _, err := f.terms.Open(context.Background(), OpenTerminal{}); err != nil {
			t.Fatal(err)
		}
	}
	got := f.terms.List()
	if len(got) != 3 || got[0].ID != "t1" || got[1].ID != "t2" || got[2].ID != "t3" {
		t.Fatalf("list = %+v", got)
	}
}

func TestAttachReplaysScrollbackThenStreams(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	first, err := f.terms.Attach(term.ID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer first.Detach()
	if len(first.Scrollback) != 0 {
		t.Fatalf("scrollback = %q, want empty", first.Scrollback)
	}
	p.emit(t, "$ ")
	if got := recv(t, first.Output); got != "$ " {
		t.Fatalf("output = %q", got)
	}

	second, err := f.terms.Attach(term.ID)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	defer second.Detach()
	if string(second.Scrollback) != "$ " {
		t.Fatalf("scrollback = %q, want replay", second.Scrollback)
	}
	p.emit(t, "ls")
	if got := recv(t, second.Output); got != "ls" {
		t.Fatalf("second output = %q", got)
	}
	if got := recv(t, first.Output); got != "ls" {
		t.Fatalf("first output = %q", got)
	}
}

func TestScrollbackIsBounded(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.ScrollbackBytes = 4 })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	watch, _ := f.terms.Attach(term.ID)
	p.emit(t, "abcdef")
	recv(t, watch.Output)
	a, _ := f.terms.Attach(term.ID)
	if string(a.Scrollback) != "cdef" {
		t.Fatalf("scrollback = %q, want cdef", a.Scrollback)
	}
}

func TestDetachStopsDelivery(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	a, _ := f.terms.Attach(term.ID)
	a.Detach()
	a.Detach()
	waitClosed(t, a.Output)
	b, _ := f.terms.Attach(term.ID)
	defer b.Detach()
	p.emit(t, "after")
	if got := recv(t, b.Output); got != "after" {
		t.Fatalf("output = %q", got)
	}
}

// A client that falls too far behind is not dropped: its backlog is
// discarded and it is resynced from the scrollback, so it keeps its socket
// (and its input) instead of reconnecting with a growing backoff.
func TestSlowSubscriberIsResyncedFromScrollback(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.LagBytes = 8 })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	slow, _ := f.terms.Attach(term.ID)
	defer slow.Detach()
	fast, _ := f.terms.Attach(term.ID)
	defer fast.Detach()
	// fast doubles as a barrier: once it has a chunk, every client has it queued.
	emit := func(chunk string) {
		t.Helper()
		p.emit(t, chunk)
		if got := recv(t, fast.Output); got != chunk {
			t.Fatalf("fast output = %q, want %q", got, chunk)
		}
	}
	// The frame being delivered counts too: exactly LagBytes still fits.
	emit("12345")
	emit("678")
	if lagged := f.terms.Diagnostics()[0].LaggedClients; lagged != 0 {
		t.Fatalf("resynced at the limit: %d", lagged)
	}
	emit("9")
	// Output while the resync waits is part of the scrollback it will send.
	emit("0")
	if got := recvFrame(t, slow.Output); got.Resync || string(got.Data) != "12345" {
		t.Fatalf("frame in flight = %+v", got)
	}
	got := recvFrame(t, slow.Output)
	if !got.Resync || string(got.Data) != "1234567890" {
		t.Fatalf("resync frame = resync:%v %q, want the whole scrollback", got.Resync, got.Data)
	}
	emit("AB")
	if got := recvFrame(t, slow.Output); got.Resync || string(got.Data) != "AB" {
		t.Fatalf("after resync = %+v, want live output again", got)
	}
	if lagged := f.terms.Diagnostics()[0].LaggedClients; lagged != 1 {
		t.Fatalf("lagged clients = %d, want 1", lagged)
	}
	if got, _ := f.terms.Get(term.ID); got.Status != domain.TerminalRunning {
		t.Fatalf("terminal status = %s, want running", got.Status)
	}
}

// Input is independent of output backpressure: a client whose output is
// stuck still reaches the shell, e.g. Ctrl-C to stop a flood.
func TestInputReachesShellWhileOutputIsBackedUp(t *testing.T) {
	f := newTermFixture(t, func(c *TerminalsConfig) { c.LagBytes = 8 })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	stuck, _ := f.terms.Attach(term.ID)
	defer stuck.Detach()
	for range 5 {
		p.emit(t, "yyyyyyyy")
	}
	if err := f.terms.Write(term.ID, []byte("\x03")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if input, _, _ := p.snapshot(); input != "\x03" {
		t.Fatalf("input = %q", input)
	}
}

// A shell printing line by line yields one tiny read per line; a client on a
// slower link must not be dropped while the backlog is small in bytes.
func TestSlowSubscriberCatchesUpOnManyTinyChunks(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	slow, _ := f.terms.Attach(term.ID)
	defer slow.Detach()
	const chunks = 20_000
	for range chunks {
		p.emit(t, "x")
	}
	got := 0
	for got < chunks {
		got += len(recv(t, slow.Output))
	}
	if lagged := f.terms.Diagnostics()[0].LaggedClients; got != chunks || lagged != 0 {
		t.Fatalf("received %d of %d bytes, resyncs=%d", got, chunks, lagged)
	}
}

// Queued output reaches the client coalesced, one bounded frame at a time.
func TestQueuedOutputIsCoalescedIntoBoundedFrames(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	a, _ := f.terms.Attach(term.ID)
	defer a.Detach()
	chunk := strings.Repeat("y", 1000)
	const chunks = 600
	for range chunks {
		p.emit(t, chunk)
	}
	var total, frames int
	for total < chunks*len(chunk) {
		frame := recv(t, a.Output)
		if len(frame) > maxOutputFrame {
			t.Fatalf("frame of %d bytes exceeds %d", len(frame), maxOutputFrame)
		}
		total += len(frame)
		frames++
	}
	if frames >= chunks/10 {
		t.Fatalf("%d chunks arrived as %d frames", chunks, frames)
	}
}

func TestTerminalExitClosesOutputAndRecordsCode(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	a, _ := f.terms.Attach(term.ID)
	defer a.Detach()
	p.emit(t, "bye")
	recv(t, a.Output)
	p.exit(3)
	waitClosed(t, a.Output)
	got := waitStatus(t, f.terms, term.ID, domain.TerminalExited)
	if got.ExitCode != 3 {
		t.Fatalf("exit code = %d, want 3", got.ExitCode)
	}
	if _, _, closed := p.snapshot(); !closed {
		t.Fatal("pty not released after exit")
	}

	late, err := f.terms.Attach(term.ID)
	if err != nil {
		t.Fatalf("Attach after exit: %v", err)
	}
	if string(late.Scrollback) != "bye" {
		t.Fatalf("scrollback = %q", late.Scrollback)
	}
	waitClosed(t, late.Output)
	late.Detach()

	if err := f.terms.Write(term.ID, []byte("x")); !errors.Is(err, domain.ErrTerminalExited) {
		t.Fatalf("write after exit err = %v", err)
	}
	if err := f.terms.Resize(term.ID, 10, 10); !errors.Is(err, domain.ErrTerminalExited) {
		t.Fatalf("resize after exit err = %v", err)
	}
	if err := f.terms.Close(term.ID); err != nil {
		t.Fatalf("Close exited terminal: %v", err)
	}
}

type failingWaitPTY struct{ *fakePTY }

func (failingWaitPTY) Wait() (int, error) { return 0, errors.New("wait failed") }

type failingWaitFactory struct{ p *fakePTY }

func (f failingWaitFactory) Start(PTYSpec) (PTY, error) { return failingWaitPTY{f.p}, nil }

func TestTerminalWaitErrorRecordsMinusOne(t *testing.T) {
	p := newFakePTY()
	f := newTermFixture(t, func(c *TerminalsConfig) { c.PTYs = failingWaitFactory{p} })
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_ = p.outW.Close()
	if got := waitStatus(t, f.terms, term.ID, domain.TerminalExited); got.ExitCode != -1 {
		t.Fatalf("exit code = %d, want -1", got.ExitCode)
	}
}

func TestWriteAndResizeReachPTY(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, p := f.factory.last(t)
	if err := f.terms.Write(term.ID, []byte("ls\r")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := f.terms.Resize(term.ID, 100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	input, sizes, _ := p.snapshot()
	if input != "ls\r" {
		t.Fatalf("input = %q", input)
	}
	if len(sizes) != 1 || sizes[0] != [2]uint16{100, 30} {
		t.Fatalf("sizes = %v", sizes)
	}
}

func TestResizeRejectsZero(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	for _, sz := range [][2]uint16{{0, 10}, {10, 0}} {
		if err := f.terms.Resize(term.ID, sz[0], sz[1]); !errors.Is(err, ErrInvalidTerminalSize) {
			t.Fatalf("Resize(%v) err = %v", sz, err)
		}
	}
}

func TestUnknownTerminal(t *testing.T) {
	f := newTermFixture(t)
	if _, err := f.terms.Get("x"); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("Get err = %v", err)
	}
	if _, err := f.terms.Attach("x"); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("Attach err = %v", err)
	}
	if err := f.terms.Write("x", nil); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("Write err = %v", err)
	}
	if err := f.terms.Resize("x", 1, 1); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("Resize err = %v", err)
	}
	if err := f.terms.Close("x"); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("Close err = %v", err)
	}
}

func TestCloseTerminalKillsAndForgets(t *testing.T) {
	f := newTermFixture(t)
	term, _ := f.terms.Open(context.Background(), OpenTerminal{})
	other, _ := f.terms.Open(context.Background(), OpenTerminal{})
	_, otherPTY := f.factory.last(t)
	p := f.factory.ptys[0]
	a, _ := f.terms.Attach(term.ID)
	if err := f.terms.Close(term.ID); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, _, closed := p.snapshot(); !closed {
		t.Fatal("pty not closed")
	}
	waitClosed(t, a.Output)
	a.Detach()
	if _, err := f.terms.Get(term.ID); !errors.Is(err, ErrTerminalNotFound) {
		t.Fatalf("Get after close err = %v", err)
	}
	if got := f.terms.List(); len(got) != 1 || got[0].ID != other.ID {
		t.Fatalf("list = %+v", got)
	}
	if _, _, closed := otherPTY.snapshot(); closed {
		t.Fatal("other pty closed")
	}
}

func TestCloseAllKillsEveryTerminal(t *testing.T) {
	f := newTermFixture(t)
	for range 2 {
		_, _ = f.terms.Open(context.Background(), OpenTerminal{})
	}
	f.terms.CloseAll()
	for i, p := range f.factory.ptys {
		if _, _, closed := p.snapshot(); !closed {
			t.Fatalf("pty %d not closed", i)
		}
	}
	if got := f.terms.List(); len(got) != 0 {
		t.Fatalf("list = %+v", got)
	}
}

func TestListTerminalsSameTimeOrderedByID(t *testing.T) {
	ids := []string{"b", "c", "a"}
	f := newTermFixture(t, func(c *TerminalsConfig) {
		c.NewID = func() string { id := ids[0]; ids = ids[1:]; return id }
		c.Now = func() time.Time { return time.Unix(0, 0) }
	})
	for range 3 {
		if _, err := f.terms.Open(context.Background(), OpenTerminal{}); err != nil {
			t.Fatal(err)
		}
	}
	got := f.terms.List()
	if got[0].ID != "a" || got[1].ID != "b" || got[2].ID != "c" {
		t.Fatalf("list = %+v", got)
	}
}

func TestNewTerminalsDefaults(t *testing.T) {
	factory := &fakePTYFactory{}
	terms := NewTerminals(TerminalsConfig{PTYs: factory, Home: "/h"})
	t.Cleanup(terms.CloseAll)
	before := time.Now()
	a, err := terms.Open(context.Background(), OpenTerminal{})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	b, _ := terms.Open(context.Background(), OpenTerminal{})
	if a.ID == "" || a.ID == b.ID {
		t.Fatalf("ids = %q, %q", a.ID, b.ID)
	}
	if a.CreatedAt.Before(before) {
		t.Fatalf("createdAt = %v, before %v", a.CreatedAt, before)
	}
	watch, _ := terms.Attach(a.ID)
	defer watch.Detach()
	chunk := make([]byte, defaultScrollback+10)
	chunk[len(chunk)-1] = 'z'
	go func() { _, _ = factory.ptys[0].outW.Write(chunk) }()
	total := 0
	for total < len(chunk) {
		total += len(recv(t, watch.Output))
	}
	late, _ := terms.Attach(a.ID)
	defer late.Detach()
	if len(late.Scrollback) != defaultScrollback || late.Scrollback[defaultScrollback-1] != 'z' {
		t.Fatalf("scrollback len = %d", len(late.Scrollback))
	}
}

func TestOpenAfterCloseAllFails(t *testing.T) {
	f := newTermFixture(t)
	f.terms.CloseAll()
	if _, err := f.terms.Open(context.Background(), OpenTerminal{}); !errors.Is(err, ErrTerminalsClosed) {
		t.Fatalf("err = %v, want ErrTerminalsClosed", err)
	}
	if len(f.factory.specs) != 0 {
		t.Fatal("pty started after CloseAll")
	}
}

type closingFactory struct {
	terms *Terminals
	p     *fakePTY
}

func (f *closingFactory) Start(PTYSpec) (PTY, error) {
	f.terms.CloseAll()
	return f.p, nil
}

func TestOpenRacingCloseAllKillsTheNewShell(t *testing.T) {
	cf := &closingFactory{p: newFakePTY()}
	f := newTermFixture(t, func(c *TerminalsConfig) { c.PTYs = cf })
	cf.terms = f.terms
	if _, err := f.terms.Open(context.Background(), OpenTerminal{}); !errors.Is(err, ErrTerminalsClosed) {
		t.Fatalf("err = %v, want ErrTerminalsClosed", err)
	}
	if _, _, closed := cf.p.snapshot(); !closed {
		t.Fatal("shell started during shutdown was not killed")
	}
	if got := f.terms.List(); len(got) != 0 {
		t.Fatalf("list = %+v", got)
	}
}
