package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var (
	ErrTerminalNotFound    = errors.New("terminal not found")
	ErrInvalidTerminalSize = errors.New("invalid terminal size")
	ErrTerminalsClosed     = errors.New("terminals are shut down")
)

const (
	defaultScrollback = 1 << 20
	defaultCols       = 80
	defaultRows       = 24
	// defaultLagBytes is how much output a client may lag behind before it is
	// dropped; it reattaches and catches up from scrollback. Counted in bytes:
	// a shell printing line by line yields one tiny pty read per line.
	defaultLagBytes = 4 << 20
	// maxOutputFrame caps one coalesced delivery to a client.
	maxOutputFrame = 256 << 10
)

// PTY is a shell process attached to a pseudo-terminal. Read yields output
// until the process exits; Write sends keyboard input.
type PTY interface {
	io.ReadWriter
	Resize(cols, rows uint16) error
	// Wait blocks until the process exits and returns its exit code.
	Wait() (int, error)
	// Close kills the process and releases the terminal; it is also called
	// after the process exited on its own, and may be called twice.
	Close() error
}

type PTYSpec struct {
	Cwd        string
	Shell      string
	Cols, Rows uint16
}

// PTYFactory starts shells in pseudo-terminals.
type PTYFactory interface {
	Start(spec PTYSpec) (PTY, error)
}

// SessionLookup finds a session to open a terminal in its directory.
type SessionLookup interface {
	Get(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
}

type TerminalsConfig struct {
	PTYs     PTYFactory
	Sessions SessionLookup
	// Home is the directory of terminals opened without a cwd.
	Home string
	// Folders optionally checks the shell's folder exists.
	Folders FolderProbe
	// Shell is the program to run; /bin/sh when empty.
	Shell string
	// ScrollbackBytes bounds replayed output per terminal; 1 MiB when zero.
	ScrollbackBytes int
	// LagBytes bounds output queued for one client; 4 MiB when zero.
	LagBytes int
	NewID    func() string
	Now      func() time.Time
}

// OpenTerminal describes a terminal to open. SessionID, when set, opens it in
// that session's directory and takes precedence over Cwd.
type OpenTerminal struct {
	Cwd        string           `json:"cwd"`
	SessionID  domain.SessionID `json:"sessionId"`
	Cols, Rows uint16
}

// Terminals runs interactive shells independently of agent sessions.
type Terminals struct {
	cfg    TerminalsConfig
	mu     sync.Mutex
	terms  map[domain.TerminalID]*runningTerminal
	closed bool
}

func NewTerminals(cfg TerminalsConfig) *Terminals {
	if cfg.Shell == "" {
		cfg.Shell = "/bin/sh"
	}
	if cfg.ScrollbackBytes == 0 {
		cfg.ScrollbackBytes = defaultScrollback
	}
	if cfg.LagBytes == 0 {
		cfg.LagBytes = defaultLagBytes
	}
	if cfg.NewID == nil {
		cfg.NewID = randomID
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Terminals{cfg: cfg, terms: map[domain.TerminalID]*runningTerminal{}}
}

// checkFolder refuses a shell in a folder that is not there; a session's
// folder is one that went away.
func (t *Terminals) checkFolder(cwd string, session bool) error {
	if t.cfg.Folders == nil {
		return nil
	}
	ok, err := t.cfg.Folders.FolderExists(cwd)
	switch {
	case err != nil:
		return err
	case ok:
		return nil
	case session:
		return domain.FolderGone(cwd)
	}
	return domain.NoFolder(cwd)
}

func (t *Terminals) Open(ctx context.Context, req OpenTerminal) (domain.Terminal, error) {
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return domain.Terminal{}, ErrTerminalsClosed
	}
	cwd := req.Cwd
	if req.SessionID != "" {
		s, err := t.cfg.Sessions.Get(ctx, req.SessionID)
		if err != nil {
			return domain.Terminal{}, err
		}
		cwd = s.Cwd
	}
	if cwd == "" {
		cwd = t.cfg.Home
	}
	if err := t.checkFolder(cwd, req.SessionID != ""); err != nil {
		return domain.Terminal{}, err
	}
	id := domain.TerminalID(t.cfg.NewID())
	term, err := domain.NewTerminal(id, cwd, t.cfg.Shell, req.SessionID, t.cfg.Now())
	if err != nil {
		return domain.Terminal{}, err
	}
	cols, rows := req.Cols, req.Rows
	if cols == 0 || rows == 0 {
		cols, rows = defaultCols, defaultRows
	}
	pty, err := t.cfg.PTYs.Start(PTYSpec{Cwd: cwd, Shell: term.Shell, Cols: cols, Rows: rows})
	if err != nil {
		return domain.Terminal{}, fmt.Errorf("start shell: %w", err)
	}
	rt := &runningTerminal{
		term: term, pty: pty,
		scroll:   newScrollback(t.cfg.ScrollbackBytes),
		subs:     map[*subscriber]struct{}{},
		lagBytes: t.cfg.LagBytes,
	}
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		_ = pty.Close()
		return domain.Terminal{}, ErrTerminalsClosed
	}
	taken := make([]string, 0, len(t.terms))
	for _, other := range t.terms {
		taken = append(taken, other.snapshot().Title)
	}
	rt.term.Title = domain.UniqueTitle(term.Title, taken)
	term = rt.term
	t.terms[id] = rt
	t.mu.Unlock()
	go rt.pump()
	return term, nil
}

