package openai

// Codex OAuth wire flow adapted from Pi at 780bf31fcaeb252fa9b68df3964c735eae75bde3.
// See LICENSE.pi for upstream attribution. Credentials belong to this adapter,
// never to the Codex CLI's auth file.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

var ErrNotLoggedIn = errors.New("native Codex subscription is not logged in")

// CodexAuth owns a separate credential file. Every read/refresh/write takes a
// process-shared lock so concurrent sessions cannot reuse a rotated refresh token.
type CodexAuth struct {
	Path    string
	BaseURL string
	HTTP    *http.Client
	Now     func() time.Time
}

type DeviceLogin struct {
	DeviceID  string `json:"-"`
	UserCode  string
	URL       string
	Interval  time.Duration
	ExpiresAt time.Time
}

type codexCredential struct {
	Access    string    `json:"access"`
	Refresh   string    `json:"refresh"`
	AccountID string    `json:"accountId"`
	Expires   time.Time `json:"expires"`
}

func (a *CodexAuth) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *CodexAuth) base() string {
	if a.BaseURL != "" {
		return strings.TrimRight(a.BaseURL, "/")
	}
	return "https://auth.openai.com"
}

func (a *CodexAuth) Begin(ctx context.Context) (DeviceLogin, error) {
	var zero DeviceLogin
	raw, status, err := a.post(ctx, "/api/accounts/deviceauth/usercode", "application/json", `{"client_id":"`+codexClientID+`"}`)
	if err != nil {
		return zero, err
	}
	if status != http.StatusOK {
		return zero, &HTTPError{Status: status}
	}
	var v struct {
		DeviceID string          `json:"device_auth_id"`
		UserCode string          `json:"user_code"`
		Interval json.RawMessage `json:"interval"`
	}
	if json.Unmarshal(raw, &v) != nil || v.DeviceID == "" || v.UserCode == "" {
		return zero, errors.New("invalid device login response")
	}
	seconds, err := strconv.ParseFloat(strings.Trim(string(v.Interval), `"`), 64)
	if err != nil || seconds < 0 || seconds > 900 || seconds != seconds {
		return zero, errors.New("invalid device polling interval")
	}
	return DeviceLogin{DeviceID: v.DeviceID, UserCode: v.UserCode, URL: a.base() + "/codex/device", Interval: max(time.Second, time.Duration(seconds*float64(time.Second))), ExpiresAt: a.now().Add(15 * time.Minute)}, nil
}

func (a *CodexAuth) Complete(ctx context.Context, login DeviceLogin) error {
	if login.DeviceID == "" || login.UserCode == "" || login.ExpiresAt.IsZero() {
		return errors.New("invalid device login challenge")
	}
	ctx, cancel := context.WithTimeout(ctx, max(time.Duration(0), login.ExpiresAt.Sub(a.now())))
	defer cancel()
	interval := max(time.Second, login.Interval)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		body, err := json.Marshal(map[string]string{"device_auth_id": login.DeviceID, "user_code": login.UserCode})
		if err != nil {
			return err
		}
		raw, status, err := a.post(ctx, "/api/accounts/deviceauth/token", "application/json", string(body))
		if err != nil {
			return err
		}
		if status == http.StatusOK {
			var code struct {
				Code     string `json:"authorization_code"`
				Verifier string `json:"code_verifier"`
			}
			if json.Unmarshal(raw, &code) != nil || code.Code == "" || code.Verifier == "" {
				return errors.New("invalid device authorization response")
			}
			return a.locked(ctx, func() error {
				credential, err := a.exchange(ctx, url.Values{"grant_type": {"authorization_code"}, "code": {code.Code}, "code_verifier": {code.Verifier}, "redirect_uri": {a.base() + "/deviceauth/callback"}})
				if err != nil {
					return err
				}
				return a.save(credential)
			})
		}
		var pending struct {
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(raw, &pending)
		var code string
		if json.Unmarshal(pending.Error, &code) != nil {
			var wrapped struct {
				Code string `json:"code"`
			}
			_ = json.Unmarshal(pending.Error, &wrapped)
			code = wrapped.Code
		}
		if code == "slow_down" {
			interval = min(interval+5*time.Second, time.Minute)
		} else if status != 403 && status != 404 && code != "deviceauth_authorization_pending" {
			return &HTTPError{Status: status}
		}
		if err := waitContext(ctx, interval); err != nil {
			return err
		}
	}
}

