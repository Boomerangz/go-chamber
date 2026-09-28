package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type stubHistory struct {
	agent    domain.AgentKind
	nativeID string
}

func (s *stubHistory) List(context.Context) ([]app.ExternalSession, error) {
	return []app.ExternalSession{{Agent: domain.AgentClaude, NativeID: "c1", Cwd: "/p", Title: "fix"}}, nil
}

func (s *stubHistory) Import(_ context.Context, agent domain.AgentKind, nativeID string) (domain.SessionSnapshot, error) {
	s.agent, s.nativeID = agent, nativeID
	if nativeID == "missing" {
		return domain.SessionSnapshot{}, app.ErrHistoryNotFound
	}
	return domain.SessionSnapshot{ID: "s1", Agent: agent, Cwd: "/p", NativeID: nativeID, Status: domain.StatusDetached}, nil
}

func callHistory(t *testing.T, h HistoryService, method, path, body string) (int, []byte) {
	t.Helper()
	ts := httptest.NewServer(NewServer(Config{Token: testToken, Static: fstest.MapFS{}, History: h}))
	t.Cleanup(ts.Close)
	req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, raw
}

func TestHistoryList(t *testing.T) {
	status, raw := callHistory(t, &stubHistory{}, http.MethodGet, "/api/history", "")
	var got []app.ExternalSession
	if status != http.StatusOK || json.Unmarshal(raw, &got) != nil || len(got) != 1 || got[0].NativeID != "c1" {
		t.Fatalf("status %d body %s", status, raw)
	}
}

func TestHistoryImport(t *testing.T) {
	stub := &stubHistory{}
	status, raw := callHistory(t, stub, http.MethodPost, "/api/history/import", `{"agent":"codex","nativeId":"t1"}`)
	var snap domain.SessionSnapshot
	if status != http.StatusCreated || json.Unmarshal(raw, &snap) != nil || snap.ID != "s1" || stub.agent != domain.AgentCodex || stub.nativeID != "t1" {
		t.Fatalf("status %d body %s", status, raw)
	}
	if status, _ := callHistory(t, stub, http.MethodPost, "/api/history/import", `{"agent":"claude","nativeId":"missing"}`); status != http.StatusNotFound {
		t.Fatalf("missing: status %d", status)
	}
	if status, _ := callHistory(t, stub, http.MethodPost, "/api/history/import", `{`); status != http.StatusBadRequest {
		t.Fatalf("bad body: status %d", status)
	}
}

func TestHistoryRoutesNeedAService(t *testing.T) {
	if status, _ := callHistory(t, nil, http.MethodGet, "/api/history", ""); status == http.StatusOK {
		t.Fatal("history served without a service")
	}
}
