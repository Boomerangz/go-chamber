package httpapi

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type shortV2Input struct {
	terminalV2Service
	data     []byte
	fail     bool
	takeover bool
}

func (s *shortV2Input) WriteInput(_ domain.TerminalID, _ string, epoch, offset uint64, data []byte) (app.TerminalClientState, error) {
	if s.takeover && len(s.data) > 0 {
		return app.TerminalClientState{Owner: false, Epoch: epoch + 1, Written: uint64(len(s.data))}, app.ErrTerminalObserver
	}
	if offset != uint64(len(s.data)) {
		panic("input offset skipped a short-written prefix")
	}
	n := min(3, len(data))
	s.data = append(s.data, data[:n]...)
	state := app.TerminalClientState{Owner: true, Epoch: epoch, Written: uint64(len(s.data))}
	if s.fail {
		state.Uncertain = true
		return state, app.ErrTerminalInputUncertain
	}
	return state, nil
}

func TestV2StopsShortWriteContinuationOnTakeoverOrBrokenACK(t *testing.T) {
	for _, takeover := range []bool{false, true} {
		s := &shortV2Input{takeover: takeover}
		var last terminalV2Control
		cancelled := false
		link := &v2Link{service: s, cancel: func() { cancelled = true }, control: func(c terminalV2Control) error {
			last = c
			if !takeover {
				return context.Canceled
			}
			return nil
		}}
		link.receive(inputV2(1, 0, "abcdefghi"), false)
		if string(s.data) != "abc" {
			t.Fatalf("continued after control/transport loss: %q", s.data)
		}
		if takeover && (last.Owner || last.Epoch != 2) {
			t.Fatalf("takeover ACK: %+v", last)
		}
		if !takeover && !cancelled {
			t.Fatal("broken ACK did not cancel transport")
		}
	}
}

func TestV2CompletesShortInputWritesBeforeReadingAnotherFrame(t *testing.T) {
	for _, fail := range []bool{false, true} {
		s := &shortV2Input{fail: fail}
		var acknowledgments []terminalV2Control
		_, cancel := context.WithCancel(context.Background())
		defer cancel()
		link := &v2Link{service: s, cancel: cancel, control: func(c terminalV2Control) error { acknowledgments = append(acknowledgments, c); return nil }}
		link.receive(inputV2(1, 0, "abcdefghi"), false)
		if fail {
			if string(s.data) != "abc" || len(acknowledgments) != 1 || !acknowledgments[0].Uncertain || acknowledgments[0].Problem != app.ErrTerminalInputUncertain.Error() {
				t.Fatalf("uncertain write retried: %q %+v", s.data, acknowledgments)
			}
		} else {
			if string(s.data) != "abcdefghi" || len(acknowledgments) != 3 {
				t.Fatalf("short write left a gap: %q %+v", s.data, acknowledgments)
			}
			for i, c := range acknowledgments {
				if c.Written != uint64((i+1)*3) {
					t.Fatal("ACK is not the written prefix")
				}
			}
		}
	}
}
