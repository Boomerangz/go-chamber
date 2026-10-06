package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Sessions is the subset of the session manager the HTTP API needs.
type Sessions interface {
	CreateSession(ctx context.Context, agent domain.AgentKind, cwd string) (domain.SessionSnapshot, error)
	ListSessions(ctx context.Context) ([]domain.SessionSnapshot, error)
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	SendMessage(ctx context.Context, id domain.SessionID, text string) error
	SendInput(ctx context.Context, id domain.SessionID, text string, images []app.Image) error
	Steer(ctx context.Context, id domain.SessionID, text string) error
	Interrupt(ctx context.Context, id domain.SessionID) error
	Continue(ctx context.Context, id domain.SessionID) error
	SetAutoContinue(ctx context.Context, id domain.SessionID, on bool) (domain.SessionSnapshot, error)
	Fork(ctx context.Context, id domain.SessionID) (domain.SessionSnapshot, error)
	StopTask(ctx context.Context, id domain.SessionID, taskID string) error
	SetApprovalReviewer(ctx context.Context, id domain.SessionID, r domain.ApprovalReviewer) (domain.SessionSnapshot, error)
	RespondRequest(ctx context.Context, id domain.SessionID, requestID domain.RequestID, answer app.RequestAnswer) error
	PendingRequests(ctx context.Context) []domain.Request
	Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error)
	StartLogin(ctx context.Context, agent domain.AgentKind) (app.LoginChallenge, error)
	Quotas(ctx context.Context) ([]domain.QuotaSnapshot, error)
	RefreshQuota(ctx context.Context, agent domain.AgentKind) (domain.QuotaSnapshot, error)
	SetModel(ctx context.Context, id domain.SessionID, model, effort string) (domain.SessionSnapshot, error)
	SetPermissionMode(ctx context.Context, id domain.SessionID, mode string) (domain.SessionSnapshot, error)
	Models(ctx context.Context, agent domain.AgentKind) ([]app.ModelInfo, error)
}

func (s *server) routes() {
	mux := s.mux
	mux.HandleFunc("GET /api/health", s.health)
	if s.cfg.Sessions != nil {
		mux.HandleFunc("GET /api/sessions", s.listSessions)
		mux.HandleFunc("POST /api/sessions", s.createSession)
		mux.HandleFunc("GET /api/sessions/{id}", s.getSession)
		mux.HandleFunc("POST /api/sessions/{id}/messages", s.sendMessage)
		mux.HandleFunc("POST /api/sessions/{id}/steer", s.steer)
		mux.HandleFunc("POST /api/sessions/{id}/tasks/{taskId}/stop", s.stopTask)
		mux.HandleFunc("POST /api/sessions/{id}/interrupt", s.interrupt)
		mux.HandleFunc("POST /api/sessions/{id}/continue", s.continueSession)
		mux.HandleFunc("POST /api/sessions/{id}/auto-continue", s.setAutoContinue)
		mux.HandleFunc("POST /api/sessions/{id}/fork", s.fork)
		mux.HandleFunc("POST /api/sessions/{id}/approval-reviewer", s.setApprovalReviewer)
		mux.HandleFunc("POST /api/sessions/{id}/model", s.setModel)
		mux.HandleFunc("POST /api/sessions/{id}/permission-mode", s.setPermissionMode)
		mux.HandleFunc("GET /api/agents/{agent}/models", s.listModels)
		mux.HandleFunc("GET /api/sessions/{id}/events", s.sessionEvents)
		mux.HandleFunc("POST /api/sessions/{id}/requests/{requestId}", s.respondRequest)
		mux.HandleFunc("GET /api/requests", s.listRequests)
		mux.HandleFunc("GET /api/account", s.getAccount)
		mux.HandleFunc("POST /api/agents/{agent}/login", s.startLogin)
		mux.HandleFunc("GET /api/quotas", s.listQuotas)
		mux.HandleFunc("POST /api/quotas/{agent}/refresh", s.refreshQuota)
	}
	if s.cfg.Events != nil {
		mux.HandleFunc("GET /api/ws", s.websocket)
	}
	if s.cfg.Terminals != nil {
		mux.HandleFunc("GET /api/terminals", s.listTerminals)
		mux.HandleFunc("POST /api/terminals", s.openTerminal)
		mux.HandleFunc("DELETE /api/terminals/{id}", s.closeTerminal)
		mux.HandleFunc("GET /api/terminals/{id}/pty", s.terminalPTY)
	}
	if s.cfg.Search != nil {
		mux.HandleFunc("GET /api/search", s.searchMessages)
	}
	if s.cfg.Folders != nil {
		mux.HandleFunc("GET /api/folders", s.listFolders)
	}
	mux.HandleFunc("/api/", http.NotFound)
	mux.Handle("/", spaHandler(s.cfg.Static))
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) listSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := s.cfg.Sessions.ListSessions(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sessions)
}

