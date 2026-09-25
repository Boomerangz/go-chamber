package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

type server struct {
	base, token string
	stop        func()
}

func startServer(t *testing.T, dataDir string) server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	out := &syncBuf{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, []string{"-addr", "127.0.0.1:0", "-data", dataDir}, out) }()
	re := regexp.MustCompile(`http://(\S+)/\?token=(\w+)`)
	var m []string
	for deadline := time.Now().Add(5 * time.Second); m == nil && time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		m = re.FindStringSubmatch(out.String())
	}
	if m == nil {
		cancel()
		t.Fatalf("no startup URL: %q", out.String())
	}
	return server{base: "http://" + m[1], token: m[2], stop: func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("run: %v", err)
		}
	}}
}

func (s server) call(t *testing.T, method, path, body string, into any) {
	t.Helper()
	req, _ := http.NewRequest(method, s.base+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		t.Fatalf("%s %s: %d %s", method, path, res.StatusCode, raw)
	}
	if into != nil {
		if err := json.Unmarshal(raw, into); err != nil {
			t.Fatalf("%s %s: %v in %s", method, path, err, raw)
		}
	}
}

// History and message search survive a restart of go-chamber.
func TestHistorySurvivesRestart(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the fake claude")
	}
	bin := t.TempDir()
	build := exec.Command("go", "build", "-o", filepath.Join(bin, "claude"), "../../testutil/fakeclaude")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake claude: %v\n%s", err, out)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	data := t.TempDir()

	first := startServer(t, data)
	var session struct{ ID string }
	first.call(t, "POST", "/api/sessions", `{"agent":"claude","cwd":"`+t.TempDir()+`"}`, &session)
	first.call(t, "POST", "/api/sessions/"+session.ID+"/messages", `{"text":"hello persistent world"}`, nil)
	deadline := time.Now().Add(10 * time.Second)
	for {
		var events []struct{ Type string }
		first.call(t, "GET", "/api/sessions/"+session.ID+"/events", "", &events)
		if len(events) > 0 && events[len(events)-1].Type == "session.state" && hasType(events, "turn.ended") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn did not finish: %+v", events)
		}
		time.Sleep(50 * time.Millisecond)
	}
	first.stop()

	second := startServer(t, data)
	defer second.stop()
	var events []struct {
		Seq  int
		Type string
		Item *struct{ Text string }
	}
	second.call(t, "GET", "/api/sessions/"+session.ID+"/events", "", &events)
	var texts []string
	for _, ev := range events {
		if ev.Item != nil && ev.Item.Text != "" {
			texts = append(texts, ev.Item.Text)
		}
	}
	if !strings.Contains(strings.Join(texts, "|"), "echo: hello persistent world") {
		t.Fatalf("history after restart = %v", texts)
	}
	var hits []struct{ SessionID string }
	second.call(t, "GET", "/api/search?q=persistent", "", &hits)
	if len(hits) != 1 || hits[0].SessionID != session.ID {
		t.Fatalf("search after restart = %+v", hits)
	}
}

func hasType(events []struct{ Type string }, typ string) bool {
	for _, ev := range events {
		if ev.Type == typ {
			return true
		}
	}
	return false
}
