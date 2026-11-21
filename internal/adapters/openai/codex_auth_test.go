package openai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testToken(account string) string {
	b, _ := json.Marshal(map[string]any{"https://api.openai.com/auth": map[string]string{"chatgpt_account_id": account}})
	return "header." + base64.RawURLEncoding.EncodeToString(b) + ".signature"
}

func TestCodexDeviceLoginAndSerializedRefresh(t *testing.T) {
	var refreshes atomic.Int32
	var wrong atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			_, _ = fmt.Fprint(w, `{"device_auth_id":"device","user_code":"CODE","interval":"0"}`)
		case "/api/accounts/deviceauth/token":
			_, _ = fmt.Fprint(w, `{"authorization_code":"code","code_verifier":"verifier"}`)
		case "/oauth/token":
			_ = r.ParseForm()
			if r.Form.Get("grant_type") == "refresh_token" {
				refreshes.Add(1)
				if r.Form.Get("refresh_token") != "refresh-1" {
					wrong.Store(true)
				}
			} else if r.Form.Get("code") != "code" || r.Form.Get("code_verifier") != "verifier" || !strings.HasSuffix(r.Form.Get("redirect_uri"), "/deviceauth/callback") {
				wrong.Store(true)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": testToken("account"), "refresh_token": "refresh-1", "expires_in": 3600})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	now := time.Now()
	path := filepath.Join(t.TempDir(), "native", "codex.json")
	a := &CodexAuth{Path: path, BaseURL: srv.URL, Now: func() time.Time { return now }}
	if _, err := a.Credential(context.Background()); !errors.Is(err, ErrNotLoggedIn) {
		t.Fatalf("missing auth: %v", err)
	}
	login, err := a.Begin(context.Background())
	if err != nil || login.UserCode != "CODE" {
		t.Fatalf("login: %+v %v", login, err)
	}
	if err = a.Complete(context.Background(), login); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("credential permissions: %v %v", st, err)
	}
	got, err := a.Credential(context.Background())
	if err != nil || got.AccountID != "account" || refreshes.Load() != 0 {
		t.Fatalf("credential: account=%q %v", got.AccountID, err)
	}
	now = now.Add(time.Hour)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			// Separate instances emulate separately constructed clients sharing storage.
			b := &CodexAuth{Path: path, BaseURL: srv.URL, Now: func() time.Time { return now }}
			if _, e := b.Credential(context.Background()); e != nil {
				t.Error(e)
			}
		})
	}
	wg.Wait()
	if refreshes.Load() != 1 || wrong.Load() {
		t.Fatalf("refreshes=%d invalid form=%v", refreshes.Load(), wrong.Load())
	}
}

func TestCodexLoginRefusesBadResponsesAndDoesNotStoreTokens(t *testing.T) {
	for _, body := range []string{`null`, `{}`, `{"access_token":"secret","refresh_token":"secret","expires_in":3600}`, `{"access_token":"secret","expires_in":3600}`} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/deviceauth/token") {
					_, _ = fmt.Fprint(w, `{"authorization_code":"code","code_verifier":"v"}`)
					return
				}
				_, _ = fmt.Fprint(w, body)
			}))
			defer srv.Close()
			path := filepath.Join(t.TempDir(), "auth.json")
			a := &CodexAuth{Path: path, BaseURL: srv.URL}
			err := a.Complete(context.Background(), DeviceLogin{DeviceID: "d", UserCode: "c", ExpiresAt: time.Now().Add(time.Minute)})
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("err=%v", err)
			}
			if _, e := os.Stat(path); !errors.Is(e, os.ErrNotExist) {
				t.Fatalf("invalid credentials saved: %v", e)
			}
		})
	}
}

func TestCodexDevicePollingIsCancellable(t *testing.T) {
	seen := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(403)
		select {
		case seen <- struct{}{}:
		default:
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := &CodexAuth{Path: filepath.Join(t.TempDir(), "auth.json"), BaseURL: srv.URL}
	done := make(chan error, 1)
	go func() {
		done <- a.Complete(ctx, DeviceLogin{DeviceID: "d", UserCode: "c", ExpiresAt: time.Now().Add(time.Minute)})
	}()
	<-seen
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not stop polling")
	}
}

func TestAuthNeverFollowsRedirectsOrIncludesBodies(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Store(true) }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	_, err := (&CodexAuth{BaseURL: srv.URL}).Begin(context.Background())
	if err == nil || leaked.Load() {
		t.Fatalf("redirect followed=%v err=%v", leaked.Load(), err)
	}
}
