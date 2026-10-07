package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type fakeSessions struct {
	sessions    []domain.SessionSnapshot
	createdCwd  string
	createdAgen domain.AgentKind
	sentText    string
	steeredText string
	stoppedTask string
	interrupted bool
	continued   domain.SessionID
	err         error
	requests    []domain.Request
	answered    *app.RequestAnswer
	answeredID  domain.RequestID
	respondErr  error
	account     app.AccountInfo
	challenge   app.LoginChallenge
	accountErr  error
	quotas      []domain.QuotaSnapshot
	quota       domain.QuotaSnapshot
	reviewer    domain.ApprovalReviewer
	model       [2]string
	models      []app.ModelInfo
	modelsErr   error
}

func (f *fakeSessions) SetModel(_ context.Context, id domain.SessionID, model, effort string) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	if strings.Contains(model, " ") {
		return domain.SessionSnapshot{}, domain.ErrInvalidModel
	}
	f.model = [2]string{model, effort}
	return domain.SessionSnapshot{ID: id, Model: model, Effort: effort}, nil
}

func (f *fakeSessions) Models(_ context.Context, _ domain.AgentKind) ([]app.ModelInfo, error) {
	return f.models, f.modelsErr
}

func (f *fakeSessions) CreateSession(_ context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	f.createdAgen, f.createdCwd = agent, cwd
	s := domain.SessionSnapshot{ID: "new", Agent: agent, Cwd: cwd, Status: domain.StatusDetached}
	f.sessions = append(f.sessions, s)
	return s, nil
}
func (f *fakeSessions) ListSessions(context.Context) ([]domain.SessionSnapshot, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.sessions, nil
}
func (f *fakeSessions) GetSession(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	for _, s := range f.sessions {
		if s.ID == id {
			return s, nil
		}
	}
	return domain.SessionSnapshot{}, app.ErrSessionNotFound
}
func (f *fakeSessions) SendMessage(_ context.Context, _ domain.SessionID, text string) error {
	if f.err != nil {
		return f.err
	}
	f.sentText = text
	return nil
}
func (f *fakeSessions) Steer(_ context.Context, _ domain.SessionID, text string) error {
	if f.err != nil {
		return f.err
	}
	f.steeredText = text
	return nil
}

func (f *fakeSessions) SetApprovalReviewer(_ context.Context, id domain.SessionID, r domain.ApprovalReviewer) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	if !r.Valid() {
		return domain.SessionSnapshot{}, domain.ErrInvalidReviewer
	}
	f.reviewer = r
	return domain.SessionSnapshot{ID: id, ApprovalReviewer: r}, nil
}

func (f *fakeSessions) StopTask(_ context.Context, _ domain.SessionID, taskID string) error {
	if f.err != nil {
		return f.err
	}
	f.stoppedTask = taskID
	return nil
}

func (f *fakeSessions) Interrupt(context.Context, domain.SessionID) error {
	if f.err != nil {
		return f.err
	}
	f.interrupted = true
	return nil
}

func (f *fakeSessions) RespondRequest(_ context.Context, _ domain.SessionID, id domain.RequestID, answer app.RequestAnswer) error {
	if f.respondErr != nil {
		return f.respondErr
	}
	f.answeredID = id
	a := answer
	f.answered = &a
	return nil
}

func (f *fakeSessions) PendingRequests(context.Context) []domain.Request {
	if f.err != nil {
		return nil
	}
	return f.requests
}

func (f *fakeSessions) Account(context.Context, domain.AgentKind) (app.AccountInfo, error) {
	return f.account, f.accountErr
}

func (f *fakeSessions) StartLogin(context.Context, domain.AgentKind) (app.LoginChallenge, error) {
	return f.challenge, f.accountErr
}

func (f *fakeSessions) Quotas(context.Context) ([]domain.QuotaSnapshot, error) {
	return f.quotas, f.accountErr
}

func (f *fakeSessions) RefreshQuota(context.Context, domain.AgentKind) (domain.QuotaSnapshot, error) {
	return f.quota, f.accountErr
}

func newSessionsServer(s Sessions, events *hub.Hub) http.Handler {
	return NewServer(Config{
		Token:    testToken,
		Static:   fstest.MapFS{"index.html": {Data: []byte("app")}},
		Sessions: s,
		Events:   events,
	})
}

