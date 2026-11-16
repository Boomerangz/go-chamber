package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeTitleBinary(t *testing.T, output string, exit int) (bin, log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "log")
	bin = filepath.Join(dir, "claude")
	script := "#!/bin/sh\necho \"$@\" > " + log + "\ncat >> " + log + "\nprintf '%s' '" + output + "'\nexit " + string(rune('0'+exit)) + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, log
}

func TestTitlerAsksHaikuAndCleansTheAnswer(t *testing.T) {
	bin, log := fakeTitleBinary(t, "\n**Название сессии: «Имена сессий».**\nlonger rambling", 0)
	got, err := (&Titler{Binary: bin}).Title(context.Background(), "дай сессиям имена", "готово")
	if err != nil || got != "Имена сессий" {
		t.Fatalf("title = %q, %v", got, err)
	}
	sent, _ := os.ReadFile(log)
	for _, want := range []string{"-p", "--model haiku", "--no-session-persistence", "disableAllHooks", "дай сессиям имена", "готово"} {
		if !strings.Contains(string(sent), want) {
			t.Errorf("claude was not given %q:\n%s", want, sent)
		}
	}
}

func TestTitlerFailsOnCLIErrorOrEmptyAnswer(t *testing.T) {
	bin, _ := fakeTitleBinary(t, "", 0)
	if _, err := (&Titler{Binary: bin}).Title(context.Background(), "a", "b"); err == nil {
		t.Fatal("an empty answer is not a title")
	}
	bin, _ = fakeTitleBinary(t, "oops", 1)
	if _, err := (&Titler{Binary: bin}).Title(context.Background(), "a", "b"); err == nil {
		t.Fatal("a failing CLI is not a title")
	}
}
