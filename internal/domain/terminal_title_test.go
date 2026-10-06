package domain

import "testing"

func TestUniqueTitleNumbersRepeats(t *testing.T) {
	cases := []struct {
		base  string
		taken []string
		want  string
	}{
		{"repo", nil, "repo"},
		{"repo", []string{"other"}, "repo"},
		{"repo", []string{"repo"}, "repo 2"},
		{"repo", []string{"repo", "repo 2"}, "repo 3"},
		{"repo", []string{"repo", "repo 3"}, "repo 2"},
		{"repo", []string{"repo 2"}, "repo"},
	}
	for _, c := range cases {
		if got := UniqueTitle(c.base, c.taken); got != c.want {
			t.Errorf("UniqueTitle(%q, %v) = %q, want %q", c.base, c.taken, got, c.want)
		}
	}
}
