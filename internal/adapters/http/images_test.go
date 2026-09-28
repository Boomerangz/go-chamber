package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
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

// sentImages records what the fake sessions were last asked to send.
var sentImages struct {
	text   string
	images []app.Image
}

func (f *fakeSessions) SendInput(_ context.Context, _ domain.SessionID, text string, images []app.Image) error {
	if f.err != nil {
		return f.err
	}
	sentImages.text, sentImages.images = text, images
	return nil
}

// png is the smallest file http.DetectContentType calls image/png.
var png = []byte("\x89PNG\r\n\x1a\n0000")

func imageServer(t *testing.T) (http.Handler, *fakeSessions, string) {
	t.Helper()
	dir := t.TempDir()
	f := &fakeSessions{sessions: []domain.SessionSnapshot{{ID: "a", Agent: domain.AgentClaude, Cwd: "/p"}}}
	return NewServer(Config{
		Token:     testToken,
		Static:    fstest.MapFS{"index.html": {Data: []byte("app")}},
		Sessions:  f,
		ImagesDir: dir,
	}), f, dir
}

func upload(h http.Handler, session string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/sessions/"+session+"/images", bytes.NewReader(body))
	return do(h, withCookie(r, testToken))
}

func TestUploadStoresAndServesAnImage(t *testing.T) {
	h, _, dir := imageServer(t)
	rec := upload(h, "a", png)
	var out struct {
		ID       string `json:"id"`
		MimeType string `json:"mimeType"`
	}
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &out) != nil || out.MimeType != "image/png" || !strings.HasSuffix(out.ID, ".png") {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	if data, err := os.ReadFile(filepath.Join(dir, "a", out.ID)); err != nil || !bytes.Equal(data, png) {
		t.Fatalf("stored = %q, %v", data, err)
	}
	get := do(h, authed("GET", "/api/sessions/a/images/"+out.ID, ""))
	if get.Code != http.StatusOK || !bytes.Equal(get.Body.Bytes(), png) || get.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("serve: %d %q %q", get.Code, get.Header().Get("Content-Type"), get.Body.String())
	}
	unauthed := httptest.NewRequest("GET", "/api/sessions/a/images/"+out.ID, nil)
	if rec := do(h, unauthed); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated read = %d", rec.Code)
	}
}

func TestUploadRejectsWhatIsNotASmallImage(t *testing.T) {
	h, _, _ := imageServer(t)
	if rec := upload(h, "a", []byte("<svg onload=alert(1)>")); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("svg = %d", rec.Code)
	}
	big := append(append([]byte(nil), png...), make([]byte, maxImageBytes)...)
	if rec := upload(h, "a", big); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("too large = %d", rec.Code)
	}
	if rec := upload(h, "nope", png); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session = %d", rec.Code)
	}
}

func TestServeRefusesPathsOutsideTheSessionImages(t *testing.T) {
	h, _, _ := imageServer(t)
	for _, id := range []string{"..%2F..%2Fetc%2Fpasswd", "x.txt", "missing0000000000000000000000000.png"} {
		if rec := do(h, authed("GET", "/api/sessions/a/images/"+id, "")); rec.Code != http.StatusNotFound {
			t.Errorf("%s = %d", id, rec.Code)
		}
	}
}

func TestSendMessageWithImages(t *testing.T) {
	h, _, _ := imageServer(t)
	var up struct{ ID string }
	_ = json.Unmarshal(upload(h, "a", png).Body.Bytes(), &up)
	rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":"","images":["`+up.ID+`"]}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("send = %d %s", rec.Code, rec.Body.String())
	}
	if len(sentImages.images) != 1 || sentImages.images[0].ID != up.ID || sentImages.images[0].MimeType != "image/png" || !filepath.IsAbs(sentImages.images[0].Path) {
		t.Fatalf("sent = %+v", sentImages)
	}
	if rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":"hi","images":["missing0000000000000000000000000.png"]}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown image = %d", rec.Code)
	}
}
