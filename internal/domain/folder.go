package domain

import "errors"

// ErrFolderGone refuses a session in a folder that no longer exists: the
// agent could not start in it.
var ErrFolderGone = errors.New("folder no longer exists")

// folderGone names the missing folder; errors.Is matches ErrFolderGone.
type folderGone struct{ path string }

func (e folderGone) Error() string { return "Folder " + e.path + " no longer exists" }

func (e folderGone) Is(target error) bool { return target == ErrFolderGone }

// FolderGone is ErrFolderGone for the folder at path.
func FolderGone(path string) error { return folderGone{path: path} }
