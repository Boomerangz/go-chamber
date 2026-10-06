package fsys

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func writeFiles(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, f := range files {
		p := filepath.Join(root, f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func listed(t *testing.T, f *Files, root string) []string {
	t.Helper()
	got, err := f.ListFiles(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)
	return got
}

func TestListFilesInGitRepoHonoursGitignore(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	writeFiles(t, root, ".gitignore", "main.go", "pkg/a.go", "build/out.bin", "untracked.txt")
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("build/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := []string{".gitignore", "main.go", "pkg/a.go", "untracked.txt"}
	if got := listed(t, &Files{}, root); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestListFilesOutsideGitSkipsHeavyFolders(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "a.txt", "src/b.go", "node_modules/x/index.js", ".git/HEAD")
	want := []string{"a.txt", "src/b.go"}
	if got := listed(t, &Files{}, root); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestListFilesCachesBriefly(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "a.txt")
	f := &Files{}
	listed(t, f, root)
	writeFiles(t, root, "b.txt")
	if got := listed(t, f, root); !reflect.DeepEqual(got, []string{"a.txt"}) {
		t.Fatalf("cache not used: %v", got)
	}
}

func TestListFilesCapsTheWalk(t *testing.T) {
	root := t.TempDir()
	writeFiles(t, root, "a", "b", "c", "d")
	if got := listed(t, &Files{Limit: 2}, root); len(got) != 2 {
		t.Fatalf("got %v", got)
	}
}

func TestListFilesMissingRoot(t *testing.T) {
	if _, err := (&Files{}).ListFiles(context.Background(), filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected an error")
	}
}

func TestListFilesFollowsASymlinkedRoot(t *testing.T) {
	real := t.TempDir()
	writeFiles(t, real, "a.txt", "src/b.go")
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlink: %v", err)
	}
	want := []string{"a.txt", "src/b.go"}
	if got := listed(t, &Files{}, link); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
