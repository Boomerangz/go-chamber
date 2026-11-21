package main

import "testing"

func TestFakeTitlesKeepUnrelatedScenariosStable(t *testing.T) {
	for _, tc := range []struct{ prompt, want string }{{"<conversation>\nUser message:\nfork base desktop\n\nAssistant reply:\necho\n</conversation>", "fork base desktop"}, {"<conversation>\nUser message:\nname me desktop\n\nAssistant reply:\necho\n</conversation>", "Generated chat name"}, {"invalid", ""}} {
		if got := fakeTitle(tc.prompt); got != tc.want {
			t.Fatalf("%q != %q", got, tc.want)
		}
	}
}

func TestFakeTitlePreservesPlainMarkdownSeed(t *testing.T) {
	got := fakeTitle("User message:\nPlan the **auth refactor** in `internal/app`\n\nAssistant reply:\necho")
	if got != "Plan the auth refactor in internal/app" {
		t.Fatalf("%q", got)
	}
}
