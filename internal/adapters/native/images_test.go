package native

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

func TestLoadImagesConfinedToUploadDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.png")
	if err := os.WriteFile(path, []byte("\x89PNG\r\n\x1a\n"), 0600); err != nil {
		t.Fatal(err)
	}
	images, err := LoadImages(dir)(context.Background(), []app.Image{{Path: path, MimeType: "image/png"}})
	if err != nil || len(images) != 1 {
		t.Fatalf("%v %v", images, err)
	}
	outside := filepath.Join(t.TempDir(), "private.png")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadImages(dir)(context.Background(), []app.Image{{Path: outside, MimeType: "image/png"}}); err == nil {
		t.Fatal("read outside uploads")
	}
}
