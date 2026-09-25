package app

import (
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
)

var (
	ErrInvalidFolder   = errors.New("invalid folder path")
	ErrFolderNotFound  = errors.New("folder not found")
	ErrFolderForbidden = errors.New("folder not readable")
)

// FolderEntry is one subdirectory as the reader sees it. Repo marks a git
// working tree (it has a .git entry).
type FolderEntry struct {
	Name string
	Repo bool
}

// FolderReader lists the subdirectories of an absolute path.
type FolderReader interface {
	ReadFolder(path string) ([]FolderEntry, error)
}

type Folder struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Repo bool   `json:"repo,omitempty"`
}

// FolderListing is one step of the folder picker.
type FolderListing struct {
	Path    string   `json:"path"`
	Parent  string   `json:"parent,omitempty"`
	Home    string   `json:"home"`
	Folders []Folder `json:"folders"`
}

type FoldersConfig struct {
	Reader FolderReader
	Home   string
}

// Folders lets the user browse the server's filesystem to pick a working
// directory: browsers can't reveal absolute paths of local folders.
type Folders struct {
	cfg FoldersConfig
}

func NewFolders(cfg FoldersConfig) *Folders { return &Folders{cfg: cfg} }

// List returns the subfolders of dir (home when empty; "~" expands to home).
// Dot-folders are skipped unless hidden is set.
func (f *Folders) List(dir string, hidden bool) (FolderListing, error) {
	dir, err := f.resolve(dir)
	if err != nil {
		return FolderListing{}, err
	}
	entries, err := f.cfg.Reader.ReadFolder(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return FolderListing{}, fmt.Errorf("%w: %s", ErrFolderNotFound, dir)
	case errors.Is(err, fs.ErrPermission):
		return FolderListing{}, fmt.Errorf("%w: %s", ErrFolderForbidden, dir)
	case err != nil:
		return FolderListing{}, err
	}
	l := FolderListing{Path: dir, Home: f.cfg.Home, Folders: []Folder{}}
	if dir != "/" {
		l.Parent = path.Dir(dir)
	}
	for _, e := range entries {
		if !hidden && strings.HasPrefix(e.Name, ".") {
			continue
		}
		l.Folders = append(l.Folders, Folder{Name: e.Name, Path: path.Join(dir, e.Name), Repo: e.Repo})
	}
	sort.Slice(l.Folders, func(i, j int) bool {
		return strings.ToLower(l.Folders[i].Name) < strings.ToLower(l.Folders[j].Name)
	})
	return l, nil
}

func (f *Folders) resolve(dir string) (string, error) {
	switch {
	case dir == "" || dir == "~":
		dir = f.cfg.Home
	case strings.HasPrefix(dir, "~/"):
		dir = path.Join(f.cfg.Home, dir[2:])
	}
	if !path.IsAbs(dir) {
		return "", fmt.Errorf("%w: %q is not absolute", ErrInvalidFolder, dir)
	}
	return path.Clean(dir), nil
}
