package claude

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// Titler names a conversation with a one-off Haiku call: headless Claude
// never writes the ai-title that interactive sessions get. It is the
// app.Titler for Claude Code.
type Titler struct {
	// Binary is the CLI to run; defaults to "claude".
	Binary string
}

const titleExcerpt = 600

var titleLabel = regexp.MustCompile(`(?i)^(название|заголовок|title|name)[^:]{0,20}:\s*`)

// Title summarizes the first message and the reply into a short name.
func (t *Titler) Title(ctx context.Context, firstMessage, reply string) (string, error) {
	bin := t.Binary
	if bin == "" {
		bin = "claude"
	}
	// Hooks off: the user's own would run in this call, and a Stop hook can
	// keep a headless call going. No session file: it is not a conversation.
	cmd := exec.CommandContext(ctx, bin, "-p", "--model", "haiku", "--no-session-persistence",
		"--tools", "", "--disable-slash-commands", "--settings", `{"disableAllHooks":true}`)
	cmd.Dir = os.TempDir()
	cmd.Stdin = strings.NewReader("Give a short name (at most 6 words, in the language of the user's message, " +
		"no quotes, no trailing period) to this conversation. Reply with the name only.\n\n" +
		"User message:\n" + clip(firstMessage) + "\n\nAssistant reply:\n" + clip(reply) + "\n")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	title := cleanTitle(string(out))
	if title == "" {
		return "", errors.New("claude returned no title")
	}
	return title, nil
}

func clip(s string) string {
	if r := []rune(s); len(r) > titleExcerpt {
		return string(r[:titleExcerpt])
	}
	return s
}

// cleanTitle keeps the first line of the answer without a label, markdown
// emphasis, quotes or a closing period.
func cleanTitle(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.Trim(strings.TrimSpace(line), "*_`#")
		line = titleLabel.ReplaceAllString(line, "")
		line = strings.Trim(strings.TrimSpace(line), "*_`\"'«»“”.")
		if line != "" {
			return strings.TrimSpace(line)
		}
	}
	return ""
}
