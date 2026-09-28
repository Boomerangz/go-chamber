package codex

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestCodexSendsImagesAsLocalImages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "i1.png")
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	rt := startCodex(t, app.StartRequest{}, "FAKECODEX_MODE=echo")
	var _ app.ImageSender = rt
	if err := rt.SendImages(context.Background(), "t", "look", []app.Image{{ID: "i1", Path: path, MimeType: "image/png"}}); err != nil {
		t.Fatal(err)
	}
	events := drainCodex(t, rt, func(ev domain.Event) bool { return ev.Type == domain.EventTurnEnded })
	if got := events[len(events)-1].Result.Text; got != "echo: [image 5 bytes] look" {
		t.Fatalf("result = %q", got)
	}
}
