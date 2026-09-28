// Package webpush sends Web Push notifications to the owner's browsers.
// VAPID keys and subscriptions live in the data folder as JSON: a single user
// has a handful of devices, so a file beats a table.
package webpush

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sync"

	wp "github.com/SherClockHolmes/webpush-go"

	"github.com/igorzygin/go-chamber/internal/app"
)

// Keys are the browser's encryption keys from PushSubscription.toJSON().
type Keys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// Subscription is one browser's push endpoint.
type Subscription struct {
	Endpoint string `json:"endpoint"`
	Keys     Keys   `json:"keys"`
}

type vapid struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

// Service keeps the subscriptions and pushes notifications to them.
type Service struct {
	dir     string
	subject string
	keys    vapid
	client  *http.Client

	mu   sync.Mutex
	subs []Subscription
}

const (
	keysFile = "vapid.json"
	subsFile = "push-subscriptions.json"
)

// Open loads the VAPID keys (creating them on first use) and subscriptions
// from dir. subject is the contact push services may use (mailto: or https:).
func Open(dir, subject string) (*Service, error) {
	s := &Service{dir: dir, subject: subject, client: &http.Client{}}
	if err := readJSON(filepath.Join(dir, keysFile), &s.keys); errors.Is(err, os.ErrNotExist) {
		priv, pub, err := wp.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		s.keys = vapid{Public: pub, Private: priv}
		if err := writeJSON(filepath.Join(dir, keysFile), s.keys); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if err := readJSON(filepath.Join(dir, subsFile), &s.subs); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

// PublicKey is the application server key browsers subscribe with.
func (s *Service) PublicKey() string { return s.keys.Public }

// Subscribe remembers a browser; subscribing the same endpoint again replaces it.
func (s *Service) Subscribe(sub Subscription) error {
	u, err := url.Parse(sub.Endpoint)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || sub.Keys.P256dh == "" || sub.Keys.Auth == "" {
		return fmt.Errorf("webpush: incomplete subscription")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs = slices.DeleteFunc(s.subs, func(o Subscription) bool { return o.Endpoint == sub.Endpoint })
	s.subs = append(s.subs, sub)
	return writeJSON(filepath.Join(s.dir, subsFile), s.subs)
}

// Unsubscribe forgets a browser.
func (s *Service) Unsubscribe(endpoint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs = slices.DeleteFunc(s.subs, func(o Subscription) bool { return o.Endpoint == endpoint })
	return writeJSON(filepath.Join(s.dir, subsFile), s.subs)
}

// Push sends n to every subscriber and forgets those the push service says
// are gone (404/410). Other failures are returned but keep the subscription.
func (s *Service) Push(ctx context.Context, n app.Notification) error {
	payload, err := json.Marshal(n)
	if err != nil {
		return err
	}
	s.mu.Lock()
	subs := slices.Clone(s.subs)
	s.mu.Unlock()

	var errs []error
	var gone []string
	for _, sub := range subs {
		resp, err := wp.SendNotificationWithContext(ctx, payload, &wp.Subscription{
			Endpoint: sub.Endpoint,
			Keys:     wp.Keys{P256dh: sub.Keys.P256dh, Auth: sub.Keys.Auth},
		}, &wp.Options{
			HTTPClient:      s.client,
			Subscriber:      s.subject,
			VAPIDPublicKey:  s.keys.Public,
			VAPIDPrivateKey: s.keys.Private,
			TTL:             3600,
			Urgency:         wp.UrgencyHigh,
			Topic:           topic(n.Tag),
		})
		if err != nil {
			errs = append(errs, err)
			continue
		}
		_ = resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
			gone = append(gone, sub.Endpoint)
		case resp.StatusCode >= 300:
			errs = append(errs, fmt.Errorf("webpush: %s answered %d", sub.Endpoint, resp.StatusCode))
		}
	}
	for _, endpoint := range gone {
		if err := s.Unsubscribe(endpoint); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// topic lets the push service replace an undelivered message with a newer
// one about the same thing; it must be at most 32 URL-safe characters.
func topic(tag string) string {
	out := make([]byte, 0, 32)
	for i := 0; i < len(tag) && len(out) < 32; i++ {
		c := tag[i]
		if c == '-' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' {
			out = append(out, c)
		}
	}
	return string(out)
}

func readJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
