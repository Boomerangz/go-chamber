package app

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeSessionLookup map[domain.SessionID]domain.SessionSnapshot

func (f fakeSessionLookup) Get(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	s, ok := f[id]
	if !ok {
		return domain.SessionSnapshot{}, ErrSessionNotFound
	}
	return s, nil
}

type fakeFileLister struct {
	files []string
	roots []string
}

func (f *fakeFileLister) ListFiles(_ context.Context, root string) ([]string, error) {
	f.roots = append(f.roots, root)
	return f.files, nil
}

type fakeCommandCatalog struct {
	agent domain.AgentKind
	cwd   string
	err   error
}

func (f *fakeCommandCatalog) Commands(_ context.Context, agent domain.AgentKind, cwd string) ([]Command, error) {
	f.agent, f.cwd = agent, cwd
	if f.err != nil {
		return nil, f.err
	}
	return []Command{{Name: "review", Description: "Review changes", Insert: "/review"}}, nil
}

func newTestCompleter(files []string) (*Completer, *fakeFileLister, *fakeCommandCatalog) {
	fl := &fakeFileLister{files: files}
	cc := &fakeCommandCatalog{}
	c := NewCompleter(CompleterConfig{
		Sessions: fakeSessionLookup{"s1": {ID: "s1", Agent: domain.AgentClaude, Cwd: "/repo"}},
		Files:    fl,
		Commands: cc,
	})
	return c, fl, cc
}

func TestCompleteFilesRanksBasenameMatchesFirst(t *testing.T) {
	c, fl, _ := newTestCompleter([]string{
		"docs/readme-manager.md",
		"internal/app/manager.go",
		"internal/app/manager_test.go",
		"web/src/App.tsx",
	})
	got, err := c.Files(context.Background(), "s1", "manager")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"internal/app/manager.go", "internal/app/manager_test.go", "docs/readme-manager.md"}
	if !reflect.DeepEqual(paths(got), want) {
		t.Fatalf("got %v, want %v", paths(got), want)
	}
	if !reflect.DeepEqual(fl.roots, []string{"/repo"}) {
		t.Fatalf("listed %v", fl.roots)
	}
}

func TestCompleteFilesMatchesSubsequenceCaseInsensitive(t *testing.T) {
	c, _, _ := newTestCompleter([]string{"internal/app/manager.go", "web/src/App.tsx", "cmd/main.go"})
	got, err := c.Files(context.Background(), "s1", "wsapp")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(paths(got), []string{"web/src/App.tsx"}) {
		t.Fatalf("got %v", paths(got))
	}
}

func TestCompleteFilesOffersDirectories(t *testing.T) {
	c, _, _ := newTestCompleter([]string{"internal/app/manager.go", "internal/domain/item.go"})
	got, err := c.Files(context.Background(), "s1", "domain")
	if err != nil {
		t.Fatal(err)
	}
	want := []FileMatch{{Path: "internal/domain/", Dir: true}, {Path: "internal/domain/item.go"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestCompleteFilesEmptyQueryPrefersShallowPaths(t *testing.T) {
	c, _, _ := newTestCompleter([]string{"a/b/c.go", "main.go", "a/x.go"})
	got, err := c.Files(context.Background(), "s1", "")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(paths(got), []string{"a/", "main.go", "a/b/", "a/x.go", "a/b/c.go"}) {
		t.Fatalf("got %v", paths(got))
	}
}

func TestCompleteFilesCapsResults(t *testing.T) {
	var files []string
	for i := 0; i < 200; i++ {
		files = append(files, "f"+string(rune('a'+i%26))+string(rune('a'+i/26))+".go")
	}
	c, _, _ := newTestCompleter(files)
	got, err := c.Files(context.Background(), "s1", "f")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != maxFileMatches {
		t.Fatalf("got %d matches", len(got))
	}
}

func TestCompleteUnknownSession(t *testing.T) {
	c, _, _ := newTestCompleter(nil)
	if _, err := c.Files(context.Background(), "nope", "x"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("files: %v", err)
	}
	if _, err := c.Commands(context.Background(), "nope"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("commands: %v", err)
	}
}

func TestCompleteCommandsAsksTheSessionAgentInItsFolder(t *testing.T) {
	c, _, cc := newTestCompleter(nil)
	got, err := c.Commands(context.Background(), "s1")
	if err != nil {
		t.Fatal(err)
	}
	if cc.agent != domain.AgentClaude || cc.cwd != "/repo" {
		t.Fatalf("asked %s in %q", cc.agent, cc.cwd)
	}
	if len(got) != 1 || got[0].Insert != "/review" {
		t.Fatalf("got %+v", got)
	}
}

func TestCompleteCommandsUnsupportedIsEmpty(t *testing.T) {
	c, _, cc := newTestCompleter(nil)
	cc.err = ErrCommandsUnsupported
	got, err := c.Commands(context.Background(), "s1")
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func paths(ms []FileMatch) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Path
	}
	return out
}
