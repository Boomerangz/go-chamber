// Package terminalscreen implements the terminal display port with x/vt.
package terminalscreen

import (
	"bytes"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
	"github.com/charmbracelet/x/vt"
	"github.com/igorzygin/go-chamber/internal/app"
)

type Factory struct{}

func (Factory) New(cols, rows uint16) app.TerminalScreen { return New(cols, rows) }

// Screen is not concurrently safe; the use case serializes its operations.
type Screen struct {
	prompt              bool
	promptID, commandID uint64
	history             historyLog
	em                  *vt.Emulator
	tracker             *ansi.Parser
	tail                []byte
	pen                 [2]uv.Style
	links               [2]uv.Link
	saved               [2]string
	main                *display
	modes               map[ansi.Mode]bool
	phantom             bool
	printed             bool
	printRune           rune
	margins             [2][2]int
	tabs                []bool
	charsets            [4]string
	locking             string
	single              string
	colors              map[int]string
	// x/vt writes query replies synchronously to an io.Pipe. Drain it even
	// without a browser; a zero-length write is a barrier after each feed.
	replies bytes.Buffer
	barrier chan struct{}
	done    chan struct{}
}

func New(cols, rows uint16) *Screen {
	s := &Screen{em: vt.NewEmulator(int(cols), int(rows)), modes: make(map[ansi.Mode]bool), barrier: make(chan struct{}), done: make(chan struct{})}
	s.margins = [2][2]int{{1, int(rows)}, {1, int(rows)}}
	s.tabs = make([]bool, cols)
	for i := 8; i < len(s.tabs); i += 8 {
		s.tabs[i] = true
	}
	s.charsets = [4]string{"\x1b(B", "\x1b)B", "\x1b*B", "\x1b+B"}
	s.locking = "\x0f"
	s.colors = make(map[int]string)
	s.em.RegisterEscHandler('c', func() bool {
		s.prompt = false
		clear(s.modes)
		s.pen = [2]uv.Style{}
		s.links = [2]uv.Link{}
		s.saved = [2]string{}
		s.main = nil
		s.phantom = false
		s.margins = [2][2]int{{1, s.em.Height()}, {1, s.em.Height()}}
		clear(s.tabs)
		for x := 8; x < len(s.tabs); x += 8 {
			s.tabs[x] = true
		}
		s.charsets = [4]string{"\x1b(B", "\x1b)B", "\x1b*B", "\x1b+B"}
		s.locking = "\x0f"
		s.single = ""
		return false
	})
	s.em.RegisterOscHandler(4, func(data []byte) bool {
		parts := strings.Split(string(data), ";")
		for i := 1; i+1 < len(parts); i += 2 {
			index, err := strconv.Atoi(parts[i])
			if err == nil && index >= 0 && index < 256 && ansi.XParseColor(parts[i+1]) != nil {
				s.colors[index] = fmt.Sprintf("\x1b]4;%d;%s\x1b\\", index, parts[i+1])
			}
		}
		return false
	})
	for _, code := range []int{10, 11, 12} {
		s.em.RegisterOscHandler(code, func(data []byte) bool {
			_, value, ok := strings.Cut(string(data), ";")
			if ok && ansi.XParseColor(value) != nil {
				s.colors[256+code] = fmt.Sprintf("\x1b]%d;%s\x1b\\", code, value)
			}
			return false
		})
	}
	s.history = historyLog{maxLines: 10000, maxBytes: 10 << 20}
	s.em.SetScrollbackSize(10000)
	go func() {
		defer close(s.done)
		buf := make([]byte, 4096)
		for {
			n, err := s.em.Read(buf)
			if err != nil {
				return
			}
			if n == 0 {
				s.barrier <- struct{}{}
				continue
			}
			_, _ = s.replies.Write(buf[:n])
		}
	}()
	s.em.SetCallbacks(vt.Callbacks{
		AltScreen: func(on bool) {
			if on {
				s.pen[1] = s.pen[0]
				s.links[1] = s.links[0]
				s.phantom = false
			} else if s.main != nil {
				s.phantom = s.main.phantom
			}
		},
		EnableMode:  func(m ansi.Mode) { s.modes[m] = true },
		DisableMode: func(m ansi.Mode) { s.modes[m] = false },
	})
	s.em.RegisterCsiHandler('m', func(p ansi.Params) bool { uv.ReadStyle(p, &s.pen[s.index()]); return false })
	s.em.RegisterCsiHandler(ansi.Command('>', 0, 'q'), func(p ansi.Params) bool {
		n, _, _ := p.Param(0, 0)
		if n != 0 {
			return false
		}
		_, _ = s.em.InputPipe().Write([]byte("\x1bP>|xterm.js(6.0.0)\x1b\\"))
		return true
	})
	s.em.RegisterOscHandler(8, func(data []byte) bool { uv.ReadLink(data, &s.links[s.index()]); return false })
	s.em.RegisterOscHandler(133, func(data []byte) bool {
		parts := strings.Split(string(data), ";")
		if len(parts) < 2 {
			return true
		}
		switch parts[1] {
		case "B":
			s.prompt = true
			s.promptID++
		case "C":
			s.commandID++
			s.prompt = false
		case "A", "D":
			s.prompt = false
		}
		return true
	})
	s.em.RegisterCsiHandler('r', func(p ansi.Params) bool {
		top, _, _ := p.Param(0, 1)
		bottom, _, _ := p.Param(1, s.em.Height())
		if top > 0 && top < bottom && bottom <= s.em.Height() {
			s.margins[s.index()] = [2]int{top, bottom}
		}
		return false
	})
	for _, final := range []byte{'h', 'l'} {
		s.em.RegisterCsiHandler(ansi.Command('?', 0, final), func(p ansi.Params) bool {
			for _, param := range p {
				m := param.Param(0)
				if final == 'h' && (m == 47 || m == 1047 || m == 1049) && !s.em.IsAltScreen() {
					s.main = s.capture()
				}
			}
			return false
		})
	}
	s.em.RegisterEscHandler('7', func() bool { s.save(); return false })
	s.em.RegisterCsiHandler('s', func(ansi.Params) bool { s.save(); return false })
	s.em.RegisterEscHandler('8', func() bool { s.restorePen(); return false })
	s.em.RegisterCsiHandler('u', func(ansi.Params) bool { s.restorePen(); return false })
	s.tracker = ansi.NewParser()
	s.tracker.SetHandler(ansi.Handler{
		Print: func(r rune) { s.printed = true; s.printRune = r },
		Execute: func(b byte) {
			if b == 0x0e || b == 0x0f {
				s.locking = string(b)
			}
			if b == '\r' || b == '\n' || b == '\b' || b == '\t' {
				s.phantom = false
			}
		},
		HandleEsc: func(cmd ansi.Cmd) {
			if i := strings.IndexByte("()*+", cmd.Intermediate()); i >= 0 {
				s.charsets[i] = fmt.Sprintf("\x1b%c%c", cmd.Intermediate(), cmd.Final())
			}
			if cmd.Intermediate() == 0 {
				switch cmd.Final() {
				case 'H':
					s.tabs[s.em.CursorPosition().X] = true
				case 'n', 'o', '|', '}', '~':
					s.locking = fmt.Sprintf("\x1b%c", cmd.Final())
				case 'N', 'O':
					s.single = fmt.Sprintf("\x1b%c", cmd.Final())
				}
			}
		},
		HandleCsi: func(c ansi.Cmd, p ansi.Params) {
			if c == 'g' {
				n, _, _ := p.Param(0, 0)
				switch n {
				case 3:
					clear(s.tabs)
				case 0:
					s.tabs[s.em.CursorPosition().X] = false
				}
			}
			if strings.ContainsRune("ABCDEFGHf`adeIZ", rune(c.Final())) {
				s.phantom = false
			}
		},
	})
	_, _ = s.em.WriteString("\x1b[?2026l")
	return s
}

