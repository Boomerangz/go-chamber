package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbeCompatibleEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "local-test" {
			t.Errorf("model=%v", body["model"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	var out bytes.Buffer
	err := run(context.Background(), []string{"-wire", "chat-completions", "-base-url", srv.URL, "-model", "local-test", "-message", "hi", "-data", t.TempDir()}, &out)
	if err != nil || !strings.Contains(out.String(), "hello") {
		t.Fatalf("%q %v", out.String(), err)
	}
}

func TestProbeDoesNotSilentlyUsePaidAPI(t *testing.T) {
	var out bytes.Buffer
	err := run(context.Background(), []string{"-model", "test", "-data", t.TempDir()}, &out)
	if err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("missing subscription must fail: %v", err)
	}
}

func TestProbeRequiresModel(t *testing.T) {
	var out bytes.Buffer
	if err := run(context.Background(), []string{"-data", t.TempDir()}, &out); err == nil {
		t.Fatal("missing model accepted")
	}
}

func TestProbeOpenRouter(t *testing.T) {
	t.Setenv("TEST_OPENROUTER_KEY", "test-router-key")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer test-router-key" || r.Header.Get("ChatGPT-Account-ID") != "" {
			t.Error("incorrect OpenRouter request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"router works\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	var out bytes.Buffer
	err := run(context.Background(), []string{"-wire", "openrouter", "-base-url", srv.URL, "-key-env", "TEST_OPENROUTER_KEY", "-model", "provider/model", "-data", t.TempDir()}, &out)
	if err != nil || !strings.Contains(out.String(), "router works") {
		t.Fatalf("%s %v", out.String(), err)
	}
}

func TestProbeListsCurrentModelsWithoutInference(t *testing.T) {
	t.Setenv("TEST_ROUTER_KEY", "router-key")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/models" {
			t.Error("unexpected inference request")
		}
		_, _ = fmt.Fprint(w, `{"data":[{"id":"vendor/new-model","name":"Just released"}]}`)
	}))
	defer srv.Close()
	var out bytes.Buffer
	err := run(context.Background(), []string{"-list-models", "-wire", "openrouter", "-key-env", "TEST_ROUTER_KEY", "-base-url", srv.URL, "-data", t.TempDir()}, &out)
	if err != nil || !strings.Contains(out.String(), "vendor/new-model") || !strings.Contains(out.String(), "updatedAt") {
		t.Fatalf("%s %v", out.String(), err)
	}
}