func (s *server) createSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Agent  domain.AgentKind `json:"agent"`
		Cwd    string           `json:"cwd"`
		Model  string           `json:"model"`
		Effort string           `json:"effort"`
		Mode   string           `json:"permissionMode"`
	}
	if !decode(w, r, &body) {
		return
	}
	session, err := s.cfg.Sessions.CreateSession(r.Context(), body.Agent, body.Cwd)
	if err != nil {
		s.fail(w, err)
		return
	}
	if body.Model != "" || body.Effort != "" {
		if session, err = s.cfg.Sessions.SetModel(r.Context(), session.ID, body.Model, body.Effort); err != nil {
			s.fail(w, err)
			return
		}
	}
	if body.Mode != "" {
		if session, err = s.cfg.Sessions.SetPermissionMode(r.Context(), session.ID, body.Mode); err != nil {
			s.fail(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, session)
}

func (s *server) setModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model  string `json:"model"`
		Effort string `json:"effort"`
	}
	if !decode(w, r, &body) {
		return
	}
	session, err := s.cfg.Sessions.SetModel(r.Context(), sessionID(r), body.Model, body.Effort)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (s *server) listModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.cfg.Sessions.Models(r.Context(), domain.AgentKind(r.PathValue("agent")))
	if err != nil {
		s.fail(w, err)
		return
	}
	if models == nil {
		models = []app.ModelInfo{}
	}
	writeJSON(w, http.StatusOK, models)
}

