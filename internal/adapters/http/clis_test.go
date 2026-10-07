package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// cliSessions reports codex as not installed.
type cliSessions struct{ *fakeSessions }

func (cliSessions) CLIs() []app.CLIStatus {
	return []app.CLIStatus{
		{Agent: domain.AgentClaude, Found: true, Path: "/bin/claude"},
		{Agent: domain.AgentCodex, Hint: "npm install -g @openai/codex"},
	}
}

func (cliSessions) CreateSession(_ context.Context, agent domain.AgentKind, _ string) (domain.SessionSnapshot, error) {
	return domain.SessionSnapshot{}, domain.CLIMissing(agent)
}

func TestAgentsEndpointSaysWhichCLIsAreInstalled(t *testing.T) {
	h := newSessionsServer(cliSessions{&fakeSessions{}}, nil)
	rec := do(h, authed("GET", "/api/agents", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body = %s", rec.Code, rec.Body.String())
	}
	var got []app.CLIStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !got[0].Found || got[1].Found || got[1].Hint == "" {
		t.Fatalf("agents = %+v", got)
	}
}

func TestDiagnosticsListTheCLIs(t *testing.T) {
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Sessions: cliSessions{&fakeSessions{}}})
	rec := do(h, authed("GET", "/api/diagnostics", ""))
	var body struct {
		CLIs []app.CLIStatus `json:"clis"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.CLIs) != 2 || body.CLIs[0].Path != "/bin/claude" || body.CLIs[1].Found {
		t.Fatalf("clis = %+v", body.CLIs)
	}
}

func TestDiagnosticsWithoutSessionsListNoCLIs(t *testing.T) {
	h := NewServer(Config{Token: testToken, Static: fstest.MapFS{}})
	rec := do(h, authed("GET", "/api/diagnostics", ""))
	var body struct {
		CLIs []app.CLIStatus `json:"clis"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.CLIs == nil || len(body.CLIs) != 0 {
		t.Fatalf("clis = %+v, %v (%s)", body.CLIs, err, rec.Body.String())
	}
}

func TestCreatingASessionWithoutItsCLIIsRefusedInPlainWords(t *testing.T) {
	h := newSessionsServer(cliSessions{&fakeSessions{}}, nil)
	rec := do(h, authed("POST", "/api/sessions", `{"agent":"codex","cwd":"/tmp/x"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d", rec.Code)
	}
	var body errorBody
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error != domain.CLIMissing(domain.AgentCodex).Error() || body.Code != "cli_missing" {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
