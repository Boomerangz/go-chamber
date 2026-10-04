package hub

import (
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestConcurrentDeliveryOrdered(t *testing.T) {
	for attempt := 0; attempt < 100; attempt++ {
		h := New()
		sub := h.Subscribe()
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := 0; i < 64; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				h.Publish(domain.Event{SessionID: "s", Type: domain.EventTurnStarted})
			}()
		}
		close(start)
		wg.Wait()
		var prev domain.Seq
		for i := 0; i < 64; i++ {
			ev := <-sub.Events()
			if ev.Seq != prev+1 {
				sub.Close()
				t.Fatalf("delivery reordered seq: %d followed by %d", prev, ev.Seq)
			}
			prev = ev.Seq
		}
		sub.Close()
	}
}