func (s *server) getSession(w http.ResponseWriter, r *http.Request) {
	session, err := s.cfg.Sessions.GetSession(r.Context(), sessionID(r))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (s *server) sendMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text   string   `json:"text"`
		Images []string `json:"images"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Text == "" && len(body.Images) == 0 {
		writeJSON(w, http.StatusBadRequest, errorBody{"text is required"})
		return
	}
	send := func() error { return s.cfg.Sessions.SendMessage(r.Context(), sessionID(r), body.Text) }
	if len(body.Images) > 0 && s.cfg.ImagesDir != "" {
		images, err := s.resolveImages(r, body.Images)
		if errors.Is(err, errUnknownImage) {
			writeJSON(w, http.StatusBadRequest, errorBody{err.Error()})
			return
		}
		if err != nil {
			s.fail(w, err)
			return
		}
		send = func() error { return s.cfg.Sessions.SendInput(r.Context(), sessionID(r), body.Text, images) }
	}
	if err := send(); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) steer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Text == "" {
		writeJSON(w, http.StatusBadRequest, errorBody{"text is required"})
		return
	}
	if err := s.cfg.Sessions.Steer(r.Context(), sessionID(r), body.Text); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) setApprovalReviewer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Reviewer domain.ApprovalReviewer `json:"reviewer"`
	}
	if !decode(w, r, &body) {
		return
	}
	snap, err := s.cfg.Sessions.SetApprovalReviewer(r.Context(), sessionID(r), body.Reviewer)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *server) stopTask(w http.ResponseWriter, r *http.Request) {
	if err := s.cfg.Sessions.StopTask(r.Context(), sessionID(r), r.PathValue("taskId")); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) interrupt(w http.ResponseWriter, r *http.Request) {
	if err := s.cfg.Sessions.Interrupt(r.Context(), sessionID(r)); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) continueSession(w http.ResponseWriter, r *http.Request) {
	if err := s.cfg.Sessions.Continue(r.Context(), sessionID(r)); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) setAutoContinue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		On bool `json:"on"`
	}
	if !decode(w, r, &body) {
		return
	}
	snap, err := s.cfg.Sessions.SetAutoContinue(r.Context(), sessionID(r), body.On)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *server) fork(w http.ResponseWriter, r *http.Request) {
	snap, err := s.cfg.Sessions.Fork(r.Context(), sessionID(r))
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, snap)
}

func (s *server) sessionEvents(w http.ResponseWriter, r *http.Request) {
	since := domain.Seq(0)
	if raw := r.URL.Query().Get("since"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody{"since must be an integer"})
			return
		}
		since = domain.Seq(n)
	}
	events := replay(s.cfg.Events.History(sessionID(r), since))
	if events == nil {
		events = []domain.Event{}
	}
	writeJSON(w, http.StatusOK, events)
}

// replay drops text deltas for items a later item.updated replaces whole,
// as the client fold does: a long session's history is mostly fragments.
func replay(events []domain.Event) []domain.Event {
	last := map[domain.ItemID]domain.Seq{}
	for _, ev := range events {
		if ev.Type == domain.EventItemUpdated && ev.Item != nil {
			last[ev.Item.ID] = ev.Seq
		}
	}
	out := events[:0]
	for _, ev := range events {
		if ev.Type == domain.EventTextDelta && ev.Delta != nil && ev.Seq < last[ev.Delta.ItemID] {
			continue
		}
		out = append(out, ev)
	}
	return out
}

func (s *server) listRequests(w http.ResponseWriter, r *http.Request) {
	requests := s.cfg.Sessions.PendingRequests(r.Context())
	if requests == nil {
		requests = []domain.Request{}
	}
	writeJSON(w, http.StatusOK, requests)
}

func (s *server) respondRequest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Behavior        string              `json:"behavior"`
		Message         string              `json:"message"`
		AllowForSession bool                `json:"allowForSession"`
		Answers         map[string][]string `json:"answers"`
		Content         json.RawMessage     `json:"content"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Behavior != "allow" && body.Behavior != "deny" {
		writeJSON(w, http.StatusBadRequest, errorBody{"behavior must be allow or deny"})
		return
	}
	answer := app.RequestAnswer{
		Allow:           body.Behavior == "allow",
		Message:         body.Message,
		AllowForSession: body.AllowForSession,
		Answers:         body.Answers,
		Content:         body.Content,
	}
	requestID := domain.RequestID(r.PathValue("requestId"))
	if err := s.cfg.Sessions.RespondRequest(r.Context(), sessionID(r), requestID, answer); err != nil {
		s.fail(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *server) getAccount(w http.ResponseWriter, r *http.Request) {
	agent := domain.AgentKind(r.URL.Query().Get("agent"))
	if !agent.Valid() {
		writeJSON(w, http.StatusBadRequest, errorBody{"agent must be claude or codex"})
		return
	}
	info, err := s.cfg.Sessions.Account(r.Context(), agent)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *server) startLogin(w http.ResponseWriter, r *http.Request) {
	agent := domain.AgentKind(r.PathValue("agent"))
	if !agent.Valid() {
		writeJSON(w, http.StatusBadRequest, errorBody{"agent must be claude or codex"})
		return
	}
	challenge, err := s.cfg.Sessions.StartLogin(r.Context(), agent)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, challenge)
}

func (s *server) listQuotas(w http.ResponseWriter, r *http.Request) {
	quotas, err := s.cfg.Sessions.Quotas(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	if quotas == nil {
		quotas = []domain.QuotaSnapshot{}
	}
	writeJSON(w, http.StatusOK, quotas)
}

func (s *server) refreshQuota(w http.ResponseWriter, r *http.Request) {
	agent := domain.AgentKind(r.PathValue("agent"))
	if !agent.Valid() {
		writeJSON(w, http.StatusBadRequest, errorBody{"agent must be claude or codex"})
		return
	}
	quota, err := s.cfg.Sessions.RefreshQuota(r.Context(), agent)
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, quota)
}

func (s *server) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, app.ErrSessionNotFound), errors.Is(err, app.ErrRequestNotFound),
		errors.Is(err, app.ErrTerminalNotFound):
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
	case errors.Is(err, domain.ErrInvalidSession), errors.Is(err, domain.ErrInvalidTerminal),
		errors.Is(err, domain.ErrInvalidReviewer), errors.Is(err, domain.ErrInvalidModel),
		errors.Is(err, domain.ErrInvalidPermissionMode),
		errors.Is(err, app.ErrInvalidTerminalSize), errors.Is(err, app.ErrTitleTooLong):
		writeJSON(w, http.StatusBadRequest, errorBody{err.Error()})
	case errors.Is(err, app.ErrFolderNotFound):
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
	case errors.Is(err, app.ErrInvalidFolder):
		writeJSON(w, http.StatusBadRequest, errorBody{err.Error()})
	case errors.Is(err, app.ErrFolderForbidden):
		writeJSON(w, http.StatusForbidden, errorBody{err.Error()})
	case errors.Is(err, domain.ErrTerminalExited), errors.Is(err, domain.ErrInvalidTransition),
		errors.Is(err, domain.ErrSessionBusy):
		writeJSON(w, http.StatusConflict, errorBody{err.Error()})
	case errors.Is(err, app.ErrAccountsUnsupported), errors.Is(err, app.ErrQuotasUnsupported),
		errors.Is(err, app.ErrModelsUnsupported), errors.Is(err, app.ErrImagesUnsupported),
		errors.Is(err, app.ErrDeleteUnsupported):
		writeJSON(w, http.StatusNotImplemented, errorBody{err.Error()})
	default:
		writeJSON(w, http.StatusInternalServerError, errorBody{err.Error()})
	}
}

func sessionID(r *http.Request) domain.SessionID {
	return domain.SessionID(r.PathValue("id"))
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{"invalid JSON body"})
		return false
	}
	return true
}

type errorBody struct {
	Error string `json:"error"`
}
