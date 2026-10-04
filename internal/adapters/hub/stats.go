package hub

import "time"

// Stats describes delivery work since server startup. Timings cover the hub's
// lock wait and persistent Append calls, rather than agent/model execution.
type Stats struct {
	Published      uint64  `json:"published"`
	PersistCalls   uint64  `json:"persistCalls"`
	PersistErrors  uint64  `json:"persistErrors"`
	PersistMeanMs  float64 `json:"persistMeanMs"`
	PersistMaxMs   float64 `json:"persistMaxMs"`
	LockWaitMeanMs float64 `json:"lockWaitMeanMs"`
	LockWaitMaxMs  float64 `json:"lockWaitMaxMs"`
}

type timings struct {
	published, calls, errors uint64
	persistTotal, persistMax time.Duration
	waitTotal, waitMax       time.Duration
}

func (h *Hub) Stats() Stats {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.timings
	s := Stats{Published: t.published, PersistCalls: t.calls, PersistErrors: t.errors, PersistMaxMs: float64(t.persistMax) / float64(time.Millisecond), LockWaitMaxMs: float64(t.waitMax) / float64(time.Millisecond)}
	if t.calls > 0 {
		s.PersistMeanMs = float64(t.persistTotal) / float64(time.Millisecond) / float64(t.calls)
	}
	if t.published > 0 {
		s.LockWaitMeanMs = float64(t.waitTotal) / float64(time.Millisecond) / float64(t.published)
	}
	return s
}