// List returns all terminals, including exited ones, oldest first.
func (t *Terminals) List() []domain.Terminal {
	t.mu.Lock()
	out := make([]domain.Terminal, 0, len(t.terms))
	for _, rt := range t.terms {
		out = append(out, rt.snapshot())
	}
	t.mu.Unlock()
	slices.SortFunc(out, func(a, b domain.Terminal) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return compareIDs(a.ID, b.ID)
	})
	return out
}

func compareIDs(a, b domain.TerminalID) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func (t *Terminals) Get(id domain.TerminalID) (domain.Terminal, error) {
	rt, err := t.find(id)
	if err != nil {
		return domain.Terminal{}, err
	}
	return rt.snapshot(), nil
}

// TerminalAttachment is one client's view of a terminal: the buffered
// scrollback followed by live output. Output delivers queued output coalesced
// into frames of at most maxOutputFrame bytes. It is closed when the terminal
// exits or is closed, on Detach, or when the client falls too far behind.
type TerminalAttachment struct {
	Scrollback []byte
	Output     <-chan []byte
	detach     func()
	lagged     func() bool
}

func (a *TerminalAttachment) Detach() { a.detach() }

// Lagged reports whether Output was closed because the client fell behind,
// as opposed to the terminal ending; a lagging client should reattach.
func (a *TerminalAttachment) Lagged() bool { return a.lagged() }

func (t *Terminals) Attach(id domain.TerminalID) (*TerminalAttachment, error) {
	rt, err := t.find(id)
	if err != nil {
		return nil, err
	}
	return rt.attach(), nil
}

func (t *Terminals) Write(id domain.TerminalID, p []byte) error {
	rt, err := t.running(id)
	if err != nil {
		return err
	}
	_, err = rt.pty.Write(p)
	return err
}

func (t *Terminals) Resize(id domain.TerminalID, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return fmt.Errorf("%w: %dx%d", ErrInvalidTerminalSize, cols, rows)
	}
	rt, err := t.running(id)
	if err != nil {
		return err
	}
	return rt.pty.Resize(cols, rows)
}

// Close kills the shell and forgets the terminal.
func (t *Terminals) Close(id domain.TerminalID) error {
	t.mu.Lock()
	rt, ok := t.terms[id]
	delete(t.terms, id)
	t.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", ErrTerminalNotFound, id)
	}
	return rt.pty.Close()
}

// CloseAll kills every shell and refuses new ones; used on shutdown.
func (t *Terminals) CloseAll() {
	t.mu.Lock()
	t.closed = true
	terms := t.terms
	t.terms = map[domain.TerminalID]*runningTerminal{}
	t.mu.Unlock()
	for _, rt := range terms {
		_ = rt.pty.Close()
	}
}

func (t *Terminals) find(id domain.TerminalID) (*runningTerminal, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rt, ok := t.terms[id]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrTerminalNotFound, id)
	}
	return rt, nil
}

func (t *Terminals) running(id domain.TerminalID) (*runningTerminal, error) {
	rt, err := t.find(id)
	if err != nil {
		return nil, err
	}
	if rt.snapshot().Status == domain.TerminalExited {
		return nil, fmt.Errorf("%w: %s", domain.ErrTerminalExited, id)
	}
	return rt, nil
}

// subscriber queues output for one client. publish appends to pending; the
// forward goroutine hands it to out in coalesced frames.
type subscriber struct {
	out  chan []byte
	wake chan struct{}
	done chan struct{}
	once sync.Once
	// guarded by runningTerminal.mu
	pending []byte
	held    int // bytes of the frame forward is delivering
	ended   bool
	lagged  bool
}

