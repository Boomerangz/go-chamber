package app

// scrollback is a fixed-size ring buffer keeping the latest terminal output,
// replayed to clients that attach after a page reload.
type scrollback struct {
	buf         []byte
	start, size int
}

func newScrollback(capacity int) *scrollback {
	return &scrollback{buf: make([]byte, capacity)}
}

func (s *scrollback) Write(p []byte) {
	c := len(s.buf)
	if len(p) >= c {
		copy(s.buf, p[len(p)-c:])
		s.start, s.size = 0, c
		return
	}
	end := (s.start + s.size) % c
	n := copy(s.buf[end:], p)
	copy(s.buf, p[n:])
	s.size += len(p)
	if s.size > c {
		s.start = (s.start + s.size - c) % c
		s.size = c
	}
}

// Bytes returns a copy of the buffered output, oldest first.
func (s *scrollback) Bytes() []byte {
	out := make([]byte, s.size)
	n := copy(out, s.buf[s.start:min(s.start+s.size, len(s.buf))])
	copy(out[n:], s.buf[:s.size-n])
	return out
}
