package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
)

type stubSearch struct {
	query string
	limit int
	err   error
}

func (s *stubSearch) Search(_ context.Context, q string, limit int) ([]app.SearchHit, error) {
	s.query, s.limit = q, limit
	if s.err != nil {
		return nil, s.err
	}
	if q == "none" {
		return nil, nil
	}
	return []app.SearchHit{{SessionID: "s1", ItemID: "i1", Snippet: "a [[picker]]", Matches: 2}}, nil
}

func getSearch(t *testing.T, search MessageSearch, query string) (int, []byte) {
	t.Helper()
	ts := httptest.NewServer(NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Search: search}))
	t.Cleanup(ts.Close)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/search"+query, nil)
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

func TestSearchMessages(t *testing.T) {
	stub := &stubSearch{}
	status, raw := getSearch(t, stub, "?q=picker&limit=5")
	if status != http.StatusOK || stub.query != "picker" || stub.limit != 5 {
		t.Fatalf("status %d, called with %q/%d", status, stub.query, stub.limit)
	}
	var hits []app.SearchHit
	if err := json.Unmarshal(raw, &hits); err != nil || len(hits) != 1 || hits[0].Matches != 2 {
		t.Fatalf("hits = %s (%v)", raw, err)
	}
	getSearch(t, stub, "?q=x")
	if stub.limit != 30 {
		t.Fatalf("default limit = %d", stub.limit)
	}
	getSearch(t, stub, "?q=x&limit=9999")
	if stub.limit != 30 {
		t.Fatalf("clamped limit = %d", stub.limit)
	}
	if _, raw := getSearch(t, stub, "?q=none"); string(raw) != "[]\n" {
		t.Fatalf("empty result = %q", raw)
	}
	if status, _ := getSearch(t, &stubSearch{err: errors.New("boom")}, "?q=x"); status != http.StatusInternalServerError {
		t.Fatalf("error status = %d", status)
	}
}
