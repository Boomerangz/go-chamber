package nativetools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestFileToolsAndAmbiguousEdit(t *testing.T) {
	root := t.TempDir()
	tools := &Tools{Cwd: root}
	call := func(name, args string) (string, error) {
		return tools.Execute(context.Background(), domain.ModelToolCall{Name: name, Arguments: json.RawMessage(args)})
	}
	if _, err := call("write", `{"path":"note.txt","content":"one\none\n"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := call("edit", `{"path":"note.txt","old_text":"one","new_text":"two"}`); err == nil {
		t.Fatal("ambiguous edit accepted")
	}
	if _, err := call("edit", `{"path":"note.txt","old_text":"one\none\n","new_text":"two\n"}`); err != nil {
		t.Fatal(err)
	}
	text, err := call("read", `{"path":"note.txt"}`)
	if err != nil || !strings.Contains(text, "two") {
		t.Fatalf("%s %v", text, err)
	}
	if _, err = call("read", `{"path":"../secret"}`); err == nil {
		t.Fatal("read escaped workspace")
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err = os.WriteFile(outside, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err = call("read", `{"path":"link"}`); err == nil {
		t.Fatal("symlink escaped workspace")
	}
}
func TestShellCancellationAndBoundedOutput(t *testing.T) {
	tools := &Tools{Cwd: t.TempDir()}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := tools.Execute(ctx, domain.ModelToolCall{Name: "bash", Arguments: json.RawMessage(`{"command":"sleep 10"}`)}); err == nil {
		t.Fatal("cancel ignored")
	}
	out, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "bash", Arguments: json.RawMessage(`{"command":"printf hello"}`)})
	if err != nil || !strings.Contains(out, "hello") {
		t.Fatalf("%q %v", out, err)
	}
	if !tools.NeedsApproval(domain.ModelToolCall{Name: "bash"}) || tools.NeedsApproval(domain.ModelToolCall{Name: "read"}) {
		t.Fatal("incorrect permissions")
	}
}

func TestGlobalSkillsAreReadableButNotWritable(t *testing.T) {
	workspace := t.TempDir()
	skills := t.TempDir()
	path := filepath.Join(skills, "SKILL.md")
	if err := os.WriteFile(path, []byte("skill instructions"), 0600); err != nil {
		t.Fatal(err)
	}
	tools := &Tools{Cwd: workspace, ReadRoots: []string{skills}}
	args, _ := json.Marshal(map[string]string{"path": path})
	text, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "read", Arguments: args})
	if err != nil || text != "skill instructions" {
		t.Fatalf("%q %v", text, err)
	}
	args, _ = json.Marshal(map[string]string{"path": path, "content": "changed"})
	if _, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "write", Arguments: args}); err == nil {
		t.Fatal("wrote outside workspace")
	}
}

func TestReadRejectsOverflowAndEditEnforcesFileLimit(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a"), []byte("a\nb\nc"), 0600); err != nil {
		t.Fatal(err)
	}
	tools := &Tools{Cwd: dir}
	if _, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "read", Arguments: []byte(`{"path":"a","offset":2,"limit":9223372036854775807}`)}); err == nil {
		t.Fatal("unbounded page accepted")
	}
	raw, _ := json.Marshal(map[string]string{"path": "a", "old_text": "a", "new_text": strings.Repeat("x", 4<<20)})
	if _, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "edit", Arguments: raw}); err == nil {
		t.Fatal("oversized edit accepted")
	}
}

func TestAdvertisedToolsHaveValidSchemasAndPermissionPolicy(t *testing.T) {
	tools := &Tools{Cwd: t.TempDir()}
	for _, def := range tools.Definitions() {
		var schema map[string]any
		if err := json.Unmarshal(def.Parameters, &schema); err != nil || schema["type"] != "object" {
			t.Fatalf("%s: %v", def.Name, err)
		}
		readOnly := def.Name == "read" || def.Name == "ls" || def.Name == "find" || def.Name == "grep"
		if tools.NeedsApproval(domain.ModelToolCall{Name: def.Name}) == readOnly {
			t.Fatalf("wrong permission for %s", def.Name)
		}
	}
}

func TestToolsRejectInvalidArgumentsBeforeEffects(t *testing.T) {
	tools := &Tools{Cwd: t.TempDir()}
	for _, call := range []domain.ModelToolCall{{Name: "write", Arguments: []byte(`{"path":"a"}`)}, {Name: "read", Arguments: []byte(`{"path":"a","unexpected":true}`)}, {Name: "unknown", Arguments: []byte(`{}`)}, {Name: "read", Arguments: []byte(`{"path":""}`)}} {
		if _, err := tools.Execute(context.Background(), call); err == nil {
			t.Fatalf("accepted %+v", call)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tools.Execute(ctx, domain.ModelToolCall{Name: "write", Arguments: []byte(`{"path":"a","content":"no"}`)}); err == nil {
		t.Fatal("executed cancelled tool")
	}
	if _, err := os.Stat(filepath.Join(tools.Cwd, "a")); !os.IsNotExist(err) {
		t.Fatal("invalid tool wrote file")
	}
}

func TestBashToolRunsBashOutsidePOSIXMode(t *testing.T) {
	tools := &Tools{Cwd: t.TempDir()}
	raw, _ := json.Marshal(map[string]string{"command": "if [ -z \"$BASH_VERSION\" ] || shopt -oq posix; then exit 7; fi; printf bash"})
	output, err := tools.Execute(context.Background(), domain.ModelToolCall{Name: "bash", Arguments: raw})
	if err != nil || output != "bash" {
		t.Fatalf("bash tool ran another shell: %q %v", output, err)
	}
}