func (s *subscriber) notify() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// end stops delivery after what is already queued. Callers hold rt.mu.
func (s *subscriber) end() {
	s.ended = true
	s.notify()
}

func (s *subscriber) detach() { s.once.Do(func() { close(s.done) }) }

func (rt *runningTerminal) forward(s *subscriber) {
	defer close(s.out)
	for {
		select {
		case <-s.wake:
		case <-s.done:
			return
		}
		for {
			rt.mu.Lock()
			frame := s.pending
			if len(frame) > maxOutputFrame {
				frame = slices.Clone(frame[:maxOutputFrame])
				s.pending = s.pending[maxOutputFrame:]
			} else {
				s.pending = nil
			}
			s.held = len(frame)
			ended := s.ended
			rt.mu.Unlock()
			if len(frame) == 0 {
				if ended {
					return
				}
				break
			}
			select {
			case s.out <- frame:
			case <-s.done:
				return
			}
			rt.mu.Lock()
			s.held = 0
			rt.mu.Unlock()
		}
	}
}

type runningTerminal struct {
	pty PTY

	mu            sync.Mutex
	term          domain.Terminal
	scroll        *scrollback
	subs          map[*subscriber]struct{}
	lagBytes      int
	outputBytes   uint64
	laggedClients uint64
}

func (rt *runningTerminal) snapshot() domain.Terminal {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return rt.term
}

// pump copies shell output to the scrollback and subscribers until the
// shell exits, then records the exit code.
func (rt *runningTerminal) pump() {
	buf := make([]byte, 32<<10)
	for {
		n, err := rt.pty.Read(buf)
		if n > 0 {
			rt.publish(slices.Clone(buf[:n]))
		}
		if err != nil {
			break
		}
	}
	code, err := rt.pty.Wait()
	if err != nil {
		code = -1
	}
	// Release the terminal device now; the scrollback stays viewable until
	// the terminal is closed.
	_ = rt.pty.Close()
	rt.mu.Lock()
	defer rt.mu.Unlock()
	_ = rt.term.Exit(code)
	for s := range rt.subs {
		s.end()
	}
	clear(rt.subs)
}

func (rt *runningTerminal) publish(chunk []byte) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.outputBytes += uint64(len(chunk))
	rt.scroll.Write(chunk)
	for s := range rt.subs {
		if len(s.pending)+s.held+len(chunk) > rt.lagBytes {
			rt.laggedClients++
			s.lagged = true
			s.pending = nil
			s.end()
			delete(rt.subs, s)
			continue
		}
		s.pending = append(s.pending, chunk...)
		s.notify()
	}
}

func (rt *runningTerminal) attach() *TerminalAttachment {
	s := &subscriber{out: make(chan []byte), wake: make(chan struct{}, 1), done: make(chan struct{})}
	go rt.forward(s)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.term.Status == domain.TerminalExited {
		s.end()
	} else {
		rt.subs[s] = struct{}{}
	}
	return &TerminalAttachment{
		Scrollback: rt.scroll.Bytes(),
		Output:     s.out,
		detach: func() {
			rt.mu.Lock()
			delete(rt.subs, s)
			rt.mu.Unlock()
			s.detach()
		},
		lagged: func() bool {
			rt.mu.Lock()
			defer rt.mu.Unlock()
			return s.lagged
		},
	}
}

// TerminalDiagnostic contains counters only, never shell input or output.
type TerminalDiagnostic struct {
	ID            domain.TerminalID `json:"id"`
	Clients       int               `json:"clients"`
	QueuedBytes   int               `json:"queuedBytes"`
	OutputBytes   uint64            `json:"outputBytes"`
	LaggedClients uint64            `json:"laggedClients"`
}

func (t *Terminals) Diagnostics() []TerminalDiagnostic {
	t.mu.Lock()
	defer t.mu.Unlock()
	reports := make([]TerminalDiagnostic, 0, len(t.terms))
	for id, rt := range t.terms {
		rt.mu.Lock()
		report := TerminalDiagnostic{ID: id, Clients: len(rt.subs), OutputBytes: rt.outputBytes, LaggedClients: rt.laggedClients}
		for sub := range rt.subs {
			report.QueuedBytes += len(sub.pending) + sub.held
		}
		rt.mu.Unlock()
		reports = append(reports, report)
	}
	slices.SortFunc(reports, func(a, b TerminalDiagnostic) int { return compareIDs(a.ID, b.ID) })
	return reports
}
