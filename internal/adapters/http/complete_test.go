package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type stubCompleter struct {
	id    domain.SessionID
	query string
}

func (s *stubCompleter) Files(_ context.Context, id domain.SessionID, query string) ([]app.FileMatch, error) {
	s.id, s.query = id, query
	if id == "missing" {
		return nil, app.ErrSessionNotFound
	}
	return []app.FileMatch{{Path: "cmd/", Dir: true}, {Path: "cmd/main.go"}}, nil
}

func (s *stubCompleter) Commands(_ context.Context, id domain.SessionID) ([]app.Command, error) {
	s.id = id
	return []app.Command{{Name: "compact", Insert: "/compact"}}, nil
}

func getComplete(t *testing.T, c Completer, path string) (int, []byte) {
	t.Helper()
	ts := httptest.NewServer(NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Complete: c}))
	t.Cleanup(ts.Close)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, body
}

func TestCompleteFiles(t *testing.T) {
	stub := &stubCompleter{}
	status, raw := getComplete(t, stub, "/api/sessions/s1/complete/files?q=main")
	if status != http.StatusOK || stub.id != "s1" || stub.query != "main" {
		t.Fatalf("status %d, called with %q %q", status, stub.id, stub.query)
	}
	var got []app.FileMatch
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []app.FileMatch{{Path: "cmd/", Dir: true}, {Path: "cmd/main.go"}}) {
		t.Fatalf("got %+v", got)
	}
}

func TestCompleteFilesUnknownSession(t *testing.T) {
	if status, _ := getComplete(t, &stubCompleter{}, "/api/sessions/missing/complete/files?q=x"); status != http.StatusNotFound {
		t.Fatalf("status %d", status)
	}
}

func TestCompleteCommands(t *testing.T) {
	stub := &stubCompleter{}
	status, raw := getComplete(t, stub, "/api/sessions/s1/commands")
	if status != http.StatusOK || stub.id != "s1" {
		t.Fatalf("status %d, id %q", status, stub.id)
	}
	var got []app.Command
	if err := json.Unmarshal(raw, &got); err != nil || len(got) != 1 || got[0].Insert != "/compact" {
		t.Fatalf("got %s, %v", raw, err)
	}
}

func TestCompleteNeedsAuth(t *testing.T) {
	ts := httptest.NewServer(NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Complete: &stubCompleter{}}))
	t.Cleanup(ts.Close)
	res, err := http.Get(ts.URL + "/api/sessions/s1/commands")
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", res.StatusCode)
	}
}