func (s *Screen) index() int {
	if s.em.IsAltScreen() {
		return 1
	}
	return 0
}
func (s *Screen) save() { s.saved[s.index()] = s.cursor() + "\x1b[0m" + s.pen[s.index()].String() }
func (s *Screen) restorePen() {
	// The saved ANSI pen is also restored by x/vt. Recover it for subsequent
	// snapshots without mutating the visible screen.
	p := ansi.NewParser()
	p.SetHandler(ansi.Handler{HandleCsi: func(c ansi.Cmd, params ansi.Params) {
		if c.Final() == 'm' {
			uv.ReadStyle(params, &s.pen[s.index()])
		}
	}})
	p.Parse([]byte(s.saved[s.index()]))
}

func (s *Screen) Feed(data []byte) []byte {
	// Commit complete sequences, with the same codepoint-width policy as the
	// UI's Unicode 11 addon. PTY read boundaries must not segment graphemes.
	for _, b := range data {
		if len(s.tail) < 4<<20 {
			s.tail = append(s.tail, b)
		}
		s.printed = false
		s.tracker.Advance(b)
		if s.tracker.State() == parser.GroundState {
			if s.printed {
				s.print(s.printRune)
			} else {
				wasAlt := s.em.IsAltScreen()
				_, _ = s.em.Write(s.tail)
				if bytes.Equal(s.tail, []byte("\x1bc")) {
					// RIS clears x/vt's known modes too. Keep synchronized
					// output advertised as supported, in its reset state.
					_, _ = s.em.WriteString("\x1b[?2026l")
				}
				if wasAlt && !s.em.IsAltScreen() {
					p := s.em.CursorPosition()
					if p.X >= s.em.Width() || p.Y >= s.em.Height() {
						_, _ = s.em.WriteString(s.position(min(p.X, s.em.Width()-1), min(p.Y, s.em.Height()-1)))
					}
				}
			}
			s.tail = s.tail[:0]
			s.collectHistory()
		}
	}
	return s.collectReplies()
}

