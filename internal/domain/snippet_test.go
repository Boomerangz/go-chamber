package domain

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPlainTextStripsMarkdown(t *testing.T) {
	cases := map[string]struct{ in, want string }{
		"heading":      {"## Раздел 7\nтекст", "Раздел 7 текст"},
		"emphasis":     {"**жирный** и *курсив*, __под__ ~~зачёркнут~~", "жирный и курсив, под зачёркнут"},
		"snake case":   {"call snake_case_name _now_", "call snake_case_name now"},
		"inline code":  {"run `go test` now", "run go test now"},
		"code fence":   {"before\n```go\nfunc f70() {}\n```\nafter", "before func f70() {} after"},
		"tilde fence":  {"~~~\nx\n~~~", "x"},
		"table":        {"| a | b |\n|---|:---:|\n| 70 | 4900 |", "a b 70 4900"},
		"link":         {"see [the docs](https://x.y/z) and ![logo](a.png)", "see the docs and logo"},
		"quote, lists": {"> quoted\n- one\n* two\n+ three\n1. four", "quoted one two three 1. four"},
		"bare bracket": {"a [b] c (d)", "a [b] c (d)"},
		"open link":    {"a [b](unclosed", "a [b](unclosed"},
		"spaces":       {"  a \t\n\n b  ", "a b"},
	}
	for name, c := range cases {
		if got := PlainText(c.in); got != c.want {
			t.Errorf("%s: PlainText(%q) = %q, want %q", name, c.in, got, c.want)
		}
	}
}

func TestSnippetCentresOnTheFirstFullPhrase(t *testing.T) {
	var b strings.Builder
	for i := 1; i <= 80; i++ {
		b.WriteString("| xxx | yyy |\n|---|---|\n")
		if i == 70 {
			b.WriteString("## Раздел 7\n")
		}
		b.WriteString("```go\nfunc f() {}\n```\n")
	}
	text := "Раздел 70 упомянут в начале. " + b.String() + " конец"
	got := Snippet(text, "раздел 7", 60)
	if !strings.Contains(got, "[[Раздел]] [[7]]") {
		t.Fatalf("snippet %q misses the phrase", got)
	}
	if strings.ContainsAny(got, "|`#") {
		t.Fatalf("snippet %q keeps markdown", got)
	}
	plain := strings.NewReplacer("[[", "", "]]", "").Replace(got)
	plain = strings.Trim(plain, "…")
	if n := utf8.RuneCountInString(plain); n > 60 {
		t.Fatalf("snippet %q has %d runes, want at most 60", got, n)
	}
	at := strings.Index(plain, "Раздел 7")
	before := utf8.RuneCountInString(plain[:at])
	after := utf8.RuneCountInString(plain[at+len("Раздел 7"):])
	if before < 15 || after < 15 {
		t.Fatalf("phrase not centred in %q: %d runes before, %d after", got, before, after)
	}
	if !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "…") {
		t.Fatalf("cut snippet %q lacks ellipses", got)
	}
}

func TestSnippetMarksWordsAndFallsBack(t *testing.T) {
	cases := []struct{ text, query, want string }{
		// Every query word marked, as a prefix, wherever it occurs.
		{"Пусть picker теперь uses a portal.", "PORT pick", "Пусть [[picker]] теперь uses a [[portal]]."},
		// No full phrase: the first word hit.
		{"alpha beta gamma", "gamma alpha", "[[alpha]] beta [[gamma]]"},
		// A phrase only as a prefix ("7" of "70") still counts.
		{"раздел 70", "Раздел 7", "[[раздел]] [[70]]"},
		// Nothing found (diacritics folded by the index): the start.
		{"café au lait", "cafe", "café au lait"},
		{"", "x", ""},
		{"text", `"`, "text"},
	}
	for _, c := range cases {
		if got := Snippet(c.text, c.query, 80); got != c.want {
			t.Errorf("Snippet(%q, %q) = %q, want %q", c.text, c.query, got, c.want)
		}
	}
}

func TestSnippetCutsAtWordsNearTheEdges(t *testing.T) {
	text := strings.Repeat("слово ", 30) + "цель " + strings.Repeat("ещё ", 30)
	got := Snippet(text, "цель", 30)
	if !strings.HasPrefix(got, "…слово") || !strings.HasSuffix(got, "ещё…") {
		t.Fatalf("snippet %q not cut at word boundaries", got)
	}
	if !strings.Contains(got, "[[цель]]") {
		t.Fatalf("snippet %q misses the hit", got)
	}
	// A hit at the very start or end keeps that edge without an ellipsis.
	if got := Snippet("цель "+strings.Repeat("ещё ", 30), "цель", 30); !strings.HasPrefix(got, "[[цель]] ещё") || !strings.HasSuffix(got, "…") {
		t.Fatalf("start hit = %q", got)
	}
	if got := Snippet(strings.Repeat("слово ", 30)+"цель", "цель", 30); !strings.HasPrefix(got, "…") || !strings.HasSuffix(got, "[[цель]]") {
		t.Fatalf("end hit = %q", got)
	}
}

func TestSnippetKeepsAWordLongerThanTheWindow(t *testing.T) {
	long := strings.Repeat("я", 50)
	if got := Snippet("a "+long+" b", long[:4], 10); !strings.Contains(got, "[["+long+"]]") {
		t.Fatalf("long word = %q", got)
	}
}
