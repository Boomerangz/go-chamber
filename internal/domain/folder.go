package domain

import "errors"

// ErrFolderGone refuses a session in a folder that is not there: the agent
// could not start in it.
var ErrFolderGone = errors.New("folder no longer exists")

// folderGone names the missing folder; errors.Is matches ErrFolderGone.
type folderGone struct {
	path  string
	never bool
}

func (e folderGone) Error() string {
	if e.never {
		return "Folder " + e.path + " doesn't exist"
	}
	return "Folder " + e.path + " no longer exists"
}

func (e folderGone) Is(target error) bool { return target == ErrFolderGone }

// FolderGone is ErrFolderGone for an existing session's folder at path.
func FolderGone(path string) error { return folderGone{path: path} }

// NoFolder is ErrFolderGone for a folder a new session was asked to start in.
func NoFolder(path string) error { return folderGone{path: path, never: true} }
