package webpush

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
)

func browserKeys(t *testing.T) Keys {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	return Keys{
		P256dh: base64.RawURLEncoding.EncodeToString(k.PublicKey().Bytes()),
		Auth:   base64.RawURLEncoding.EncodeToString(auth),
	}
}

func TestKeysPersistAcrossOpens(t *testing.T) {
	dir := t.TempDir()
	a, err := Open(dir, "mailto:owner@localhost")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Open(dir, "mailto:owner@localhost")
	if err != nil {
		t.Fatal(err)
	}
	if a.PublicKey() == "" || a.PublicKey() != b.PublicKey() {
		t.Fatalf("keys %q vs %q", a.PublicKey(), b.PublicKey())
	}
}

func TestPushReachesSubscribersAndDropsGoneOnes(t *testing.T) {
	var hits, goneHits atomic.Int32
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" || r.Header.Get("Content-Encoding") != "aes128gcm" {
			t.Errorf("headers %v", r.Header)
		}
		hits.Add(1)
		w.WriteHeader(http.StatusCreated)
	}))
	defer live.Close()
	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		goneHits.Add(1)
		w.WriteHeader(http.StatusGone)
	}))
	defer gone.Close()

	dir := t.TempDir()
	s, err := Open(dir, "mailto:owner@localhost")
	if err != nil {
		t.Fatal(err)
	}
	keys := browserKeys(t)
	for _, sub := range []Subscription{{Endpoint: live.URL, Keys: keys}, {Endpoint: gone.URL, Keys: keys}, {Endpoint: live.URL, Keys: keys}} {
		if err := s.Subscribe(sub); err != nil {
			t.Fatal(err)
		}
	}
	n := app.Notification{Title: "t", Body: "b", URL: "/s/x", Tag: "x"}
	if err := s.Push(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 || goneHits.Load() != 1 {
		t.Fatalf("live %d gone %d, want 1 and 1 (duplicate endpoint stored once)", hits.Load(), goneHits.Load())
	}
	reopened, err := Open(dir, "mailto:owner@localhost")
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Push(context.Background(), n); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 || goneHits.Load() != 1 {
		t.Fatalf("after reopen live %d gone %d: the gone subscription must be forgotten", hits.Load(), goneHits.Load())
	}
	if err := reopened.Unsubscribe(live.URL); err != nil {
		t.Fatal(err)
	}
	_ = reopened.Push(context.Background(), n)
	if hits.Load() != 2 {
		t.Fatal("unsubscribed endpoint still pushed")
	}
}

func TestSubscribeRejectsIncompleteSubscriptions(t *testing.T) {
	s, err := Open(t.TempDir(), "mailto:owner@localhost")
	if err != nil {
		t.Fatal(err)
	}
	for _, sub := range []Subscription{{}, {Endpoint: "https://x"}, {Endpoint: "ftp://x", Keys: Keys{P256dh: "a", Auth: "b"}}} {
		if err := s.Subscribe(sub); err == nil {
			t.Errorf("accepted %+v", sub)
		}
	}
}

func TestTopicMeetsPushServiceConstraints(t *testing.T) {
	for _, tc := range []struct{ tag, want string }{
		{"", ""},
		{"/09:az{AZ[-_@`", "09azAZ-_"},
		{"session: hello/мир", "sessionhello"},
		{"01234567890123456789012345678901", "01234567890123456789012345678901"},
		{"012345678901234567890123456789012", "01234567890123456789012345678901"},
	} {
		t.Run(tc.tag, func(t *testing.T) {
			if got := topic(tc.tag); got != tc.want {
				t.Fatalf("topic(%q) = %q, want %q", tc.tag, got, tc.want)
			}
		})
	}
}
