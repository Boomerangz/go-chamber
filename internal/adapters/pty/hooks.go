package pty

import (
	"os"
	"path/filepath"

	"github.com/igorzygin/go-chamber/internal/app"
)

// Startup wrappers are private temporary files. User dotfiles are only sourced,
// never edited. Unsupported shells retain their normal login invocation.
func shellHooks(spec app.PTYSpec) ([]string, []string, func(), error) {
	noop := func() {}
	name := filepath.Base(spec.Shell)
	if !spec.PromptHooks || name != "bash" && name != "zsh" {
		return []string{"-l"}, nil, noop, nil
	}
	dir, err := os.MkdirTemp("", "go-chamber-shell-")
	if err != nil {
		return nil, nil, noop, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	write := func(name, body string) error { return os.WriteFile(filepath.Join(dir, name), []byte(body), 0600) }
	if name == "bash" {
		if err := write("bashrc", bashHooks); err != nil {
			cleanup()
			return nil, nil, noop, err
		}
		return []string{"--rcfile", filepath.Join(dir, "bashrc"), "-i"}, []string{"GO_CHAMBER_TERMINAL=1"}, cleanup, nil
	}
	for _, file := range []string{".zshenv", ".zprofile", ".zshrc", ".zlogin"} {
		body := "ZDOTDIR=$GO_CHAMBER_USER_ZDOTDIR\nif [[ -r $ZDOTDIR/" + file + " ]]; then source \"$ZDOTDIR/" + file + "\"; fi\nexport GO_CHAMBER_USER_ZDOTDIR=${ZDOTDIR:-$HOME}\nZDOTDIR=$GO_CHAMBER_HOOK_DIR\n"
		if file == ".zlogin" {
			body += zshHooks + "\nZDOTDIR=$GO_CHAMBER_USER_ZDOTDIR\n"
		}
		if err := write(file, body); err != nil {
			cleanup()
			return nil, nil, noop, err
		}
	}
	original := os.Getenv("ZDOTDIR")
	if original == "" {
		original = os.Getenv("HOME")
	}
	return []string{"-l"}, []string{"GO_CHAMBER_TERMINAL=1", "GO_CHAMBER_HOOK_DIR=" + dir, "GO_CHAMBER_USER_ZDOTDIR=" + original, "ZDOTDIR=" + dir}, cleanup, nil
}

const bashHooks = `
if [ -r /etc/profile ]; then . /etc/profile; fi
for __gc_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__gc_profile" ]; then . "$__gc_profile"; break; fi
done
__go_chamber_prompt() {
  printf '\033]133;A\007'
  if (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 404 )); then
    case "$PS1" in *'133;B'*) ;; *) PS1="${PS1}"'\[\e]133;B\a\]' ;; esac
  fi
}
if (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 404 )); then PS0=$'\e]133;C\a'"$PS0"; fi
if [[ ${BASH_VERSINFO[0]} -ge 5 ]] && [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
  PROMPT_COMMAND+=(__go_chamber_prompt)
else
  PROMPT_COMMAND="${PROMPT_COMMAND:+${PROMPT_COMMAND}; }__go_chamber_prompt"
fi
`

const zshHooks = `
autoload -Uz add-zsh-hook
__go_chamber_prompt() {
  printf '\033]133;A\007'
  if [[ $PS1 != *'133;B'* ]]; then PS1+=$'%{\e]133;B\a%}'; fi
}
__go_chamber_running() { printf '\033]133;C\007'; }
add-zsh-hook precmd __go_chamber_prompt
add-zsh-hook preexec __go_chamber_running
`
