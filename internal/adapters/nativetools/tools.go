// Package nativetools implements native filesystem and shell tools.
package nativetools

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

const maxOutput = 64 << 10

type Tools struct {
	Cwd       string
	ReadRoots []string
}

func (t *Tools) Definitions() []domain.ModelTool {
	tools := []domain.ModelTool{
		{Name: "read", Description: "Read a UTF-8 file inside the workspace. Output is bounded; use offset and limit to page lines.", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1}},"required":["path"],"additionalProperties":false}`)},
		{Name: "write", Description: "Create or replace a file inside the workspace.", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false}`)},
		{Name: "edit", Description: "Replace exactly one occurrence of old_text with new_text. Ambiguous matches are rejected.", Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"},"old_text":{"type":"string"},"new_text":{"type":"string"}},"required":["path","old_text","new_text"],"additionalProperties":false}`)},
		{Name: "bash", Description: "Run a shell command in the workspace after approval. Output is bounded; timeout defaults to 120 seconds.", Parameters: json.RawMessage(`{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer","minimum":1,"maximum":600}},"required":["command"],"additionalProperties":false}`)},
	}
	for _, tool := range discoveryDefinitions() {
		tools = append(tools, domain.ModelTool{Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters})
	}
	return tools
}
func (t *Tools) NeedsApproval(call domain.ModelToolCall) bool {
	return call.Name != "read" && call.Name != "ls" && call.Name != "find" && call.Name != "grep"
}
func (t *Tools) Execute(ctx context.Context, call domain.ModelToolCall) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if call.Name == "ls" || call.Name == "find" || call.Name == "grep" {
		return t.discover(ctx, call.Name, call.Arguments)
	}
	var args struct {
		Path    string  `json:"path"`
		Content *string `json:"content"`
		Old     *string `json:"old_text"`
		New     *string `json:"new_text"`
		Command string  `json:"command"`
		Timeout int     `json:"timeout"`
		Offset  int     `json:"offset"`
		Limit   int     `json:"limit"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(call.Arguments)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&args); err != nil {
		return "", fmt.Errorf("invalid tool arguments: %w", err)
	}
	if call.Name == "bash" {
		return t.shell(ctx, args.Command, args.Timeout)
	}
	if call.Name != "read" && call.Name != "write" && call.Name != "edit" {
		return "", errors.New("unknown filesystem tool")
	}
	rootDir := t.Cwd
	path, err := t.relative(args.Path)
	if err != nil && call.Name == "read" && filepath.IsAbs(args.Path) {
		for _, dir := range t.ReadRoots {
			rel, e := filepath.Rel(dir, args.Path)
			if e == nil && filepath.IsLocal(rel) {
				rootDir, path, err = dir, rel, nil
				break
			}
		}
	}
	if err != nil {
		return "", err
	}
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		return "", err
	}
	defer root.Close() //nolint:errcheck // Read-only root handle.
	if call.Name == "write" {
		if args.Content == nil {
			return "", errors.New("content is required")
		}
		if len(*args.Content) > 4<<20 {
			return "", errors.New("file content exceeds 4 MiB")
		}
		if err = writeAtomic(root, path, []byte(*args.Content)); err != nil {
			return "", err
		}
		return "Wrote " + path, nil
	}
	f, err := root.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close() //nolint:errcheck // Read-only file.
	data, err := io.ReadAll(io.LimitReader(f, 4<<20+1))
	if err != nil {
		return "", err
	}
	if len(data) > 4<<20 {
		return "", errors.New("file exceeds 4 MiB; use a shell command to inspect a bounded range")
	}
	if call.Name == "edit" {
		if args.Old == nil || *args.Old == "" || args.New == nil {
			return "", errors.New("nonempty old_text and new_text are required")
		}
		if strings.Count(string(data), *args.Old) != 1 {
			return "", errors.New("old_text must match exactly once")
		}
		changed := strings.Replace(string(data), *args.Old, *args.New, 1)
		if len(changed) > 4<<20 {
			return "", errors.New("edited file exceeds 4 MiB")
		}
		if err = writeAtomic(root, path, []byte(changed)); err != nil {
			return "", err
		}
		return "Edited " + path, nil
	}
	if strings.ContainsRune(string(data), 0) {
		return "", errors.New("binary file; use a suitable inspection tool")
	}
	if args.Offset < 0 || args.Limit < 0 || args.Limit > 10000 {
		return "", errors.New("read offset must be positive and limit at most 10000")
	}
	lines := strings.Split(string(data), "\n")
	offset := max(args.Offset, 1) - 1
	limit := args.Limit
	if limit <= 0 {
		limit = 1000
	}
	if offset >= len(lines) {
		return "", nil
	}
	end := min(len(lines), offset+limit)
	text := strings.Join(lines[offset:end], "\n")
	if len(text) > maxOutput {
		text = text[:maxOutput] + "\n[output truncated]"
	}
	if end < len(lines) {
		text += fmt.Sprintf("\n[more lines: continue with offset %d]", end+1)
	}
	return text, nil
}
func (t *Tools) relative(path string) (string, error) {
	if path == "" {
		return "", errors.New("path required")
	}
	if filepath.IsAbs(path) {
		var err error
		path, err = filepath.Rel(t.Cwd, path)
		if err != nil {
			return "", err
		}
	}
	if !filepath.IsLocal(path) {
		return "", errors.New("path is outside workspace")
	}
	return path, nil
}
func writeAtomic(root *os.Root, path string, data []byte) error {
	mode := os.FileMode(0644)
	if st, err := root.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	dir := filepath.Dir(path)
	if err := root.MkdirAll(dir, 0755); err != nil {
		return err
	}
	temp := filepath.Join(dir, ".native-"+rand.Text())
	f, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer root.Remove(temp) //nolint:errcheck // Rename removes this owned temporary file.
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(temp, path)
}

type boundedOutput struct {
	mu        sync.Mutex
	data      []byte
	truncated bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := maxOutput - len(b.data)
	b.data = append(b.data, p[:min(len(p), remaining)]...)
	b.truncated = b.truncated || len(p) > remaining
	return len(p), nil
}
func (t *Tools) shell(ctx context.Context, command string, seconds int) (string, error) {
	if command == "" {
		return "", errors.New("command required")
	}
	if seconds == 0 {
		seconds = 120
	}
	if seconds < 1 || seconds > 600 {
		return "", errors.New("timeout must be between 1 and 600 seconds")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/bash", "-c", command)
	cmd.Dir = t.Cwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = time.Second
	var output boundedOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	text := string(output.data)
	if output.truncated {
		text += "\n[output truncated]"
	}
	if ctx.Err() != nil {
		return text, ctx.Err()
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Sprintf("%s\n[exit code %d]", text, exit.ExitCode()), nil
		}
		return text, err
	}
	return text, nil
}
