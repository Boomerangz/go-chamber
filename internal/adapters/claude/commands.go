package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

const (
	commandsTTL     = time.Minute
	commandsTimeout = 15 * time.Second
)

type cachedCommands struct {
	list []app.Command
	at   time.Time
}

// Commands lists the slash commands and skills Claude offers in cwd. The
// CLI only reports them in answer to the SDK's `initialize` control request,
// so a short-lived process is asked (hooks off, nothing persisted) and the
// answer is cached per folder.
func (f *Factory) Commands(ctx context.Context, _ domain.AgentKind, cwd string) ([]app.Command, error) {
	// ponytail: one lock around the probe serializes folders; per-folder
	// locks if several sessions open at once becomes slow.
	f.commandsMu.Lock()
	defer f.commandsMu.Unlock()
	if c, ok := f.commands[cwd]; ok && time.Since(c.at) < commandsTTL {
		return c.list, nil
	}
	list, err := f.probeCommands(ctx, cwd)
	if err != nil {
		return nil, err
	}
	if f.commands == nil {
		f.commands = map[string]cachedCommands{}
	}
	f.commands[cwd] = cachedCommands{list: list, at: time.Now()}
	return list, nil
}

func (f *Factory) probeCommands(ctx context.Context, cwd string) ([]app.Command, error) {
	ctx, cancel := context.WithTimeout(ctx, commandsTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, f.binary(),
		"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--no-session-persistence", "--settings", `{"disableAllHooks":true}`)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), f.Env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("claude: start %s: %w", f.binary(), err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	if _, err := stdin.Write([]byte(`{"type":"control_request","request_id":"gc-commands","request":{"subtype":"initialize"}}` + "\n")); err != nil {
		return nil, err
	}

	answer := make(chan []app.Command, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			if list, ok := parseInitialize(scanner.Bytes()); ok {
				answer <- list
				return
			}
		}
		close(answer)
	}()
	select {
	case list, ok := <-answer:
		if !ok {
			return nil, fmt.Errorf("claude: exited without listing commands")
		}
		return list, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("claude: list commands: %w", ctx.Err())
	}
}

func parseInitialize(line []byte) ([]app.Command, bool) {
	var msg struct {
		Type     string `json:"type"`
		Response struct {
			RequestID string `json:"request_id"`
			Response  struct {
				Commands []struct {
					Name         string `json:"name"`
					Description  string `json:"description"`
					ArgumentHint string `json:"argumentHint"`
				} `json:"commands"`
			} `json:"response"`
		} `json:"response"`
	}
	if json.Unmarshal(line, &msg) != nil || msg.Type != "control_response" || msg.Response.RequestID != "gc-commands" {
		return nil, false
	}
	list := make([]app.Command, 0, len(msg.Response.Response.Commands))
	for _, c := range msg.Response.Response.Commands {
		list = append(list, app.Command{
			Name: c.Name, Description: c.Description, ArgumentHint: c.ArgumentHint, Insert: "/" + c.Name,
		})
	}
	return list, true
}
