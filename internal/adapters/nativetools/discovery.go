package nativetools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
)

func discoveryDefinitions() []struct {
	Name, Description string
	Parameters        json.RawMessage
} {
	return []struct {
		Name, Description string
		Parameters        json.RawMessage
	}{
		{"ls", "List workspace directory entries.", json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"additionalProperties":false}`)},
		{"find", "Find workspace files by basename glob; ignores .git, node_modules and vendor.", json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"],"additionalProperties":false}`)},
		{"grep", "Search workspace text files with a Go regular expression. Output includes path and line.", json.RawMessage(`{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"],"additionalProperties":false}`)},
	}
}
func (t *Tools) discover(ctx context.Context, name string, args json.RawMessage) (string, error) {
	var input struct {
		Path    string `json:"path"`
		Pattern string `json:"pattern"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return "", err
	}
	root, err := os.OpenRoot(t.Cwd)
	if err != nil {
		return "", err
	}
	defer root.Close() //nolint:errcheck // Read-only root.
	if name == "ls" {
		if input.Path == "" {
			input.Path = "."
		}
		path, err := t.relative(input.Path)
		if err != nil {
			return "", err
		}
		entries, err := fs.ReadDir(root.FS(), path)
		if err != nil {
			return "", err
		}
		var out strings.Builder
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			out.WriteString(entry.Name())
			if entry.IsDir() {
				out.WriteByte('/')
			}
			out.WriteByte('\n')
			if out.Len() > maxOutput {
				break
			}
		}
		return out.String(), nil
	}
	if input.Pattern == "" {
		return "", fmt.Errorf("pattern required")
	}
	var re *regexp.Regexp
	if name == "grep" {
		re, err = regexp.Compile(input.Pattern)
	} else {
		_, err = filepath.Match(input.Pattern, "test")
	}
	if err != nil {
		return "", err
	}
	var out strings.Builder
	files := 0
	err = fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if out.Len() > maxOutput || files > 10000 {
			return fs.SkipAll
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "vendor" {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		files++
		if name == "find" {
			match, _ := filepath.Match(input.Pattern, entry.Name())
			if match {
				out.WriteString(path + "\n")
			}
			return nil
		}
		f, err := root.Open(path)
		if err != nil {
			return nil
		}
		data, err := io.ReadAll(io.LimitReader(f, 1<<20))
		_ = f.Close()
		if err != nil || strings.ContainsRune(string(data), 0) {
			return nil
		}
		for i, line := range strings.Split(string(data), "\n") {
			if re.MatchString(line) {
				_, _ = fmt.Fprintf(&out, "%s:%d:%s\n", path, i+1, line)
				if out.Len() > maxOutput {
					break
				}
			}
		}
		return nil
	})
	text := out.String()
	if len(text) > maxOutput {
		text = text[:maxOutput] + "\n[output truncated]"
	}
	return text, err
}

// Instructions loads ancestor AGENTS.md in precedence order and advertises
// workspace Markdown skills for explicit loading with the read tool.
func Instructions(cwd string) (string, error) { return InstructionsWithSkills(cwd, nil) }
func InstructionsWithSkills(cwd string, extraRoots []string) (string, error) {
	var ancestors []string
	for dir := cwd; ; dir = filepath.Dir(dir) {
		ancestors = append(ancestors, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	var out strings.Builder
	for i := len(ancestors) - 1; i >= 0; i-- {
		path := filepath.Join(ancestors[i], "AGENTS.md")
		raw, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", err
		}
		if len(raw) > 128<<10 || out.Len()+len(raw) > 256<<10 {
			return "", fmt.Errorf("workspace instructions exceed limit")
		}
		_, _ = fmt.Fprintf(&out, "Instructions from %s:\n%s\n", path, raw)
	}
	out.WriteString("Before editing a subdirectory, inspect and follow its more specific AGENTS.md files. Skills are instructions to load with read when relevant:\n")
	skills, err := discoverSkills(cwd, extraRoots)
	if err != nil {
		return "", err
	}
	out.WriteString("When the user invokes a listed /skill command, read that skill's SKILL.md and follow it, using the rest of the user's message as its task.\n")
	for _, skill := range skills {
		_, _ = fmt.Fprintf(&out, "- /%s: %s (instructions: %s)\n", skill.Name, skill.Description, skill.path)
	}

	return out.String(), nil
}

// SkillCommands uses the same catalog and precedence as the model instructions.
func SkillCommands(cwd string, extraRoots []string) ([]app.Command, error) {
	skills, err := discoverSkills(cwd, extraRoots)
	if err != nil {
		return nil, err
	}
	commands := make([]app.Command, 0, len(skills))
	for _, skill := range skills {
		commands = append(commands, skill.Command)
	}
	return commands, nil
}

type discoveredSkill struct {
	app.Command
	path string
}

func discoverSkills(cwd string, extraRoots []string) ([]discoveredSkill, error) {
	roots := append([]string{filepath.Join(cwd, ".agents/skills"), filepath.Join(cwd, ".claude/skills"), filepath.Join(cwd, ".codex/skills")}, extraRoots...)
	seen := map[string]bool{"compact": true}
	var skills []discoveredSkill
	for _, dir := range roots {
		paths, err := filepath.Glob(filepath.Join(dir, "*", "SKILL.md"))
		if err != nil {
			return nil, err
		}
		for _, path := range paths {
			name := filepath.Base(filepath.Dir(path))
			if seen[name] {
				continue
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			description := ""
			for _, line := range strings.Split(string(raw), "\n") {
				if value, ok := strings.CutPrefix(line, "description:"); ok {
					description = strings.Trim(strings.TrimSpace(value), "\"'")
					break
				}
			}
			seen[name] = true
			skills = append(skills, discoveredSkill{Command: app.Command{Name: name, Description: description, Insert: "/" + name}, path: path})
		}
	}
	return skills, nil
}