func authed(method, path, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	return withCookie(r, testToken)
}

func TestCreateSessionEndpoint(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions", `{"agent":"claude","cwd":"/tmp/x"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	if f.createdAgen != domain.AgentClaude || f.createdCwd != "/tmp/x" {
		t.Fatalf("created = %+v", f)
	}
	var got domain.SessionSnapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.ID != "new" {
		t.Fatalf("body = %s (%v)", rec.Body.String(), err)
	}
}

func TestCreateSessionInAMissingFolder(t *testing.T) {
	h := newSessionsServer(&fakeSessions{err: domain.FolderGone("/tmp/gone")}, nil)
	rec := do(h, authed("POST", "/api/sessions", `{"agent":"claude","cwd":"/tmp/gone"}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Folder /tmp/gone no longer exists") {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestCreateSessionBadBody(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, nil)
	rec := do(h, authed("POST", "/api/sessions", `{`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestListSessionsEndpoint(t *testing.T) {
	f := &fakeSessions{sessions: []domain.SessionSnapshot{{ID: "a"}, {ID: "b"}}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("GET", "/api/sessions", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"a"`) {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGetSessionNotFound(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, nil)
	rec := do(h, authed("GET", "/api/sessions/missing", ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestGetSessionBadRequestError(t *testing.T) {
	h := newSessionsServer(&fakeSessions{err: domain.ErrInvalidSession}, nil)
	rec := do(h, authed("GET", "/api/sessions/x", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestSendMessageEndpoint(t *testing.T) {
	f := &fakeSessions{sessions: []domain.SessionSnapshot{{ID: "a"}}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":"hi"}`))
	if rec.Code != http.StatusAccepted || f.sentText != "hi" {
		t.Fatalf("code=%d sent=%q", rec.Code, f.sentText)
	}
}

func TestSendMessageRequiresText(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, nil)
	rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":""}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestSendMessageInternalError(t *testing.T) {
	h := newSessionsServer(&fakeSessions{err: errors.New("boom")}, nil)
	rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":"hi"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestSendMessageWhileRunningConflicts(t *testing.T) {
	h := newSessionsServer(&fakeSessions{err: fmt.Errorf("%w: turn already running", domain.ErrInvalidTransition)}, nil)
	rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":"hi"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestSendMessageToARemovedWorktreeConflicts(t *testing.T) {
	h := newSessionsServer(&fakeSessions{err: domain.ErrWorktreeRemoved}, nil)
	rec := do(h, authed("POST", "/api/sessions/a/messages", `{"text":"hi"}`))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "worktree was removed") {
		t.Fatalf("code = %d %s", rec.Code, rec.Body.String())
	}
}

func TestInterruptEndpoint(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/interrupt", ""))
	if rec.Code != http.StatusAccepted || !f.interrupted {
		t.Fatalf("code=%d", rec.Code)
	}
}

func TestEventsHistoryEndpoint(t *testing.T) {
	events := hub.New()
	events.Publish(domain.Event{SessionID: "a", Type: domain.EventTurnStarted})
	events.Publish(domain.Event{SessionID: "a", Type: domain.EventTurnEnded})
	h := newSessionsServer(&fakeSessions{}, events)

	rec := do(h, authed("GET", "/api/sessions/a/events?since=1", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got []domain.Event
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || len(got) != 1 || got[0].Seq != 2 {
		t.Fatalf("body = %s (%v)", rec.Body.String(), err)
	}

	empty := do(h, authed("GET", "/api/sessions/zzz/events", ""))
	if empty.Code != http.StatusOK || strings.TrimSpace(empty.Body.String()) == "null" {
		t.Fatalf("empty history = %d %q", empty.Code, empty.Body.String())
	}
}

func TestEventsHistoryBadSince(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, hub.New())
	rec := do(h, authed("GET", "/api/sessions/a/events?since=x", ""))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestListRequestsEndpoint(t *testing.T) {
	f := &fakeSessions{requests: []domain.Request{{ID: "r1", SessionID: "a", Kind: domain.RequestPermission, State: domain.RequestPending}}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("GET", "/api/requests", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"r1"`) {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}

	empty := do(newSessionsServer(&fakeSessions{}, nil), authed("GET", "/api/requests", ""))
	if empty.Code != http.StatusOK || strings.TrimSpace(empty.Body.String()) == "null" {
		t.Fatalf("empty = %d %q", empty.Code, empty.Body.String())
	}
}

func TestRespondRequestEndpoint(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/requests/r1", `{"behavior":"allow","allowForSession":true}`))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d body=%s", rec.Code, rec.Body.String())
	}
	if f.answeredID != "r1" || f.answered == nil || !f.answered.Allow || !f.answered.AllowForSession {
		t.Fatalf("answered = %+v (%v)", f.answered, f.answeredID)
	}
}

func TestRespondRequestWithAnswers(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/requests/q1", `{"behavior":"allow","answers":{"Which?":["Alpha"]}}`))
	if rec.Code != http.StatusAccepted || !f.answered.Allow || f.answered.Answers["Which?"][0] != "Alpha" {
		t.Fatalf("code=%d answered=%+v", rec.Code, f.answered)
	}
}

func TestRespondRequestNotFound(t *testing.T) {
	h := newSessionsServer(&fakeSessions{respondErr: app.ErrRequestNotFound}, nil)
	rec := do(h, authed("POST", "/api/sessions/a/requests/x", `{"behavior":"deny","message":"no"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestRespondRequestBadBody(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, nil)
	rec := do(h, authed("POST", "/api/sessions/a/requests/r1", `{`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestGetAccountEndpoint(t *testing.T) {
	f := &fakeSessions{account: app.AccountInfo{Agent: domain.AgentCodex, LoggedIn: true, Email: "a@b.c", Plan: "plus"}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("GET", "/api/account?agent=codex", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"email":"a@b.c"`) {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestGetAccountValidatesAgent(t *testing.T) {
	h := newSessionsServer(&fakeSessions{}, nil)
	for _, q := range []string{"", "?agent=gemini"} {
		if rec := do(h, authed("GET", "/api/account"+q, "")); rec.Code != http.StatusBadRequest {
			t.Fatalf("%q: code=%d", q, rec.Code)
		}
	}
}

func TestGetAccountUnsupported(t *testing.T) {
	h := newSessionsServer(&fakeSessions{accountErr: app.ErrAccountsUnsupported}, nil)
	rec := do(h, authed("GET", "/api/account?agent=claude", ""))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestStartLoginEndpoint(t *testing.T) {
	f := &fakeSessions{challenge: app.LoginChallenge{LoginID: "l1", UserCode: "CODE", URL: "https://x"}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/agents/codex/login", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"userCode":"CODE"`) {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := do(h, authed("POST", "/api/agents/gemini/login", "")); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad agent code = %d", rec.Code)
	}
	if rec := do(newSessionsServer(&fakeSessions{accountErr: app.ErrAccountsUnsupported}, nil), authed("POST", "/api/agents/claude/login", "")); rec.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported code = %d", rec.Code)
	}
}

func TestSteerEndpoint(t *testing.T) {
	f := &fakeSessions{sessions: []domain.SessionSnapshot{{ID: "a"}}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/steer", `{"text":"go"}`))
	if rec.Code != http.StatusAccepted || f.steeredText != "go" {
		t.Fatalf("code=%d steered=%q", rec.Code, f.steeredText)
	}
	if rec := do(h, authed("POST", "/api/sessions/a/steer", `{"text":""}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty text code = %d", rec.Code)
	}
}

func TestStopTaskEndpoint(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/tasks/task-1/stop", ""))
	if rec.Code != http.StatusAccepted || f.stoppedTask != "task-1" {
		t.Fatalf("code=%d task=%q", rec.Code, f.stoppedTask)
	}
}

func TestQuotasEndpoints(t *testing.T) {
	f := &fakeSessions{
		quotas: []domain.QuotaSnapshot{{Agent: domain.AgentCodex, Windows: []domain.QuotaWindow{{Name: "primary", UsedPct: 30}}}},
		quota:  domain.QuotaSnapshot{Agent: domain.AgentCodex, Windows: []domain.QuotaWindow{{Name: "primary", UsedPct: 44}}},
	}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("GET", "/api/quotas", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"primary"`) {
		t.Fatalf("list code=%d body=%s", rec.Code, rec.Body.String())
	}
	empty := do(newSessionsServer(&fakeSessions{}, nil), authed("GET", "/api/quotas", ""))
	if empty.Code != http.StatusOK || strings.TrimSpace(empty.Body.String()) == "null" {
		t.Fatalf("empty = %d %q", empty.Code, empty.Body.String())
	}
	refresh := do(h, authed("POST", "/api/quotas/codex/refresh", ""))
	if refresh.Code != http.StatusOK || !strings.Contains(refresh.Body.String(), `"usedPct":44`) {
		t.Fatalf("refresh code=%d body=%s", refresh.Code, refresh.Body.String())
	}
	if rec := do(h, authed("POST", "/api/quotas/gemini/refresh", "")); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad agent = %d", rec.Code)
	}
	unsupported := do(newSessionsServer(&fakeSessions{accountErr: app.ErrQuotasUnsupported}, nil), authed("POST", "/api/quotas/claude/refresh", ""))
	if unsupported.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported = %d", unsupported.Code)
	}
}

func TestApprovalReviewerEndpoint(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/approval-reviewer", `{"reviewer":"auto_review"}`))
	if rec.Code != http.StatusOK || f.reviewer != domain.ReviewerAuto || !strings.Contains(rec.Body.String(), `"approvalReviewer":"auto_review"`) {
		t.Fatalf("code=%d reviewer=%q body=%s", rec.Code, f.reviewer, rec.Body.String())
	}
	if rec := do(h, authed("POST", "/api/sessions/a/approval-reviewer", `{"reviewer":"robot"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid reviewer code = %d", rec.Code)
	}
	if rec := do(h, authed("POST", "/api/sessions/a/approval-reviewer", `nope`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json code = %d", rec.Code)
	}
	f.err = app.ErrSessionNotFound
	if rec := do(h, authed("POST", "/api/sessions/a/approval-reviewer", `{"reviewer":"user"}`)); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown session code = %d", rec.Code)
	}
}

func TestModelEndpoints(t *testing.T) {
	f := &fakeSessions{models: []app.ModelInfo{{ID: "opus", Name: "Opus", Efforts: []string{"high"}}}}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("GET", "/api/agents/claude/models", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"opus"`) {
		t.Fatalf("models: %d %s", rec.Code, rec.Body.String())
	}
	f.models = nil
	if rec := do(h, authed("GET", "/api/agents/claude/models", "")); rec.Body.String() != "[]\n" {
		t.Fatalf("empty models = %q", rec.Body.String())
	}
	f.modelsErr = app.ErrModelsUnsupported
	if rec := do(h, authed("GET", "/api/agents/claude/models", "")); rec.Code != http.StatusNotImplemented {
		t.Fatalf("unsupported code = %d", rec.Code)
	}

	rec = do(h, authed("POST", "/api/sessions/a/model", `{"model":"opus","effort":"high"}`))
	if rec.Code != http.StatusOK || f.model != [2]string{"opus", "high"} || !strings.Contains(rec.Body.String(), `"effort":"high"`) {
		t.Fatalf("set model: %d %v %s", rec.Code, f.model, rec.Body.String())
	}
	if rec := do(h, authed("POST", "/api/sessions/a/model", `{"model":"bad model"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid model code = %d", rec.Code)
	}
	if rec := do(h, authed("POST", "/api/sessions/a/model", `nope`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json code = %d", rec.Code)
	}
}

func TestCreateSessionWithModel(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions", `{"agent":"claude","cwd":"/p","model":"opus","effort":"max"}`))
	if rec.Code != http.StatusCreated || f.model != [2]string{"opus", "max"} || !strings.Contains(rec.Body.String(), `"model":"opus"`) {
		t.Fatalf("create: %d %v %s", rec.Code, f.model, rec.Body.String())
	}
	f.model = [2]string{"untouched", ""}
	if rec := do(h, authed("POST", "/api/sessions", `{"agent":"claude","cwd":"/p"}`)); rec.Code != http.StatusCreated || f.model[0] != "untouched" {
		t.Fatalf("create without model: %d %v", rec.Code, f.model)
	}
	if rec := do(h, authed("POST", "/api/sessions", `{"agent":"claude","cwd":"/p","model":"bad model"}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("create with invalid model code = %d", rec.Code)
	}
}
