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
	// applied is the model selection the native session last took.
	applied string
	auto    map[string]bool
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
func (r *Runtime) path(suffix string) string { return sessionPath(r.native, suffix) }

func (r *Runtime) Send(ctx context.Context, turn domain.TurnID, text string) error {
	return r.send(ctx, turn, text, nil, "")
}
func (r *Runtime) Steer(ctx context.Context, text string) error {
	return r.send(ctx, "", text, nil, "steer")
}
func (r *Runtime) SendImages(ctx context.Context, turn domain.TurnID, text string, images []app.Image) error {
	r.mu.Lock()
	model := r.model
	r.mu.Unlock()
	models, err := r.server.models(ctx, r.cwd)
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
	return r.send(ctx, turn, text, images, "")
}
func (r *Runtime) send(ctx context.Context, turn domain.TurnID, text string, images []app.Image, delivery string) error {
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
	if err := r.selectModel(ctx, model, variant); err != nil {
		return err
	}
	// Only catalogued slash commands run as commands; other slash-prefixed
	// text stays a prompt, so the model can discuss paths and unknown commands.
	if strings.HasPrefix(text, "/") && len(images) == 0 {
		cmds, err := r.server.commands(ctx, r.cwd)
		if err != nil {
			return err
		}
		name, args, _ := strings.Cut(strings.TrimPrefix(text, "/"), " ")
		for _, c := range cmds {
			if name == c.Name {
				return r.server.call(ctx, http.MethodPost, r.path("/command"), map[string]any{"name": name, "text": args}, nil)
			}
		}
	}
	body := map[string]any{"text": text}
	if len(images) > 0 {
		files := []map[string]string{}
		for _, image := range images {
			u := url.URL{Scheme: "file", Path: filepath.ToSlash(image.Path)}
			files = append(files, map[string]string{"uri": u.String(), "name": filepath.Base(image.Path)})
		}
		body["files"] = files
	}
	if delivery != "" {
		body["delivery"] = delivery
	}
	return r.server.call(ctx, http.MethodPost, r.path("/prompt"), body, nil)
}

func modelKey(model, variant string) string { return model + "\x00" + variant }

