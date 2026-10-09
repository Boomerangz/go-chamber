package fsys

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestTranscriptFilesPersistsPrivateUniqueFiles(t *testing.T) {
	root := t.TempDir()
	f := TranscriptFiles{Root: root}
	first, err := f.WriteTranscript(context.Background(), domain.SessionID("fork"), "full history")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.WriteTranscript(context.Background(), domain.SessionID("fork"), "other")
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !filepath.IsAbs(first) {
		t.Fatalf("paths %s %s", first, second)
	}
	data, err := os.ReadFile(first)
	if err != nil || string(data) != "full history" {
		t.Fatalf("data=%s err=%v", data, err)
	}
	info, _ := os.Stat(first)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("mode=%v", info.Mode())
	}
}
func TestTranscriptFilesReportsFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(root, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := (TranscriptFiles{Root: root}).WriteTranscript(context.Background(), "f", "x"); err == nil {
		t.Fatal("expected error")
	}
}
