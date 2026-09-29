package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type dirFiles struct{ dir string }

func (d dirFiles) Resolve(_ context.Context, id domain.SessionID, p string) (string, error) {
	if id != "s1" {
		return "", app.ErrSessionNotFound
	}
	if strings.Contains(p, "secret") {
		return "", app.ErrFileOutsideSession
	}
	full := filepath.Join(d.dir, p)
	if _, err := os.Stat(full); err != nil {
		return "", app.ErrFileNotFound
	}
	return full, nil
}

func TestSessionFileEndpoint(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"notes.md": "# hi", "page.html": "<script>alert(1)</script>", "pic.png": "\x89PNG\r\n\x1a\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{"index.html": {Data: []byte("app")}}, Files: dirFiles{dir}})
	get := func(q string) *httptest.ResponseRecorder {
		return do(h, withCookie(httptest.NewRequest("GET", "/api/sessions/s1/file?"+q, nil), testToken))
	}

	r := get("path=notes.md")
	if r.Code != 200 || r.Header().Get("Content-Type") != "text/plain; charset=utf-8" || r.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("md: %d %v", r.Code, r.Header())
	}
	if !strings.Contains(r.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("files must be sandboxed: %v", r.Header())
	}
	if r := get("path=pic.png"); r.Header().Get("Content-Type") != "image/png" || r.Header().Get("Content-Disposition") != "" {
		t.Fatalf("png: %v", r.Header())
	}
	if r := get("path=page.html"); !strings.HasPrefix(r.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("html must download, not render: %v", r.Header())
	}
	if r := get("path=notes.md&download=1"); !strings.HasPrefix(r.Header().Get("Content-Disposition"), `attachment; filename=notes.md`) {
		t.Fatalf("download: %v", r.Header())
	}
	if r := get("path=secret"); r.Code != http.StatusForbidden {
		t.Fatalf("outside: %d", r.Code)
	}
	if r := get("path=missing"); r.Code != http.StatusNotFound {
		t.Fatalf("missing: %d", r.Code)
	}
}
