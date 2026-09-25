package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestRunServesAndShutsDown(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	out := &syncBuf{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, []string{"-addr", "127.0.0.1:0", "-data", dir}, out) }()

	re := regexp.MustCompile(`http://(\S+)/\?token=(\w+)`)
	var m []string
	for deadline := time.Now().Add(5 * time.Second); m == nil && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		m = re.FindStringSubmatch(out.String())
	}
	if m == nil {
		t.Fatalf("no startup URL in output: %q", out.String())
	}
	req, _ := http.NewRequest("GET", "http://"+m[1]+"/api/health", nil)
	req.Header.Set("Authorization", "Bearer "+m[2])
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "ok") {
		t.Fatalf("health: %d %s", resp.StatusCode, body)
	}

	req, _ = http.NewRequest("GET", "http://"+m[1]+"/api/terminals", nil)
	req.Header.Set("Authorization", "Bearer "+m[2])
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("terminals: %d %s", resp.StatusCode, body)
	}

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}
	saved, _ := os.ReadFile(filepath.Join(dir, "token"))
	if strings.TrimSpace(string(saved)) != m[2] {
		t.Fatal("token not persisted")
	}
}

func TestTokenIsStable(t *testing.T) {
	p := filepath.Join(t.TempDir(), "token")
	a, err := loadOrCreateToken(p)
	if err != nil || len(a) != 64 {
		t.Fatalf("token %q, err %v", a, err)
	}
	b, err := loadOrCreateToken(p)
	if err != nil || a != b {
		t.Fatalf("second load %q != %q (err %v)", b, a, err)
	}
}

func TestRunRejectsBadFlags(t *testing.T) {
	if err := run(context.Background(), []string{"-nope"}, io.Discard); err == nil {
		t.Fatal("want flag error")
	}
}
