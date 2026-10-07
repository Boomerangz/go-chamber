package opencode

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type Runtime struct {
	server         *server
	native, cwd    string
	mu             sync.Mutex
	mapper         *mapper
	events         chan domain.Event
	done           chan struct{}
	closeOnce      sync.Once
	model, variant string
	auto           map[string]bool
}

func (r *Runtime) NativeID() string            { return r.native }
func (r *Runtime) Events() <-chan domain.Event { return r.events }
func (r *Runtime) emit(events []domain.Event) {
	for _, e := range domain.DetachItems(events) {
		select {
		case <-r.done:
			return
		case r.events <- e:
		}
	}
}
func (r *Runtime) handle(ev event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	select {
	case <-r.done:
		return
	default:
	}
	if p, ok := asked(ev); ok && r.server.allowed(r.native, p) {
		r.queueApproval(p)
		return
	}
	r.emit(r.mapper.mapEvent(ev))
}
func (r *Runtime) child(info sessionInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	select {
	case <-r.done:
		return
	default:
	}
	if r.mapper.children[info.ID] {
		return
	}
	r.mapper.children[info.ID] = true
	r.emit([]domain.Event{{SessionID: r.mapper.session, Type: domain.EventSubagentSpawned, Subagent: &domain.SubagentSpawn{ThreadID: info.ID, Title: info.Title}}})
}
func (r *Runtime) path(suffix string) string { return "/session/" + url.PathEscape(r.native) + suffix }

