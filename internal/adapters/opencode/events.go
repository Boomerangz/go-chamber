package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (s *server) openEvents(_ context.Context) (io.ReadCloser, error) {
	r, err := http.NewRequestWithContext(s.ctx, http.MethodGet, s.base+"/global/event", nil)
	if err != nil {
		return nil, err
	}
	r.SetBasicAuth("opencode", s.password)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 15 * time.Second
	client := &http.Client{Transport: transport}
	resp, err := client.Do(r)
	if err != nil {
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("opencode: subscribe: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		transport.CloseIdleConnections()
		return nil, fmt.Errorf("opencode: event stream HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}
func (s *server) readEvents(body io.ReadCloser) {
	for {
		scanner := bufio.NewScanner(body)
		scanner.Buffer(make([]byte, 4096), 4<<20)
		var data strings.Builder
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if data.Len() > 0 {
					s.dispatch([]byte(data.String()))
					data.Reset()
				}
				continue
			}
			if value, ok := strings.CutPrefix(line, "data:"); ok {
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimPrefix(value, " "))
			}
		}
		_ = body.Close()
		if s.ctx.Err() != nil {
			return
		}
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			timer := time.NewTimer(time.Duration(attempt+1) * 100 * time.Millisecond)
			select {
			case <-s.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			body, err = s.openEvents(s.ctx)
			if err == nil {
				break
			}
		}
		if err != nil {
			s.stop()
			return
		}
		// Subscribe first, then recover the gap while incoming events buffer.
		s.mu.Lock()
		all := make([]*Runtime, 0, len(s.runtimes))
		for _, rt := range s.runtimes {
			all = append(all, rt)
		}
		s.mu.Unlock()
		for _, rt := range all {
			if err := rt.reconcile(s.ctx, false); err != nil {
				_ = rt.Close()
			}
		}
	}
}
func (s *server) dispatch(raw []byte) {
	var env envelope
	if json.Unmarshal(raw, &env) != nil {
		return
	}
	ev := env.Payload
	var p struct {
		SessionID string      `json:"sessionID"`
		Info      sessionInfo `json:"info"`
		Part      part        `json:"part"`
	}
	if json.Unmarshal(ev.Properties, &p) != nil {
		return
	}
	id := p.SessionID
	if id == "" {
		id = p.Part.SessionID
	}
	if id == "" {
		id = p.Info.ID
	}
	if ev.Type == "message.updated" {
		var props struct {
			Info message `json:"info"`
		}
		_ = json.Unmarshal(ev.Properties, &props)
		id = props.Info.SessionID
	}
	s.mu.Lock()
	rt := s.runtimes[id]
	if ev.Type == "session.created" && p.Info.ParentID != "" {
		parent := s.runtimes[p.Info.ParentID]
		if parent != nil && parent.cwd == env.Directory {
			if _, ok := s.orphans[p.Info.ID]; !ok {
				s.orphans[p.Info.ID] = nil
			}
			s.mu.Unlock()
			parent.child(p.Info)
			return
		}
	}
	if rt == nil {
		if events, known := s.orphans[id]; known && len(events) < 256 {
			s.orphans[id] = append(events, ev)
		}
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	if env.Directory != "" && env.Directory != rt.cwd {
		return
	}
	rt.handle(ev)
}