func (s *Screen) position(x, y int) string {
	if s.modes[ansi.ModeOrigin] {
		y -= s.margins[s.index()][0] - 1
	}
	return fmt.Sprintf("\x1b[%d;%dH", y+1, x+1)
}

func (s *Screen) print(r rune) {
	s.single = ""
	w := unicode11Width(r)
	p := s.em.CursorPosition()
	if w == 0 {
		x := p.X - 1
		if s.phantom {
			x = s.em.Width() - 1
		}
		for x >= 0 {
			c := s.em.CellAt(x, p.Y)
			if c != nil && c.Width > 0 {
				c = c.Clone()
				c.Content += string(r)
				s.em.SetCell(x, p.Y, c)
				break
			}
			x--
		}
		return
	}
	wrap, known := s.modes[ansi.ModeAutoWrap]
	if !known {
		wrap = true
	}
	if wrap && (s.phantom || p.X+w > s.em.Width()) {
		_, _ = s.em.WriteString("\r\n")
		p = s.em.CursorPosition()
	}
	_, _ = s.em.Write([]byte(string(r)))
	if c := s.em.CellAt(p.X, p.Y); c != nil && c.Width != w {
		c = c.Clone()
		c.Width = w
		s.em.SetCell(p.X, p.Y, c)
	}
	x := p.X + w
	s.phantom = wrap && x >= s.em.Width()
	// Correct widths whose Unicode version differs from x/vt. The common
	// ASCII path already has the right physical cursor and needs no CSI.
	if target := uv.Pos(min(x, s.em.Width()-1), p.Y); s.em.CursorPosition() != target {
		_, _ = s.em.WriteString(s.position(target.X, target.Y))
	}
}

func (s *Screen) collectReplies() []byte {
	_, _ = s.em.InputPipe().Write(nil)
	<-s.barrier
	reply := slices.Clone(s.replies.Bytes())
	s.replies.Reset()
	return reply
}