func (a *CodexAuth) Credential(ctx context.Context) (StaticCredentials, error) {
	var result StaticCredentials
	err := a.locked(ctx, func() error {
		raw, err := os.ReadFile(a.Path)
		if errors.Is(err, os.ErrNotExist) {
			return ErrNotLoggedIn
		}
		if err != nil {
			return errors.New("cannot read native Codex credentials")
		}
		var saved codexCredential
		if json.Unmarshal(raw, &saved) != nil || saved.Access == "" || saved.Refresh == "" || saved.AccountID == "" || saved.Expires.IsZero() {
			return errors.New("invalid native Codex credential file")
		}
		if !saved.Expires.After(a.now().Add(time.Minute)) {
			renewed, err := a.exchange(ctx, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {saved.Refresh}})
			if err != nil {
				return err
			}
			if renewed.AccountID != saved.AccountID {
				return errors.New("codex refresh changed account identity")
			}
			if err = a.save(renewed); err != nil {
				return err
			}
			saved = renewed
		}
		result = StaticCredentials{Token: saved.Access, AccountID: saved.AccountID}
		return nil
	})
	return result, err
}

func (a *CodexAuth) exchange(ctx context.Context, form url.Values) (codexCredential, error) {
	var zero codexCredential
	form.Set("client_id", codexClientID)
	raw, status, err := a.post(ctx, "/oauth/token", "application/x-www-form-urlencoded", form.Encode())
	if err != nil {
		return zero, err
	}
	if status != http.StatusOK {
		return zero, &HTTPError{Status: status}
	}
	var token struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Expires int64  `json:"expires_in"`
	}
	if json.Unmarshal(raw, &token) != nil || token.Access == "" || token.Refresh == "" || token.Expires <= 0 || token.Expires > 365*24*3600 {
		return zero, errors.New("invalid Codex token response")
	}
	account, err := tokenAccount(token.Access)
	if err != nil {
		return zero, err
	}
	return codexCredential{Access: token.Access, Refresh: token.Refresh, AccountID: account, Expires: a.now().Add(time.Duration(token.Expires) * time.Second)}, nil
}

// This extracts routing metadata, not a signature verification or identity proof.
// The HTTPS authorization server is the source of this token.
func tokenAccount(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", errors.New("codex access token has no account metadata")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", errors.New("invalid Codex token metadata")
	}
	var payload struct {
		Auth struct {
			Account string `json:"chatgpt_account_id"`
		} `json:"https://api.openai.com/auth"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Auth.Account == "" {
		return "", errors.New("codex token is missing account identity")
	}
	return payload.Auth.Account, nil
}

func (a *CodexAuth) post(ctx context.Context, path, contentType, body string) ([]byte, int, error) {
	u, err := url.Parse(a.base())
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, 0, errors.New("invalid Codex authorization URL")
	}
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, a.base()+path, strings.NewReader(body))
	if err != nil {
		return nil, 0, errors.New("invalid authorization request")
	}
	r.Header.Set("Content-Type", contentType)
	r.Header.Set("Accept", "application/json")
	client := http.Client{Timeout: 30 * time.Second}
	if a.HTTP != nil {
		client = *a.HTTP
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(r)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		return nil, 0, errors.New("codex authorization transport failed")
	}
	defer resp.Body.Close() //nolint:errcheck // Read-only response body.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return nil, 0, errors.New("invalid authorization response body")
	}
	return raw, resp.StatusCode, nil
}

func (a *CodexAuth) locked(ctx context.Context, fn func() error) error {
	if a.Path == "" {
		return errors.New("native credential path is required")
	}
	if err := os.MkdirAll(filepath.Dir(a.Path), 0700); err != nil {
		return fmt.Errorf("create credential directory: %w", err)
	}
	f, err := os.OpenFile(a.Path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("open credential lock: %w", err)
	}
	defer f.Close() //nolint:errcheck // Closing releases the lock on every path.
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return fn()
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return errors.New("cannot lock native credentials")
		}
		if err = waitContext(ctx, 25*time.Millisecond); err != nil {
			return err
		}
	}
}

func (a *CodexAuth) save(credential codexCredential) error {
	raw, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(a.Path), ".native-auth-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name) //nolint:errcheck // The owned temp file may already have been renamed.
	if _, err = io.Copy(f, bytes.NewReader(raw)); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, a.Path)
}

func waitContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
