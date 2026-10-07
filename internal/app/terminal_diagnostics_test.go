package app

import (
	"context"
	"testing"
)

func TestTerminalDiagnosticsReportsBacklogWithoutOutput(t *testing.T) {
	f := newTermFixture(t)
	term, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "/p"})
	if err != nil {
		t.Fatal(err)
	}
	att, err := f.terms.Attach(term.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer att.Detach()
	other, err := f.terms.Attach(term.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Detach()
	_, p := f.factory.last(t)
	p.emit(t, "private shell output")
	eventually(t, "queued output", func() bool {
		reports := f.terms.Diagnostics()
		return len(reports) == 1 && reports[0].QueuedBytes == 2*len("private shell output")
	})
	p.emit(t, "second chunk")
	eventually(t, "second queued output", func() bool {
		return f.terms.Diagnostics()[0].QueuedBytes == 2*len("private shell outputsecond chunk")
	})
	report := f.terms.Diagnostics()[0]
	if report.ID != term.ID || report.OutputBytes != uint64(len("private shell outputsecond chunk")) || report.Clients != 2 {
		t.Fatalf("report: %+v", report)
	}
	for _, sub := range []*TerminalAttachment{att, other} {
		for got := 0; got < len("private shell outputsecond chunk"); {
			got += len((<-sub.Output).Data)
		}
	}
	eventually(t, "drained queue", func() bool { return f.terms.Diagnostics()[0].QueuedBytes == 0 })
}
