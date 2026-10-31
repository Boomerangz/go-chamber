package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
	"github.com/pion/webrtc/v4"
)

type rtcV2Peer struct {
	s               *server
	ctx             context.Context
	cancel          context.CancelFunc
	id              domain.TerminalID
	client          string
	opened          chan struct{}
	mu              sync.Mutex
	control, output *webrtc.DataChannel
	count           int
	link            *v2Link
}

func (p *rtcV2Peer) channel(dc *webrtc.DataChannel) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !dc.Ordered() || dc.MaxPacketLifeTime() != nil || dc.MaxRetransmits() != nil {
		p.cancel()
		return
	}
	switch dc.Label() {
	case "terminal-control-v2":
		if p.control != nil {
			p.cancel()
			return
		}
		p.control = dc
	case "terminal-output-v2":
		if p.output != nil {
			p.cancel()
			return
		}
		p.output = dc
	default:
		p.cancel()
		return
	}
	dc.OnClose(p.cancel)
	dc.OnError(func(error) { p.cancel() })
	dc.OnMessage(func(message webrtc.DataChannelMessage) {
		p.mu.Lock()
		link := p.link
		p.mu.Unlock()
		if link == nil || dc.Label() != "terminal-control-v2" {
			p.cancel()
			return
		}
		link.receive(message.Data, message.IsString)
	})
	dc.OnOpen(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.count++
		if p.count != 2 {
			return
		}
		link, err := p.s.newV2Link(p.ctx, p.id, p.client, func(c terminalV2Control) error {
			data, _ := json.Marshal(c)
			if c.Type == "snapshot" || c.Type == "ready" || c.Type == "prompt" {
				return p.output.SendText(string(data))
			}
			return p.control.SendText(string(data))
		}, func(data []byte) error {
			if p.output.BufferedAmount() > 128<<10 {
				return errors.New("RTC output queue exceeded")
			}
			return p.output.Send(data)
		})
		if err != nil {
			p.cancel()
			return
		}
		p.link = link
		close(p.opened)
		go func() {
			link.run()
			select {
			case <-p.ctx.Done():
			case <-time.After(100 * time.Millisecond):
			}
			p.cancel()
		}()
	})
}
