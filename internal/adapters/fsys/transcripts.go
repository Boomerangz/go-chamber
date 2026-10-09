package fsys

import (
	"context"
	"os"
	"path/filepath"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// TranscriptFiles keeps private, persistent snapshots in the app's data directory.
type TranscriptFiles struct{ Root string }

func (f TranscriptFiles) WriteTranscript(ctx context.Context, _ domain.SessionID, text string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	root, err := filepath.Abs(filepath.Join(f.Root, "transcripts"))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(root, "fork-*.md")
	if err != nil {
		return "", err
	}
	name := file.Name()
	_, writeErr := file.WriteString(text)
	closeErr := file.Close()
	if writeErr != nil {
		_ = os.Remove(name)
		return "", writeErr
	}
	if closeErr != nil {
		_ = os.Remove(name)
		return "", closeErr
	}
	return name, nil
}
