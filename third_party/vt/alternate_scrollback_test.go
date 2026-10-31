package vt

import "testing"

func TestAlternateScreenDoesNotRetainScrollback(t *testing.T) {
	e := NewEmulator(20, 2)
	defer func() { _ = e.Close() }()
	_, _ = e.WriteString("\x1b[?1049hone\r\ntwo\r\nthree\r\n")
	if n := e.scrs[1].Scrollback().Len(); n != 0 {
		t.Fatalf("alternate scrollback retains %d lines", n)
	}
}
