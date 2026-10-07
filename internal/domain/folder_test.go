package domain

import (
	"errors"
	"testing"
)

func TestFolderGoneNamesTheFolder(t *testing.T) {
	err := FolderGone("/work/gone")
	if !errors.Is(err, ErrFolderGone) {
		t.Fatalf("FolderGone is not ErrFolderGone: %v", err)
	}
	if got := err.Error(); got != "Folder /work/gone no longer exists" {
		t.Fatalf("message = %q", got)
	}
	if errors.Is(err, ErrInvalidSession) {
		t.Fatal("a missing folder is not an invalid session")
	}
}

func TestNoFolderSaysItDoesNotExist(t *testing.T) {
	err := NoFolder("/work/never")
	if !errors.Is(err, ErrFolderGone) {
		t.Fatalf("NoFolder is not ErrFolderGone: %v", err)
	}
	if got := err.Error(); got != "Folder /work/never doesn't exist" {
		t.Fatalf("message = %q", got)
	}
}