func (r *Runtime) Send(ctx context.Context, turn domain.TurnID, text string) error {
	return r.send(ctx, turn, text, nil)
}
func (r *Runtime) Steer(ctx context.Context, text string) error { return r.send(ctx, "", text, nil) }
func (r *Runtime) SendImages(ctx context.Context, turn domain.TurnID, text string, images []app.Image) error {
	r.mu.Lock()
	model := r.model
	r.mu.Unlock()
	models, err := r.serverModels(ctx)
	if err != nil {
		return err
	}
	supported := false
	for _, m := range models {
		if m.ID == model || model == "" && m.Default {
			supported = m.Images != nil && *m.Images
			break
		}
	}
	if !supported {
		return app.ErrImagesUnsupported
	}
	return r.send(ctx, turn, text, images)
}
func (r *Runtime) serverModels(ctx context.Context) ([]app.ModelInfo, error) {
	return r.server.models(ctx, r.cwd)
}
func (r *Runtime) send(ctx context.Context, turn domain.TurnID, text string, images []app.Image) error {
	r.mu.Lock()
	select {
	case <-r.done:
		r.mu.Unlock()
		return errors.New("opencode: session closed")
	default:
	}
	if turn != "" {
		r.mapper.begin(turn)
	}
	model, variant := r.model, r.variant
	r.mu.Unlock()
	body := map[string]any{}
	parts := []map[string]any{{"type": "text", "text": text}}
	for _, image := range images {
		u := url.URL{Scheme: "file", Path: filepath.ToSlash(image.Path)}
		parts = append(parts, map[string]any{"type": "file", "mime": image.MimeType, "url": u.String()})
	}
	body["parts"] = parts
	if model != "" {
		p, m, ok := strings.Cut(model, "/")
		if !ok || p == "" || m == "" {
			return errors.New("opencode: expected provider/model")
		}
		body["model"] = map[string]string{"providerID": p, "modelID": m}
	}
	if variant != "" {
		body["variant"] = variant
	}
	path := r.path("/prompt_async")
	// Only catalogued slash commands use /command; ordinary slash-prefixed
	// text stays a prompt, so the model can discuss paths and unknown commands.
	if strings.HasPrefix(text, "/") && len(images) == 0 {
		var cmds []app.Command
		if err := r.server.call(ctx, http.MethodGet, "/command", r.cwd, nil, &cmds); err != nil {
			return err
		}
		name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " ")
		for _, c := range cmds {
			if name == c.Name {
				path = r.path("/command")
				body["command"], body["arguments"] = name, args
				delete(body, "parts")
				if model != "" {
					body["model"] = model
				}
				break
			}
		}
	}
	if strings.HasSuffix(path, "/command") {
		go r.command(path, body)
		return nil
	}
	return r.server.call(ctx, http.MethodPost, path, r.cwd, body, nil)
}
func (r *Runtime) command(path string, body any) {
	ctx, cancel := context.WithCancel(r.server.ctx)
	defer cancel()
	go func() {
		select {
		case <-r.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	if err := r.server.call(ctx, http.MethodPost, path, r.cwd, body, nil); err != nil {
		r.mu.Lock()
		defer r.mu.Unlock()
		select {
		case <-r.done:
			return
		default:
		}
		r.emit(r.mapper.fail(err.Error()))
		r.emit(r.mapper.status(status{Type: "idle"}))
	}
}
func (r *Runtime) SetModel(_ context.Context, model, variant string) error {
	if model != "" {
		p, m, ok := strings.Cut(model, "/")
		if !ok || p == "" || m == "" {
			return errors.New("opencode: expected provider/model")
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.model, r.variant = model, variant
	return nil
}
func (r *Runtime) Interrupt(ctx context.Context) error {
	return r.server.call(ctx, http.MethodPost, r.path("/abort"), r.cwd, nil, nil)
}
func (r *Runtime) StopTask(ctx context.Context, id string) error {
	var children []sessionInfo
	if err := r.server.call(ctx, http.MethodGet, r.path("/children"), r.cwd, nil, &children); err != nil {
		return err
	}
	for _, child := range children {
		if child.ID == id {
			return r.server.call(ctx, http.MethodPost, "/session/"+url.PathEscape(id)+"/abort", r.cwd, nil, nil)
		}
	}
	return errors.New("opencode: task is not a child of this session")
}
func (r *Runtime) Respond(ctx context.Context, id domain.RequestID, answer app.RequestAnswer) error {
	r.mu.Lock()
	pending, ok := r.mapper.requests[string(id)]
	r.mu.Unlock()
	if !ok {
		return app.ErrRequestNotFound
	}
	remembered := answer.Allow && answer.AllowForSession && len(pending.Questions) == 0
	if remembered {
		r.server.remember(r.native, pending)
	}
	err := r.replyNative(ctx, pending, answer)
	if err != nil && remembered {
		r.server.forget(r.native, pending.ID)
	}
	if err == nil && remembered {
		r.mu.Lock()
		others := []request{}
		for _, p := range r.mapper.requests {
			if p.ID != pending.ID && r.server.allowed(r.native, p) {
				others = append(others, p)
			}
		}
		r.mu.Unlock()
		for _, p := range others {
			r.mu.Lock()
			r.queueApproval(p)
			r.mu.Unlock()
		}
	}
	return err
}

// queueApproval is called with the runtime lock held, including during replay.
func (r *Runtime) queueApproval(p request) {
	if r.auto == nil {
		r.auto = map[string]bool{}
	}
	if r.auto[p.ID] {
		return
	}
	r.auto[p.ID] = true
	go r.approveRemembered(p)
}
func (r *Runtime) approveRemembered(p request) {
	if err := r.replyNative(r.server.ctx, p, app.RequestAnswer{Allow: true}); err != nil {
		var status *httpError
		if errors.As(err, &status) && status.Status == http.StatusNotFound {
			return
		}
		_ = r.Close()
	}
}
func (r *Runtime) replyNative(ctx context.Context, pending request, answer app.RequestAnswer) error {
	id := domain.RequestID(pending.ID)
	path := "/permission/" + url.PathEscape(string(id)) + "/reply"
	body := map[string]any{}
	if len(pending.Questions) > 0 {
		path = "/question/" + url.PathEscape(string(id)) + "/reply"
		if !answer.Allow {
			path = "/question/" + url.PathEscape(string(id)) + "/reject"
		} else {
			answers := make([][]string, len(pending.Questions))
			for i, q := range pending.Questions {
				answers[i] = answer.Answers[q.Question]
				if answers[i] == nil {
					answers[i] = []string{}
				}
			}
			body["answers"] = answers
		}
	} else {
		reply := "reject"
		if answer.Allow {
			reply = "once"
		}
		body["reply"] = reply
		if answer.Message != "" {
			body["message"] = answer.Message
		}
	}
	if pending.V2 {
		if len(pending.Questions) > 0 {
			path = "/api" + r.path("/question/") + url.PathEscape(string(id)) + "/reply"
			if !answer.Allow {
				path = "/api" + r.path("/question/") + url.PathEscape(string(id)) + "/reject"
			}
		} else {
			path = "/api" + r.path("/permission/") + url.PathEscape(string(id)) + "/reply"
		}
	}
	return r.server.call(ctx, http.MethodPost, path, r.cwd, body, nil)
}
func (r *Runtime) Close() error {
	r.closeOnce.Do(func() {
		close(r.done)
		r.mu.Lock()
		close(r.events)
		r.mu.Unlock()
		r.server.mu.Lock()
		if r.server.runtimes[r.native] == r {
			delete(r.server.runtimes, r.native)
		}
		r.server.mu.Unlock()
	})
	return nil
}

func (r *Runtime) reconcile(ctx context.Context, replayUsers bool, initial ...[]transcript) error {
	var msgs []transcript
	if len(initial) > 0 {
		msgs = initial[0]
	} else if err := r.server.call(ctx, http.MethodGet, r.path("/message"), r.cwd, nil, &msgs); err != nil {
		return err
	}
	var states map[string]status
	if err := r.server.call(ctx, http.MethodGet, "/session/status", r.cwd, nil, &states); err != nil {
		return err
	}
	r.mu.Lock()
	select {
	case <-r.done:
		r.mu.Unlock()
		return nil
	default:
	}
	if states[r.native].Type != "" && states[r.native].Type != "idle" && r.mapper.turn == "" {
		r.mapper.begin(domain.TurnID("native-" + r.native))
		r.emit([]domain.Event{{SessionID: r.mapper.session, Type: domain.EventTurnStarted}})
	}
	r.mapper.replayUsers = replayUsers
	for _, msg := range msgs {
		r.emit(r.mapper.message(msg.Info))
		for _, p := range msg.Parts {
			r.emit(r.mapper.replayPart(p))
		}
	}
	r.mapper.replayUsers = false
	r.mu.Unlock()
	// The native endpoint omits idle sessions. Decode into a fresh map so a
	// session that became idle during replay does not retain its old status.
	states = nil
	if err := r.server.call(ctx, http.MethodGet, "/session/status", r.cwd, nil, &states); err != nil {
		return err
	}
	for _, kind := range []string{"permission", "question"} {
		var pending []request
		if err := r.server.call(ctx, http.MethodGet, "/"+kind, r.cwd, nil, &pending); err != nil {
			return err
		}
		var v2 struct {
			Data []request `json:"data"`
		}
		if err := r.server.call(ctx, http.MethodGet, "/api/"+kind+"/request", r.cwd, nil, &v2); err != nil {
			return err
		}
		for _, p := range v2.Data {
			p.V2 = true
			if kind == "permission" {
				p.Permission, p.Patterns, p.Always = p.Action, p.Resources, p.Save
			}
			pending = append(pending, p)
		}
		seen := map[string]bool{}
		r.mu.Lock()
		for _, p := range pending {
			if p.SessionID == r.native {
				seen[p.ID] = true
				if r.server.allowed(r.native, p) {
					r.queueApproval(p)
				} else {
					r.emit(r.mapper.openRequest(p))
				}
			}
		}
		for id, p := range r.mapper.requests {
			if (len(p.Questions) > 0) == (kind == "question") && !seen[id] {
				r.emit(r.mapper.resolveRequest(id, domain.RequestStale))
			}
		}
		r.mu.Unlock()
	}

	var children []sessionInfo
	if err := r.server.call(ctx, http.MethodGet, r.path("/children"), r.cwd, nil, &children); err != nil {
		return err
	}
	for _, child := range children {
		r.child(child)
	}
	st := states[r.native]
	if st.Type == "" {
		st.Type = "idle"
	}
	{
		r.mu.Lock()
		if st.Type != "idle" && r.mapper.turn == "" {
			r.mapper.begin(domain.TurnID("native-" + r.native))
			r.emit([]domain.Event{{SessionID: r.mapper.session, Type: domain.EventTurnStarted}})
		}
		r.emit(r.mapper.status(st))
		r.mu.Unlock()
	}
	return nil
}

var _ app.AgentRuntime = (*Runtime)(nil)
var _ app.ModelSetter = (*Runtime)(nil)
var _ app.ImageSender = (*Runtime)(nil)
