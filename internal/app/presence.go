package app

import (
	"sync"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// Look is what one open page (a client) says about the owner: which
// session it shows, and whether it is visible and focused.
type Look struct {
	Client  string
	Session domain.SessionID
	Visible bool
	Focused bool
}

// Presence tracks where the single owner is across their open pages, on
// every device: which sessions they are watching right now (no push needed
// for those) and which page they were at last (the one that chimes).
type Presence struct {
	mu      sync.Mutex
	clients map[string]*presenceClient
	tick    uint64
	active  string
	subs    map[chan string]struct{}
}

type presenceClient struct {
	look Look
	// focused orders the clients by when they were last focused; 0 never.
	focused uint64
}

func NewPresence() *Presence {
	return &Presence{clients: map[string]*presenceClient{}, subs: map[chan string]struct{}{}}
}

// Report records a client's look.
func (p *Presence) Report(l Look) {
	if l.Client == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[l.Client]
	if c == nil {
		c = &presenceClient{}
		p.clients[l.Client] = c
	}
	c.look = l
	if l.Focused && l.Visible {
		p.tick++
		c.focused = p.tick
	}
	p.settle()
}

// Leave forgets a client whose page closed.
func (p *Presence) Leave(client string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.clients, client)
	p.settle()
}

// Watching tells whether a focused, visible page shows the session.
func (p *Presence) Watching(id domain.SessionID) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.clients {
		if c.look.Session == id && c.look.Visible && c.look.Focused {
			return true
		}
	}
	return false
}

// Active is the client the owner was at last, "" when none is open.
func (p *Presence) Active() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.active
}

// Subscribe returns a channel that receives the active client whenever it
// changes; a slow reader gets only the latest. stop closes the channel.
func (p *Presence) Subscribe() (updates <-chan string, stop func()) {
	ch := make(chan string, 1)
	p.mu.Lock()
	p.subs[ch] = struct{}{}
	p.mu.Unlock()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			p.mu.Lock()
			delete(p.subs, ch)
			p.mu.Unlock()
			close(ch)
		})
	}
}

// settle picks the active client: the visible one focused last; with none
// visible, the current one while it is open, else the one focused last.
// Callers hold p.mu.
func (p *Presence) settle() {
	next := p.latest(true)
	if next == "" {
		if _, open := p.clients[p.active]; open {
			next = p.active
		} else {
			next = p.latest(false)
		}
	}
	if next == p.active {
		return
	}
	p.active = next
	for ch := range p.subs {
		select {
		case <-ch:
		default:
		}
		ch <- next
	}
}

// latest is the client focused last, among the visible ones if asked.
func (p *Presence) latest(visible bool) string {
	best, at := "", uint64(0)
	for id, c := range p.clients {
		if (visible && !c.look.Visible) || c.focused <= at {
			continue
		}
		best, at = id, c.focused
	}
	return best
}
