package app

import "testing"

func TestScrollbackKeepsEverythingBelowCapacity(t *testing.T) {
	s := newScrollback(8)
	s.Write([]byte("ab"))
	s.Write([]byte("cde"))
	if got := string(s.Bytes()); got != "abcde" {
		t.Fatalf("bytes = %q", got)
	}
}

func TestScrollbackKeepsTail(t *testing.T) {
	s := newScrollback(5)
	s.Write([]byte("abc"))
	s.Write([]byte("defg"))
	if got := string(s.Bytes()); got != "cdefg" {
		t.Fatalf("bytes = %q, want cdefg", got)
	}
	s.Write([]byte("hi"))
	if got := string(s.Bytes()); got != "efghi" {
		t.Fatalf("bytes = %q, want efghi", got)
	}
}

func TestScrollbackExactlyFull(t *testing.T) {
	s := newScrollback(4)
	s.Write([]byte("ab"))
	s.Write([]byte("cd"))
	if got := string(s.Bytes()); got != "abcd" {
		t.Fatalf("bytes = %q, want abcd", got)
	}
	s.Write([]byte("e"))
	if got := string(s.Bytes()); got != "bcde" {
		t.Fatalf("bytes = %q, want bcde", got)
	}
}

func TestScrollbackWriteLargerThanCapacity(t *testing.T) {
	s := newScrollback(3)
	s.Write([]byte("x"))
	s.Write([]byte("abcdef"))
	if got := string(s.Bytes()); got != "def" {
		t.Fatalf("bytes = %q, want def", got)
	}
	s.Write([]byte("g"))
	if got := string(s.Bytes()); got != "efg" {
		t.Fatalf("bytes = %q, want efg", got)
	}
}

func TestScrollbackWriteOfCapacitySize(t *testing.T) {
	s := newScrollback(3)
	s.Write([]byte("xy"))
	s.Write([]byte("abc"))
	if got := string(s.Bytes()); got != "abc" {
		t.Fatalf("bytes = %q, want abc", got)
	}
}

func TestScrollbackBytesIsACopy(t *testing.T) {
	s := newScrollback(4)
	s.Write([]byte("ab"))
	b := s.Bytes()
	b[0] = 'z'
	if got := string(s.Bytes()); got != "ab" {
		t.Fatalf("bytes = %q, mutated through copy", got)
	}
}

func TestScrollbackEmpty(t *testing.T) {
	if got := newScrollback(4).Bytes(); len(got) != 0 {
		t.Fatalf("bytes = %q, want empty", got)
	}
}
