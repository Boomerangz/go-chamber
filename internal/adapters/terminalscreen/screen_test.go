package terminalscreen

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/charmbracelet/x/vt"
)

func TestContractSnapshotsDoNotDependOnPTYReadBoundaries(t *testing.T) {
	data, err := os.ReadFile("testdata/contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Before                       string
		Cols, Rows, ResizeCols, ResizeRows uint16
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			whole := Factory{}.New(tc.Cols, tc.Rows)
			defer whole.Close()
			fragmented := New(tc.Cols, tc.Rows)
			defer fragmented.Close()
			whole.Feed([]byte(tc.Before))
			for _, b := range []byte(tc.Before) {
				fragmented.Feed([]byte{b})
			}
			if tc.ResizeCols > 0 {
				whole.Resize(tc.ResizeCols, tc.ResizeRows)
				fragmented.Resize(tc.ResizeCols, tc.ResizeRows)
			}
			if !bytes.Equal(whole.Snapshot().Data, fragmented.Snapshot().Data) {
				t.Fatal("snapshot depends on PTY read boundaries")
			}
		})
	}
}

func TestSnapshotRestoresScreenAndContinuation(t *testing.T) {
	for _, tc := range []struct{ name, before, after string }{
		{"unicode", "Привет 世界 👋", "!"},
		{"color", "\x1b[31mred\x1b[2;3Hgreen", "more\x1b[0m!"},
		{"cursor", "abcd\x1b[2D", "XY"},
		{"alternate", "shell$ \x1b[?1049h\x1b[2;3HTUI", "!\x1b[?1049lmore"},
		{"saved cursor", "abc\x1b7\x1b[3;4Hxyz", "\x1b8!"},
		{"wrap", strings.Repeat("x", 20), "y"},
		{"split CSI", "abc\x1b[3", "1mred"},
		{"split UTF8", "hello \xe4\xb8", "\x96!"},
		{"clipboard", "ok\x1b]52;c;aGVsbG8=\a", "!"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := New(20, 5)
			defer s.Close()
			s.Feed([]byte(tc.before))
			snap := s.Snapshot()
			if strings.Contains(string(snap.Data), "]52;") {
				t.Fatal("clipboard replayed")
			}
			restored := vt.NewEmulator(20, 5)
			defer func() { _ = restored.Close() }()
			_, _ = restored.Write(snap.Data)
			s.Feed([]byte(tc.after))
			_, _ = restored.WriteString(tc.after)
			if restored.Render() != s.em.Render() || restored.CursorPosition() != s.em.CursorPosition() || restored.IsAltScreen() != s.em.IsAltScreen() {
				t.Fatalf("restore differs:\n%q @%v alt=%v\nwant:\n%q @%v alt=%v", restored.Render(), restored.CursorPosition(), restored.IsAltScreen(), s.em.Render(), s.em.CursorPosition(), s.em.IsAltScreen())
			}
		})
	}
}

func TestQueryAnswersDoNotNeedBrowser(t *testing.T) {
	s := New(20, 5)
	defer s.Close()
	if got := string(s.Feed([]byte("abc\x1b[6n"))); got != "\x1b[1;4R" {
		t.Fatalf("reply = %q", got)
	}
	if got := s.Feed([]byte("!")); len(got) != 0 {
		t.Fatalf("stale reply %q", got)
	}
}

func TestServerAnswersVersionAndSynchronizedOutputQueries(t *testing.T) {
	s := New(20, 5)
	defer s.Close()
	if got := string(s.Feed([]byte("\x1b[>q\x1b[?2026$p"))); got != "\x1bP>|xterm.js(6.0.0)\x1b\\\x1b[?2026;2$y" {
		t.Fatalf("query replies: %q", got)
	}
}

func TestResetClearsObservedModesAndKeepsSynchronizedOutputSupported(t *testing.T) {
	s := New(20, 5)
	defer s.Close()
	s.Feed([]byte("\x1b[?1h\x1b[?2026h"))
	if got := string(s.Feed([]byte("\x1bc\x1b[?2026$p"))); got != "\x1b[?2026;2$y" {
		t.Fatalf("reset mode query: %q", got)
	}
	if snap := string(s.Snapshot().Data); strings.Contains(snap, "\x1b[?1h") || strings.Contains(snap, "\x1b[?2026h") {
		t.Fatal("reset snapshot restores stale modes")
	}
}

func TestPromptMetadataUsesCommandMarkersAndDoesNotReplayHooks(t *testing.T) {
	s := New(20, 5)
	defer s.Close()
	s.Feed([]byte("\x1b]133;A\a$ \x1b]133;B\a"))
	if id, command, active := s.PromptState(); id != 1 || command != 0 || !active {
		t.Fatal(id, command, active)
	}
	s.Input([]byte("\r"))
	if _, _, active := s.PromptState(); active {
		t.Fatal("Enter retained prompt")
	}
	s.Feed([]byte("\x1b]133;C\aoutput\r\n\x1b]133;A\a$ \x1b]133;B\a"))
	snap := s.Snapshot()
	if snap.PromptID != 2 || snap.CommandID != 1 || !snap.Prompt || strings.Contains(string(snap.Data), "]133;") {
		t.Fatalf("prompt snapshot=%+v", snap)
	}
}

func TestResizePreservesScreen(t *testing.T) {
	s := New(20, 5)
	defer s.Close()
	s.Feed([]byte("hello"))
	s.Resize(30, 8)
	snap := s.Snapshot()
	if snap.Cols != 30 || snap.Rows != 8 || !strings.Contains(string(snap.Data), "hello") {
		t.Fatalf("snapshot = %+v", snap)
	}
}

func TestResizeCollectsInBandReply(t *testing.T) {
	s := New(20, 5)
	defer s.Close()
	s.Feed([]byte("\x1b[?2048h"))
	if got := string(s.Resize(30, 8)); !strings.Contains(got, "8;30") {
		t.Fatalf("resize reply = %q", got)
	}
	if got := s.Feed([]byte("!")); len(got) != 0 {
		t.Fatalf("stale resize reply = %q", got)
	}
}

func TestUnicode11IsIndependentOfPTYReadBoundaries(t *testing.T) {
	text := "e\u0301 👩‍💻!"
	for _, split := range []bool{false, true} {
		s := New(40, 5)
		if split {
			for _, b := range []byte(text) {
				s.Feed([]byte{b})
			}
		} else {
			s.Feed([]byte(text))
		}
		if p := s.em.CursorPosition(); p.X != 7 || p.Y != 0 {
			t.Errorf("split=%v cursor=%v, want (7,0)", split, p)
		}
		if got := s.em.CellAt(0, 0).Content; got != "e\u0301" {
			t.Errorf("split=%v combining cell=%q", split, got)
		}
		if got := s.em.CellAt(4, 0).Content; got != "💻" {
			t.Errorf("split=%v laptop cell=%q", split, got)
		}
		s.Close()
	}
}
