package app

import (
	"context"
	"slices"
	"testing"
)

func TestOpenTerminalNumbersRepeatedFolderNames(t *testing.T) {
	f := newTermFixture(t)
	var titles []string
	for range 3 {
		term, err := f.terms.Open(context.Background(), OpenTerminal{Cwd: "/srv/repo"})
		if err != nil {
			t.Fatal(err)
		}
		titles = append(titles, term.Title)
	}
	if want := []string{"repo", "repo 2", "repo 3"}; !slices.Equal(titles, want) {
		t.Fatalf("titles = %v, want %v", titles, want)
	}
	if got := f.terms.List(); got[1].Title != "repo 2" {
		t.Fatalf("listed title = %q", got[1].Title)
	}
}
