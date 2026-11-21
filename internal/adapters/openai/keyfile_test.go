package openai

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenRouterCredentialFileFormats(t *testing.T) {
	for _, body := range []string{`{"openrouter":{"type":"api","key":"test-key"}}`, "export OPENROUTER_API_KEY='test-key'\n", "test-key\n"} {
		path := filepath.Join(t.TempDir(), "key")
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := (KeyFile{Path: path}).Credential(context.Background())
		if err != nil || got.Token != "test-key" || got.AccountID != "" {
			t.Fatalf("bad key format: %v", err)
		}
	}
}
