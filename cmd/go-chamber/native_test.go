package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestNativeHTTPChatWithCompatibleProvider(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fake-key" {
			t.Error("missing provider key")
		}
		if r.URL.Path == "/models" {
			_, _ = fmt.Fprint(w, `{"data":[{"id":"test/model","name":"Test model"}]}`)
			return
		}
		if r.URL.Path != "/chat/completions" {
			t.Error("wrong provider route")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"native hello\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	dir := t.TempDir()
	key := filepath.Join(dir, "router.key")
	if err := os.WriteFile(key, []byte("fake-key"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &syncBuf{}
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"-addr", "127.0.0.1:0", "-data", dir, "-tmux=false", "-rtc-ice", "[]", "-native-openrouter-url", provider.URL, "-native-openrouter-key-file", key}, out)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("server did not stop")
		}
	})
	re := regexp.MustCompile(`http://(\S+)/\?token=(\w+)`)
	var match []string
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		match = re.FindStringSubmatch(out.String())
		if match != nil {
			break
		}
	}
	if match == nil {
		t.Fatalf("no startup URL: %s", out.String())
	}
	request := func(method, path, body string) []byte {
		t.Helper()
		req, _ := http.NewRequest(method, "http://"+match[1]+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+match[2])
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode >= 400 {
			t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
		}
		return raw
	}
	models := request("GET", "/api/agents/native/models", "")
	if !strings.Contains(string(models), "openrouter:test/model") {
		t.Fatalf("%s", models)
	}
	raw, _ := json.Marshal(map[string]string{"agent": "native", "cwd": dir, "model": "openrouter:test/model"})
	var session struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(request("POST", "/api/sessions", string(raw)), &session); err != nil {
		t.Fatal(err)
	}
	request("POST", "/api/sessions/"+session.ID+"/messages", `{"text":"hi"}`)
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		history := request("GET", "/api/sessions/"+session.ID+"/events", "")
		if strings.Contains(string(history), "native hello") && strings.Contains(string(history), "turn.ended") {
			return
		}
	}
	t.Fatal("native response missing")
}
