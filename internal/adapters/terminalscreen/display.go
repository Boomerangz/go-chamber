package terminalscreen

import (
	"fmt"
	"strings"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

// display captures cells rather than a paint string: a resize while the
// alternate buffer is active must clip the primary buffer, not paint its old
// overlong rows onto the last column of the new grid.
type display struct {
	cells           [][]*uv.Cell
	pos             uv.Position
	pen             uv.Style
	link            uv.Link
	saved           string
	margins         [2]int
	phantom, origin bool
}

func (s *Screen) capture() *display {
	d := &display{pos: s.em.CursorPosition(), pen: s.pen[s.index()], link: s.links[s.index()], saved: s.saved[s.index()], margins: s.margins[s.index()], phantom: s.phantom, origin: s.modes[ansi.ModeOrigin]}
	for y := 0; y < s.em.Height(); y++ {
		row := make([]*uv.Cell, s.em.Width())
		for x := range row {
			if c := s.em.CellAt(x, y); c != nil {
				row[x] = c.Clone()
			}
		}
		d.cells = append(d.cells, row)
	}
	return d
}

func (s *Screen) render(d *display) string {
	var out strings.Builder
	out.WriteString("\x1b[0m\x1b[?6l\x1b[?7l\x1b[H\x1b[2J")
	for y := 0; y < s.em.Height(); y++ {
		fmt.Fprintf(&out, "\x1b[%d;1H", y+1)
		for x := 0; x < s.em.Width(); {
			var c *uv.Cell
			if y < len(d.cells) && x < len(d.cells[y]) {
				c = d.cells[y][x]
			}
			if c == nil || c.Width == 0 || x+c.Width > s.em.Width() {
				out.WriteByte(' ')
				x++
				continue
			}
			if !c.Link.IsZero() {
				out.WriteString(ansi.SetHyperlink(c.Link.URL, c.Link.Params))
			}
			out.WriteString(c.Style.Styled(c.Content))
			if !c.Link.IsZero() {
				out.WriteString(ansi.ResetHyperlink())
			}
			x += max(1, c.Width)
		}
	}
	fmt.Fprintf(&out, "\x1b[%d;%dr", d.margins[0], d.margins[1])
	if d.saved != "" {
		out.WriteString(d.saved)
		out.WriteString("\x1b7")
	}
	p := uv.Pos(min(d.pos.X, s.em.Width()-1), min(d.pos.Y, s.em.Height()-1))
	position := func(x, y int) string {
		if d.origin {
			y -= d.margins[0] - 1
		}
		return fmt.Sprintf("\x1b[%d;%dH", y+1, x+1)
	}
	if d.origin {
		out.WriteString(ansi.SetMode(ansi.ModeOrigin))
	}
	out.WriteString(position(p.X, p.Y))
	out.WriteString("\x1b[0m" + d.pen.String())
	out.WriteString(ansi.SetHyperlink(d.link.URL, d.link.Params))
	out.WriteString("\x1b[?7h")
	if d.phantom && p.Y < len(d.cells) {
		x := p.X
		for x > 0 && d.cells[p.Y][x] != nil && d.cells[p.Y][x].Width == 0 {
			x--
		}
		if c := d.cells[p.Y][x]; c != nil && c.Width > 0 {
			out.WriteString(position(x, p.Y))
			out.WriteString(c.Style.Styled(c.Content))
			out.WriteString("\x1b[0m" + d.pen.String())
		}
	}
	return out.String()
}