func (s *Screen) Resize(cols, rows uint16) []byte {
	oldWidth := len(s.tabs)
	next := make([]bool, cols)
	copy(next, s.tabs)
	for x := oldWidth; x < len(next); x++ {
		next[x] = x%8 == 0 && x > 0
	}
	s.tabs = next
	s.em.Resize(int(cols), int(rows))
	s.phantom = false
	if s.main != nil {
		s.main.phantom = false
		s.main.margins = [2]int{1, int(rows)}
	}
	s.margins = [2][2]int{{1, int(rows)}, {1, int(rows)}}
	// x/vt resets stops on every resize; xterm preserves custom stops.
	p := s.em.CursorPosition()
	origin := s.modes[ansi.ModeOrigin]
	_, _ = s.em.WriteString("\x1b[?6l\x1b[3g")
	for x, enabled := range s.tabs {
		if enabled {
			_, _ = fmt.Fprintf(s.em, "\x1b[1;%dH\x1bH", x+1)
		}
	}
	if origin {
		_, _ = s.em.WriteString("\x1b[?6h")
	}
	_, _ = s.em.WriteString(s.position(p.X, p.Y))
	return s.collectReplies()
}

func (s *Screen) cursor() string {
	p := s.em.CursorPosition()
	return fmt.Sprintf("\x1b[%d;%dH", p.Y+1, p.X+1)
}

func (s *Screen) active() string { return s.render(s.capture()) }

func (s *Screen) Snapshot() app.TerminalScreenSnapshot {
	var out strings.Builder
	out.WriteString("\x1bc")
	keysColors := make([]int, 0, len(s.colors))
	for key := range s.colors {
		keysColors = append(keysColors, key)
	}
	slices.Sort(keysColors)
	for _, key := range keysColors {
		out.WriteString(s.colors[key])
	}
	// Restore global tab stops before painting, since installing them moves
	// the cursor and would otherwise clear its pending-wrap state.
	out.WriteString("\x1b[3g")
	for x, enabled := range s.tabs {
		if enabled {
			fmt.Fprintf(&out, "\x1b[1;%dH\x1bH", x+1)
		}
	}
	if s.em.IsAltScreen() {
		if s.main != nil {
			out.WriteString(s.render(s.main))
		}
		out.WriteString("\x1b[?1049h")
	}
	out.WriteString(s.active())
	// Restore input encoding modes after painting, in deterministic order.
	keys := make([]ansi.Mode, 0, len(s.modes))
	for m := range s.modes {
		keys = append(keys, m)
	}
	slices.SortFunc(keys, func(a, b ansi.Mode) int {
		return strings.Compare(fmt.Sprintf("%T:%v", a, a), fmt.Sprintf("%T:%v", b, b))
	})
	for _, m := range keys {
		if m == ansi.DECMode(47) || m == ansi.ModeAltScreen || m == ansi.ModeAltScreenSaveCursor || m == ansi.ModeSaveCursor || m == ansi.ModeOrigin {
			continue
		}
		if s.modes[m] {
			out.WriteString(ansi.SetMode(m))
		} else {
			out.WriteString(ansi.ResetMode(m))
		}
	}
	if s.em.CursorHidden() {
		out.WriteString("\x1b[?25l")
	} else {
		out.WriteString("\x1b[?25h")
	}
	style, blink := s.em.CursorStyle()
	n := int(style)*2 + 1
	if !blink {
		n++
	}
	fmt.Fprintf(&out, "\x1b[%d q", n)
	for _, charset := range s.charsets {
		out.WriteString(charset)
	}
	out.WriteString(s.locking)
	out.WriteString(s.single)
	// Unfinished sequences haven't changed the canonical screen yet. Live
	// output completes them on both sides after this snapshot boundary.
	out.Write(s.tail)
	return app.TerminalScreenSnapshot{Data: []byte(out.String()), Cols: uint16(s.em.Width()), Rows: uint16(s.em.Height()), Prompt: s.prompt, PromptID: s.promptID, CommandID: s.commandID}
}

func (s *Screen) PromptState() (uint64, uint64, bool) { return s.promptID, s.commandID, s.prompt }
func (s *Screen) Input(data []byte) {
	for _, b := range data {
		if b < 32 && b != 8 {
			s.prompt = false
			return
		}
	}
}

func (s *Screen) Close() {
	_ = s.em.InputPipe().(io.Closer).Close()
	<-s.done
	_ = s.em.Close()
}
