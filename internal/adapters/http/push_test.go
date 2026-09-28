package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/adapters/webpush"
)

type fakePush struct {
	subs  []webpush.Subscription
	unsub []string
}

func (f *fakePush) PublicKey() string { return "PUBKEY" }
func (f *fakePush) Subscribe(s webpush.Subscription) error {
	if s.Endpoint == "" {
		return errors.New("incomplete")
	}
	f.subs = append(f.subs, s)
	return nil
}
func (f *fakePush) Unsubscribe(endpoint string) error {
	f.unsub = append(f.unsub, endpoint)
	return nil
}

func pushServer(p *fakePush) http.Handler {
	return NewServer(Config{Token: testToken, Static: fstest.MapFS{"index.html": {Data: []byte("app")}}, Push: p})
}

func TestPushKeyAndSubscriptions(t *testing.T) {
	p := &fakePush{}
	h := pushServer(p)
	rec := do(h, withCookie(httptest.NewRequest("GET", "/api/push/key", nil), testToken))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"PUBKEY"`) {
		t.Fatalf("key: %d %s", rec.Code, rec.Body.String())
	}
	body := `{"endpoint":"https://push.example/1","keys":{"p256dh":"k","auth":"a"}}`
	rec = do(h, withCookie(httptest.NewRequest("POST", "/api/push/subscriptions", strings.NewReader(body)), testToken))
	if rec.Code != http.StatusNoContent || len(p.subs) != 1 || p.subs[0].Keys.Auth != "a" {
		t.Fatalf("subscribe: %d %+v", rec.Code, p.subs)
	}
	rec = do(h, withCookie(httptest.NewRequest("POST", "/api/push/subscriptions", strings.NewReader(`{}`)), testToken))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("incomplete subscribe: %d", rec.Code)
	}
	rec = do(h, withCookie(httptest.NewRequest("DELETE", "/api/push/subscriptions", strings.NewReader(`{"endpoint":"https://push.example/1"}`)), testToken))
	if rec.Code != http.StatusNoContent || len(p.unsub) != 1 {
		t.Fatalf("unsubscribe: %d %v", rec.Code, p.unsub)
	}
}

func TestPWAFilesNeedNoLogin(t *testing.T) {
	static := fstest.MapFS{
		"index.html":           {Data: []byte("app")},
		"manifest.webmanifest": {Data: []byte("{}")},
		"sw.js":                {Data: []byte("//sw")},
		"icon.svg":             {Data: []byte("<svg/>")},
	}
	h := NewServer(Config{Token: testToken, Static: static})
	for _, path := range []string{"/manifest.webmanifest", "/sw.js", "/icon.svg"} {
		if rec := do(h, httptest.NewRequest("GET", path, nil)); rec.Code != 200 {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
	if rec := do(h, httptest.NewRequest("GET", "/sw.js", nil)); rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("sw.js must revalidate, got %q", rec.Header().Get("Cache-Control"))
	}
	if rec := do(h, httptest.NewRequest("GET", "/api/push/key", nil)); rec.Code != http.StatusUnauthorized {
		t.Errorf("api stays behind login: %d", rec.Code)
	}
}
