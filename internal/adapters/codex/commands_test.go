package codex

import (
	"context"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestCodexCommandsAreItsEnabledSkills(t *testing.T) {
	f := &Factory{Binary: fakeBin, Stderr: os.Stderr, InitTimeout: 10 * time.Second}
	t.Cleanup(f.Close)
	got, err := f.Commands(context.Background(), domain.AgentCodex, "/work")
	if err != nil {
		t.Fatal(err)
	}
	want := []app.Command{
		{Name: "pdf", Description: "Read and write PDFs", Insert: "$pdf"},
		{Name: "review", Description: "Review the working tree", Insert: "$review"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if _, err := f.Commands(context.Background(), domain.AgentClaude, "/work"); err == nil {
		t.Fatal("codex factory must reject claude")
	}
}
