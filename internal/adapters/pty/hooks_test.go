package pty

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

func TestBashHooksAreLocalAndPreserveUserProfile(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, ".bash_profile")
	const content = "export GC_PROFILE_TEST=loaded\nPROMPT_COMMAND=':'\n"
	if err := os.WriteFile(profile, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	args, env, cleanup, err := shellHooks(app.PTYSpec{Shell: "/bin/bash", PromptHooks: true})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	cmd := exec.Command("/bin/bash", args...)
	cmd.Env = append(os.Environ(), append(env, "HOME="+home)...)
	cmd.Stdin = strings.NewReader("printf 'profile:%s\\n' \"$GC_PROFILE_TEST\"\nexit\n")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bash: %v %s", err, output)
	}
	if !strings.Contains(string(output), "profile:loaded") || !strings.Contains(string(output), "133;A") {
		t.Fatalf("hooks missing: %q", output)
	}
	got, _ := os.ReadFile(profile)
	if string(got) != content {
		t.Fatal("user profile modified")
	}
}

func TestOtherShellAndDisabledHooksKeepLoginArguments(t *testing.T) {
	for _, spec := range []app.PTYSpec{{Shell: "/bin/sh", PromptHooks: true}, {Shell: "/bin/bash"}} {
		args, env, cleanup, err := shellHooks(spec)
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup()
		if len(args) != 1 || args[0] != "-l" || len(env) != 0 {
			t.Fatalf("unexpected hooks: %v %v", args, env)
		}
	}
}

func TestZshHooksSourceOriginalDotfilesAndRestoreZdotdir(t *testing.T) {
	if _, err := os.Stat("/bin/zsh"); err != nil {
		t.Skip("zsh not installed")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ZDOTDIR", home)
	file := filepath.Join(home, ".zshrc")
	const content = "export GC_ZSH_TEST=loaded\n"
	if err := os.WriteFile(file, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	args, env, cleanup, err := shellHooks(app.PTYSpec{Shell: "/bin/zsh", PromptHooks: true})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	cmd := exec.Command("/bin/zsh", append(args, "-i")...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin = strings.NewReader("printf 'zprofile:%s\\n' \"$GC_ZSH_TEST\"\nprintf 'zd:%s\\n' \"$ZDOTDIR\"\nexit\n")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("zsh: %v %q", err, output)
	}
	if !strings.Contains(string(output), "zprofile:loaded") || !strings.Contains(string(output), "zd:"+home) || !strings.Contains(string(output), "133;B") {
		t.Fatalf("hooks missing: %q", output)
	}
	got, _ := os.ReadFile(file)
	if string(got) != content {
		t.Fatal("zsh dotfile modified")
	}
}
