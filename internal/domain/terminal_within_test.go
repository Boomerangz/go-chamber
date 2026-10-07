package domain

import (
	"testing"
	"time"
)

func TestTerminalWithin(t *testing.T) {
	cases := []struct {
		cwd, dir string
		want     bool
	}{
		{"/wt/app/fix", "/wt/app/fix", true},
		{"/wt/app/fix/sub/deeper", "/wt/app/fix", true},
		{"/wt/app/fix/", "/wt/app/fix", true},
		{"/wt/app/fix", "/wt/app/fix/", true},
		{"/wt/app/fix-2", "/wt/app/fix", false},
		{"/wt/app", "/wt/app/fix", false},
		{"/other", "/wt/app/fix", false},
		{"/wt/app/fix", "", false},
		{"/wt/app/fix", "relative", false},
	}
	for _, c := range cases {
		term, err := NewTerminal("t1", c.cwd, "/bin/sh", "", time.Time{})
		if err != nil {
			t.Fatal(err)
		}
		if got := term.Within(c.dir); got != c.want {
			t.Errorf("%q within %q = %v, want %v", c.cwd, c.dir, got, c.want)
		}
	}
}

func TestTerminalUnbind(t *testing.T) {
	term, err := NewTerminal("t1", "/src/app", "/bin/sh", "s1", time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if !term.OpenedFor("s1") || term.OpenedFor("s2") || term.OpenedFor("") {
		t.Fatalf("opened for = %+v", term)
	}
	term.Unbind()
	if term.SessionID != "" || term.OpenedFor("s1") || term.Title != "app" || term.Cwd != "/src/app" {
		t.Fatalf("unbound = %+v", term)
	}
}
