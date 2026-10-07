package domain

import (
	"regexp"
	"strings"
	"unicode"
)

// Search snippets show message text as read, not as written: markdown
// syntax is dropped and the window is centred on the match.

var (
	mdLink    = regexp.MustCompile(`!?\[([^\]\n]*)\]\([^)\n]*\)`)
	mdHeading = regexp.MustCompile(`^#{1,6}\s+`)
	mdBullet  = regexp.MustCompile(`^[-*+]\s+`)
	// mdRule is a table's header rule or a horizontal rule.
	mdRule = regexp.MustCompile(`^\|?[\s:|-]*-[\s:|-]*$`)
)

// PlainText is markdown text without its syntax: code fences, table pipes
// and rules, headings, quotes, bullets, emphasis, inline code and link
// targets go; whitespace collapses to single spaces.
func PlainText(md string) string {
	lines := strings.Split(md, "\n")
	kept := lines[:0]
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") || mdRule.MatchString(line) {
			continue
		}
		line = strings.TrimSpace(strings.TrimPrefix(line, ">"))
		line = mdHeading.ReplaceAllString(line, "")
		line = mdBullet.ReplaceAllString(line, "")
		kept = append(kept, strings.ReplaceAll(line, "|", " "))
	}
	text := mdLink.ReplaceAllString(strings.Join(kept, " "), "$1")
	text = strings.NewReplacer("`", "", "~~", "").Replace(text)
	return strings.Join(strings.Fields(stripEmphasis(text)), " ")
}

// stripEmphasis drops runs of * and _ unless they sit inside a word, as in
// snake_case or 2*3.
func stripEmphasis(s string) string {
	runes := []rune(s)
	var b strings.Builder
	for i := 0; i < len(runes); {
		r := runes[i]
		if r != '*' && r != '_' {
			b.WriteRune(r)
			i++
			continue
		}
		j := i
		for j < len(runes) && runes[j] == r {
			j++
		}
		inside := i > 0 && j < len(runes) && isWordRune(runes[i-1]) && isWordRune(runes[j])
		if inside {
			b.WriteString(string(runes[i:j]))
		}
		i = j
	}
	return b.String()
}

func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r)
}

// token is a word of a text: runes [start, end), lowercased.
type token struct {
	start, end int
	lower      string
}

func tokenize(runes []rune) []token {
	var toks []token
	for i := 0; i < len(runes); {
		if !isWordRune(runes[i]) {
			i++
			continue
		}
		j := i
		for j < len(runes) && isWordRune(runes[j]) {
			j++
		}
		toks = append(toks, token{start: i, end: j, lower: strings.ToLower(string(runes[i:j]))})
		i = j
	}
	return toks
}

// Snippet is about width runes of the plain text of md around the first
// match of query, with every word matching a query word (as a prefix)
// wrapped in [[ and ]], and … where the text was cut. The window centres on
// the first occurrence of the whole query as a phrase, else of the phrase
// with its words as prefixes, else of any query word; with no match it
// shows the start.
func Snippet(md, query string, width int) string {
	runes := []rune(PlainText(md))
	toks := tokenize(runes)
	var words []string
	for _, q := range tokenize([]rune(query)) {
		words = append(words, q.lower)
	}
	from, to := findHit(toks, words)
	start, end := window(runes, from, to, width)
	var b strings.Builder
	if start > 0 {
		b.WriteString("…")
	}
	at := start
	for _, t := range toks {
		if t.start < start || t.end > end || !matchesAny(t.lower, words) {
			continue
		}
		b.WriteString(string(runes[at:t.start]) + "[[" + string(runes[t.start:t.end]) + "]]")
		at = t.end
	}
	b.WriteString(string(runes[at:end]))
	if end < len(runes) {
		b.WriteString("…")
	}
	return b.String()
}

func matchesAny(word string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(word, p) {
			return true
		}
	}
	return false
}

// findHit returns the runes [from, to) of the best match of words in toks,
// or 0, 0 when there is none.
func findHit(toks []token, words []string) (from, to int) {
	if len(words) == 0 {
		return 0, 0
	}
	exact := func(t token, w string) bool { return t.lower == w }
	prefix := func(t token, w string) bool { return strings.HasPrefix(t.lower, w) }
	for _, same := range []func(token, string) bool{exact, prefix} {
		for i := 0; i+len(words) <= len(toks); i++ {
			if phraseAt(toks[i:i+len(words)], words, same) {
				return toks[i].start, toks[i+len(words)-1].end
			}
		}
	}
	for _, t := range toks {
		if matchesAny(t.lower, words) {
			return t.start, t.end
		}
	}
	return 0, 0
}

func phraseAt(toks []token, words []string, same func(token, string) bool) bool {
	for k, w := range words {
		if !same(toks[k], w) {
			return false
		}
	}
	return true
}

// window picks about width runes around the hit [from, to), cut between
// words; the hit itself is always kept whole.
func window(runes []rune, from, to, width int) (start, end int) {
	n := len(runes)
	if n <= width {
		return 0, n
	}
	start = max(0, min(n-width, (from+to)/2-width/2))
	end = start + width
	if to-from >= width {
		start, end = from, to
	}
	// Don't cut a word in half: drop its piece instead.
	if start > 0 && isWordRune(runes[start-1]) {
		for start < from && isWordRune(runes[start]) {
			start++
		}
	}
	if end < n && isWordRune(runes[end]) {
		for end > to && isWordRune(runes[end-1]) {
			end--
		}
	}
	for start < from && runes[start] == ' ' {
		start++
	}
	for end > to && runes[end-1] == ' ' {
		end--
	}
	return start, end
}
