package openai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func TestNativeAccountSeparatesCodexLoginAndOpenRouterKey(t *testing.T) {
	manager := &NativeAccounts{Auth: &CodexAuth{Path: filepath.Join(t.TempDir(), "codex.json")}, OpenRouter: StaticCredentials{Token: "key"}}
	account, err := manager.Account(context.Background(), domain.AgentNative)
	if err != nil || account.LoggedIn || len(account.Providers) != 1 || account.Providers[0] != "openrouter" {
		t.Fatalf("%+v %v", account, err)
	}
	if _, err = manager.Account(context.Background(), domain.AgentClaude); err == nil {
		t.Fatal("accepted other runtime")
	}
}

func TestNativeDeviceLoginOutlivesHTTPRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/accounts/deviceauth/usercode":
			_, _ = fmt.Fprint(w, `{"device_auth_id":"device","user_code":"CODE","interval":1}`)
		case "/api/accounts/deviceauth/token":
			_, _ = fmt.Fprint(w, `{"authorization_code":"code","code_verifier":"verifier"}`)
		case "/oauth/token":
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": testToken("account"), "refresh_token": "refresh", "expires_in": 3600})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	lifecycle, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan struct{})
	manager := &NativeAccounts{Auth: &CodexAuth{Path: filepath.Join(t.TempDir(), "codex.json"), BaseURL: srv.URL}, Context: lifecycle, OnLogin: func() { close(done) }}
	request, cancel := context.WithCancel(context.Background())
	challenge, err := manager.StartLogin(request, domain.AgentNative)
	cancel()
	if err != nil || challenge.UserCode != "CODE" {
		t.Fatalf("%+v %v", challenge, err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("login canceled with HTTP request")
	}
	account, err := manager.Account(context.Background(), domain.AgentNative)
	if err != nil || !account.LoggedIn {
		t.Fatalf("%+v %v", account, err)
	}
}