// selectModel switches the native session's model before a prompt. The
// selection sticks to the session, so it is sent only when it changes; an
// empty model goes back to the configured default.
func (r *Runtime) selectModel(ctx context.Context, model, variant string) error {
	key := modelKey(model, variant)
	r.mu.Lock()
	same := key == r.applied
	r.mu.Unlock()
	if same {
		return nil
	}
	ref := &modelRef{}
	if model == "" {
		var err error
		if ref, err = r.server.defaultModel(ctx, r.cwd); err != nil {
			return err
		}
	} else {
		ref.ProviderID, ref.ID, _ = strings.Cut(model, "/")
	}
	if ref != nil {
		ref.Variant = variant
		if err := r.server.call(ctx, http.MethodPost, r.path("/model"), map[string]any{"model": ref}, nil); err != nil {
			return err
		}
	}
	r.mu.Lock()
	r.applied = key
	r.mu.Unlock()
	return nil
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
	return r.server.call(ctx, http.MethodPost, r.path("/interrupt"), nil, nil)
}
func (r *Runtime) children(ctx context.Context) ([]sessionInfo, error) {
	var list envelope[[]sessionInfo]
	err := r.server.call(ctx, http.MethodGet, "/api/session?"+url.Values{"parentID": {r.native}}.Encode(), nil, &list)
	return list.Data, err
}
func (r *Runtime) StopTask(ctx context.Context, id string) error {
	children, err := r.children(ctx)
	if err != nil {
		return err
	}
	for _, child := range children {
		if child.ID == id {
			return r.server.call(ctx, http.MethodPost, sessionPath(id, "/interrupt"), nil, nil)
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
	remembered := answer.Allow && answer.AllowForSession && !pending.Form
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
	if pending.Form {
		path := r.path("/form/" + url.PathEscape(pending.ID))
		if !answer.Allow {
			return r.server.call(ctx, http.MethodDelete, path, nil, nil)
		}
		return r.server.call(ctx, http.MethodPost, path+"/reply", map[string]any{"answer": formAnswer(pending, answer.Answers)}, nil)
	}
	body := map[string]any{"decision": "reject"}
	if answer.Allow {
		body["decision"] = "once"
	}
	if answer.Message != "" {
		body["message"] = answer.Message
	}
	return r.server.call(ctx, http.MethodPost, r.path("/permission/"+url.PathEscape(pending.ID)+"/reply"), body, nil)
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

// running reports whether the native session is executing; idle sessions are
// absent from the active list.
func (r *Runtime) running(ctx context.Context) (bool, error) {
	var active envelope[map[string]struct {
		Type string `json:"type"`
	}]
	if err := r.server.call(ctx, http.MethodGet, "/api/session/active", nil, &active); err != nil {
		return false, err
	}
	_, ok := active.Data[r.native]
	return ok, nil
}

// reconcile recovers what an event gap may have hidden: history, usage,
// pending permissions and forms, children, and whether a turn still runs.
func (r *Runtime) reconcile(ctx context.Context, replayUsers bool, initial ...[]message) error {
	var msgs []message
	if len(initial) > 0 {
		msgs = initial[0]
	} else {
		var err error
		if msgs, err = r.server.history(ctx, r.native); err != nil {
			return err
		}
	}
	var info envelope[sessionInfo]
	if err := r.server.call(ctx, http.MethodGet, r.path(""), nil, &info); err != nil {
		return err
	}
	busy, err := r.running(ctx)
	if err != nil {
		return err
	}
	r.mu.Lock()
	select {
	case <-r.done:
		r.mu.Unlock()
		return nil
	default:
	}
	if busy && r.mapper.turn == "" {
		r.mapper.begin(domain.TurnID("native-" + r.native))
		r.emit([]domain.Event{{SessionID: r.mapper.session, Type: domain.EventTurnStarted}})
	}
	r.mapper.replayUsers = replayUsers
	for _, msg := range msgs {
		r.emit(r.mapper.message(msg))
	}
	r.mapper.replayUsers = false
	r.emit(r.mapper.setUsage(info.Data.Cost, info.Data.Tokens))
	r.mu.Unlock()
	// Ask again: a turn that ended while history was read must not linger.
	if busy, err = r.running(ctx); err != nil {
		return err
	}
	for _, form := range []bool{false, true} {
		path := "/api/permission/request"
		if form {
			path = "/api/form"
		}
		var pending envelope[[]request]
		if err := r.server.call(ctx, http.MethodGet, located(path, r.cwd), nil, &pending); err != nil {
			return err
		}
		seen := map[string]bool{}
		r.mu.Lock()
		for _, p := range pending.Data {
			if p.SessionID != r.native {
				continue
			}
			p.Form = form
			seen[p.ID] = true
			if r.server.allowed(r.native, p) {
				r.queueApproval(p)
			} else {
				r.emit(r.mapper.openRequest(p))
			}
		}
		for id, p := range r.mapper.requests {
			if p.Form == form && !seen[id] {
				r.emit(r.mapper.resolveRequest(id, domain.RequestStale))
			}
		}
		r.mu.Unlock()
	}
	children, err := r.children(ctx)
	if err != nil {
		return err
	}
	for _, child := range children {
		r.child(child)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if busy && r.mapper.turn == "" {
		r.mapper.begin(domain.TurnID("native-" + r.native))
		r.emit([]domain.Event{{SessionID: r.mapper.session, Type: domain.EventTurnStarted}})
	}
	if !busy {
		r.emit(r.mapper.idle())
	}
	return nil
}

var _ app.AgentRuntime = (*Runtime)(nil)
var _ app.ModelSetter = (*Runtime)(nil)
var _ app.ImageSender = (*Runtime)(nil)
