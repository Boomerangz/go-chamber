package app

import (
	"errors"
	"io/fs"
	"reflect"
	"testing"
)

type fakeFolderReader struct {
	dirs map[string][]FolderEntry
	err  error
	read []string
}

func (f *fakeFolderReader) ReadFolder(path string) ([]FolderEntry, error) {
	f.read = append(f.read, path)
	if f.err != nil {
		return nil, f.err
	}
	entries, ok := f.dirs[path]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return entries, nil
}

func newTestFolders() (*Folders, *fakeFolderReader) {
	r := &fakeFolderReader{dirs: map[string][]FolderEntry{
		"/home/me": {
			{Name: "zeta"},
			{Name: ".config"},
			{Name: "Alpha", Repo: true},
			{Name: "beta"},
		},
		"/": {{Name: "home"}, {Name: "tmp"}},
	}}
	return NewFolders(FoldersConfig{Reader: r, Home: "/home/me"}), r
}

func names(l FolderListing) []string {
	out := make([]string, 0, len(l.Folders))
	for _, f := range l.Folders {
		out = append(out, f.Name)
	}
	return out
}

func TestFoldersDefaultsToHomeAndSortsWithoutHidden(t *testing.T) {
	folders, _ := newTestFolders()
	l, err := folders.List("", false)
	if err != nil {
		t.Fatal(err)
	}
	if l.Path != "/home/me" || l.Parent != "/home" || l.Home != "/home/me" {
		t.Fatalf("listing header = %+v", l)
	}
	if got := names(l); !reflect.DeepEqual(got, []string{"Alpha", "beta", "zeta"}) {
		t.Fatalf("names = %v", got)
	}
	if l.Folders[0].Path != "/home/me/Alpha" || !l.Folders[0].Repo {
		t.Fatalf("first folder = %+v", l.Folders[0])
	}
}

func TestFoldersShowsHiddenOnRequest(t *testing.T) {
	folders, _ := newTestFolders()
	l, err := folders.List("/home/me", true)
	if err != nil {
		t.Fatal(err)
	}
	if got := names(l); !reflect.DeepEqual(got, []string{".config", "Alpha", "beta", "zeta"}) {
		t.Fatalf("names = %v", got)
	}
}

func TestFoldersCleansPathAndRootHasNoParent(t *testing.T) {
	folders, r := newTestFolders()
	l, err := folders.List("/home/me/../../", false)
	if err != nil {
		t.Fatal(err)
	}
	if l.Path != "/" || l.Parent != "" {
		t.Fatalf("listing = %+v", l)
	}
	if r.read[len(r.read)-1] != "/" {
		t.Fatalf("read %v", r.read)
	}
	if l.Folders[1].Path != "/tmp" {
		t.Fatalf("root child path = %q", l.Folders[1].Path)
	}
}

func TestFoldersExpandsTilde(t *testing.T) {
	folders, _ := newTestFolders()
	l, err := folders.List("~", false)
	if err != nil || l.Path != "/home/me" {
		t.Fatalf("~ = %+v, %v", l, err)
	}
	l, err = folders.List("~/", false)
	if err != nil || l.Path != "/home/me" {
		t.Fatalf("~/ = %+v, %v", l, err)
	}
}

func TestFoldersRejectsRelativePaths(t *testing.T) {
	folders, r := newTestFolders()
	if _, err := folders.List("projects", false); !errors.Is(err, ErrInvalidFolder) {
		t.Fatalf("err = %v", err)
	}
	if len(r.read) != 0 {
		t.Fatalf("relative path was read: %v", r.read)
	}
}

func TestFoldersMapsReaderErrors(t *testing.T) {
	folders, r := newTestFolders()
	if _, err := folders.List("/missing", false); !errors.Is(err, ErrFolderNotFound) {
		t.Fatalf("missing err = %v", err)
	}
	r.err = fs.ErrPermission
	if _, err := folders.List("/root", false); !errors.Is(err, ErrFolderForbidden) {
		t.Fatalf("forbidden err = %v", err)
	}
	boom := errors.New("boom")
	r.err = boom
	if _, err := folders.List("/x", false); !errors.Is(err, boom) {
		t.Fatalf("other err = %v", err)
	}
}

func TestFoldersEmptyListingIsNotNil(t *testing.T) {
	r := &fakeFolderReader{dirs: map[string][]FolderEntry{"/empty": nil}}
	l, err := NewFolders(FoldersConfig{Reader: r, Home: "/"}).List("/empty", false)
	if err != nil || l.Folders == nil {
		t.Fatalf("listing = %+v, %v", l, err)
	}
}
