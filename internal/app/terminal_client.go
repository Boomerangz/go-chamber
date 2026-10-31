package app

import (
	"errors"
	"sync"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var (
	ErrTerminalObserver       = errors.New("terminal is controlled by another client")
	ErrTerminalClient         = errors.New("invalid terminal client")
	ErrTerminalInputOffset    = errors.New("terminal input offset is ahead of the written prefix")
	ErrTerminalInputUncertain = errors.New("terminal input write is uncertain; pending input must be cancelled")
	ErrTerminalInputTooLarge  = errors.New("terminal input exceeds 64 KiB")
)

// TerminalClientState acknowledges bytes written to the PTY, not commands
// executed by the shell. Epoch changes cancel every unacknowledged suffix.
type TerminalClientState struct {
	Owner     bool   `json:"owner"`
	Epoch     uint64 `json:"epoch"`
	Written   uint64 `json:"written"`
	Uncertain bool   `json:"uncertain"`
}

type terminalInputPrefix struct {
	written   uint64
	uncertain bool
}

// terminalClients is guarded by runningTerminal.inputMu, the same lock that
// serializes PTY writes, resize and control transfer.
type terminalClients struct {
	owner    string
	epoch    uint64
	prefixes map[string]*terminalInputPrefix
	views    map[*TerminalClientAttachment]struct{}
}

type TerminalClientAttachment struct {
	*TerminalAttachment
	State   TerminalClientState
	Updates <-chan TerminalClientState
	client  string
	updates chan TerminalClientState
	close   func()
	once    sync.Once
}

func (a *TerminalClientAttachment) Detach() { a.once.Do(a.close) }

func (rt *runningTerminal) clientState(client string) TerminalClientState {
	p := rt.inputState.prefixes[client]
	return TerminalClientState{Owner: rt.inputState.owner == client, Epoch: rt.inputState.epoch, Written: p.written, Uncertain: p.uncertain}
}

func (t *Terminals) AttachClient(id domain.TerminalID, client string) (*TerminalClientAttachment, error) {
	if len(client) == 0 || len(client) > 128 {
		return nil, ErrTerminalClient
	}
	rt, err := t.find(id)
	if err != nil {
		return nil, err
	}
	if rt.screen == nil {
		return nil, errors.New("terminal screen is not enabled")
	}
	rt.inputMu.Lock()
	defer rt.inputMu.Unlock()
	if rt.inputState.prefixes == nil {
		rt.inputState.prefixes = make(map[string]*terminalInputPrefix)
		rt.inputState.views = make(map[*TerminalClientAttachment]struct{})
		rt.inputState.owner = client
		rt.inputState.epoch = 1
	}
	if rt.inputState.prefixes[client] == nil {
		rt.inputState.prefixes[client] = &terminalInputPrefix{}
	}
	updates := make(chan TerminalClientState, 1)
	a := &TerminalClientAttachment{TerminalAttachment: rt.attach(true), State: rt.clientState(client), client: client, Updates: updates, updates: updates}
	rt.inputState.views[a] = struct{}{}
	a.close = func() {
		a.TerminalAttachment.Detach()
		rt.inputMu.Lock()
		delete(rt.inputState.views, a)
		close(updates)
		rt.inputMu.Unlock()
	}
	return a, nil
}

func (t *Terminals) TakeControl(id domain.TerminalID, client string) (TerminalClientState, error) {
	rt, err := t.running(id)
	if err != nil {
		return TerminalClientState{}, err
	}
	rt.inputMu.Lock()
	defer rt.inputMu.Unlock()
	p := rt.inputState.prefixes[client]
	if p == nil {
		return TerminalClientState{}, ErrTerminalClient
	}
	rt.inputState.owner = client
	rt.inputState.epoch++
	p.uncertain = false
	for view := range rt.inputState.views {
		// Only the latest epoch matters. Never wait for a slow observer while
		// handing control to another client or recording a written prefix.
		select {
		case <-view.updates:
		default:
		}
		view.updates <- rt.clientState(view.client)
	}
	return rt.clientState(client), nil
}

func (t *Terminals) WriteInput(id domain.TerminalID, client string, epoch, offset uint64, data []byte) (TerminalClientState, error) {
	rt, err := t.running(id)
	if err != nil {
		return TerminalClientState{}, err
	}
	rt.inputMu.Lock()
	defer rt.inputMu.Unlock()
	p := rt.inputState.prefixes[client]
	if p == nil {
		return TerminalClientState{}, ErrTerminalClient
	}
	state := func(err error) (TerminalClientState, error) { return rt.clientState(client), err }
	if rt.inputState.owner != client || rt.inputState.epoch != epoch {
		return state(ErrTerminalObserver)
	}
	if len(data) > 64<<10 {
		return state(ErrTerminalInputTooLarge)
	}
	if p.uncertain {
		return state(ErrTerminalInputUncertain)
	}
	if offset > p.written {
		return state(ErrTerminalInputOffset)
	}
	skip := p.written - offset
	if skip >= uint64(len(data)) {
		return state(nil)
	}
	data = data[int(skip):]
	rt.mu.Lock()
	if screen, ok := rt.screen.(interface{ Input([]byte) }); ok {
		screen.Input(data)
	}
	rt.mu.Unlock()
	n, err := rt.pty.Write(data)
	if n < 0 || n > len(data) {
		n = 0
		err = ErrTerminalInputUncertain
	}
	p.written += uint64(n)
	if err != nil || n == 0 {
		p.uncertain = true
		return state(ErrTerminalInputUncertain)
	}
	return state(nil)
}

func (t *Terminals) ResizeClient(id domain.TerminalID, client string, epoch uint64, cols, rows uint16) error {
	if cols == 0 || rows == 0 {
		return ErrInvalidTerminalSize
	}
	rt, err := t.running(id)
	if err != nil {
		return err
	}
	rt.inputMu.Lock()
	defer rt.inputMu.Unlock()
	if rt.inputState.prefixes[client] == nil {
		return ErrTerminalClient
	}
	if rt.inputState.owner != client || rt.inputState.epoch != epoch {
		return ErrTerminalObserver
	}
	return rt.resize(cols, rows)
}
