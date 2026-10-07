package app

import (
	"testing"
	"time"
)

func TestPresenceWatchingNeedsAFocusedVisibleClientOnTheSession(t *testing.T) {
	p := NewPresence()
	if p.Watching("s1") {
		t.Fatal("nobody is there")
	}
	p.Report(Look{Client: "laptop", Session: "s1", Visible: true})
	if p.Watching("s1") {
		t.Fatal("a visible but unfocused window is not watched")
	}
	p.Report(Look{Client: "laptop", Session: "s1", Visible: true, Focused: true})
	if !p.Watching("s1") || p.Watching("s2") {
		t.Fatal("the focused laptop watches s1 only")
	}
	p.Report(Look{Client: "laptop", Session: "s1", Focused: true})
	if p.Watching("s1") {
		t.Fatal("a hidden page watches nothing")
	}
	p.Report(Look{Client: "laptop", Session: "s1", Visible: true, Focused: true})
	p.Leave("laptop")
	if p.Watching("s1") {
		t.Fatal("a closed page watches nothing")
	}
}

func TestPresenceActiveIsWhereTheOwnerLastFocused(t *testing.T) {
	p := NewPresence()
	if p.Active() != "" {
		t.Fatal("no one yet")
	}
	p.Report(Look{Client: "laptop", Visible: true, Focused: true})
	p.Report(Look{Client: "phone", Visible: true})
	if p.Active() != "laptop" {
		t.Fatalf("active = %q", p.Active())
	}
	// The owner picks up the phone; the laptop stays visible but loses focus.
	p.Report(Look{Client: "phone", Visible: true, Focused: true})
	p.Report(Look{Client: "laptop", Visible: true})
	if p.Active() != "phone" {
		t.Fatalf("active = %q", p.Active())
	}
	// The phone is locked: the laptop, last focused before, takes over.
	p.Report(Look{Client: "phone"})
	if p.Active() != "laptop" {
		t.Fatalf("after the phone hid: %q", p.Active())
	}
	// Every page hidden: the last one stays, there is no better guess.
	p.Report(Look{Client: "laptop"})
	if p.Active() != "laptop" {
		t.Fatalf("all hidden: %q", p.Active())
	}
	p.Report(Look{Client: "phone", Visible: true, Focused: true})
	p.Leave("phone")
	if p.Active() != "laptop" {
		t.Fatalf("after the phone left: %q", p.Active())
	}
	p.Leave("laptop")
	if p.Active() != "" {
		t.Fatalf("everyone left: %q", p.Active())
	}
}

func TestPresenceTellsSubscribersTheLatestActiveClient(t *testing.T) {
	p := NewPresence()
	updates, stop := p.Subscribe()
	p.Report(Look{Client: "laptop", Visible: true, Focused: true})
	p.Report(Look{Client: "phone", Visible: true, Focused: true})
	// Only the latest matters to a slow reader.
	select {
	case got := <-updates:
		if got != "phone" {
			t.Fatalf("got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no update")
	}
	p.Report(Look{Client: "phone", Visible: true, Focused: true, Session: "s2"})
	select {
	case got := <-updates:
		t.Fatalf("unchanged active sent %q", got)
	default:
	}
	stop()
	p.Report(Look{Client: "laptop", Visible: true, Focused: true})
	select {
	case got, ok := <-updates:
		if ok {
			t.Fatalf("stopped subscriber got %q", got)
		}
	default:
	}
}
