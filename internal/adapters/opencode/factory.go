package opencode

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// Factory owns one lazily started local server; runtimes are session facades.
type Factory struct {
	Binary      string
	Args        []string
	Env         []string
	Stderr      io.Writer
	InitTimeout time.Duration
	mu          sync.Mutex
	server      *server
	closed      bool
}
type server struct {
	base, password string
	client         *http.Client
	cmd            *exec.Cmd
	ctx            context.Context
	cancel         context.CancelFunc
	mu             sync.Mutex
	runtimes       map[string]*Runtime
	orphans        map[string][]event
	grants         map[string][]permissionGrant
	processDone    chan struct{}
}

func (f *Factory) ensure(ctx context.Context) (*server, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil, errors.New("opencode: factory closed")
	}
	if f.server != nil {
		select {
		case <-f.server.processDone:
			f.server = nil
		default:
			return f.server, nil
		}
	}
	binary := f.Binary
	if binary == "" {
		binary = "opencode"
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	s := &server{password: hex.EncodeToString(b), client: &http.Client{Timeout: 15 * time.Second}, runtimes: map[string]*Runtime{}, orphans: map[string][]event{}, processDone: make(chan struct{})}
	s.ctx, s.cancel = context.WithCancel(context.Background())
	s.cmd = exec.Command(binary, append([]string{"serve", "--hostname", "127.0.0.1", "--port", "0"}, f.Args...)...)
	s.cmd.Env = append(append(os.Environ(), f.Env...), "OPENCODE_SERVER_USERNAME=opencode", "OPENCODE_SERVER_PASSWORD="+s.password)
	s.cmd.Stderr = f.Stderr
	if s.cmd.Stderr == nil {
		s.cmd.Stderr = io.Discard
	}
	out, err := s.cmd.StdoutPipe()
	if err != nil {
		s.cancel()
		return nil, err
	}
	if err = s.cmd.Start(); err != nil {
		s.cancel()
		return nil, fmt.Errorf("opencode: start: %w", err)
	}
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if _, after, ok := strings.Cut(line, "http://127.0.0.1:"); ok && len(strings.Fields(after)) > 0 {
				select {
				case ready <- "http://127.0.0.1:" + strings.Fields(after)[0]:
				default:
				}
			}
		}
	}()
	go func() { _ = s.cmd.Wait(); s.cancel(); close(s.processDone); s.closeRuntimes() }()
	timeout := f.InitTimeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case s.base = <-ready:
	case <-ctx.Done():
		s.stop()
		return nil, ctx.Err()
	case <-s.processDone:
		return nil, errors.New("opencode: server exited during startup")
	case <-timer.C:
		s.stop()
		return nil, errors.New("opencode: server startup timed out")
	}
	if _, err := url.ParseRequestURI(s.base); err != nil {
		s.stop()
		return nil, fmt.Errorf("opencode: invalid server address: %w", err)
	}
	stream, err := s.openEvents(ctx)
	if err != nil {
		s.stop()
		return nil, err
	}
	f.server = s
	go s.readEvents(stream)
	return s, nil
}

func (f *Factory) Start(ctx context.Context, req app.StartRequest) (app.AgentRuntime, error) {
	s, err := f.ensure(ctx)
	if err != nil {
		return nil, err
	}
	var resp envelope[sessionInfo]
	switch {
	case req.NativeID == "":
		err = s.call(ctx, http.MethodPost, "/api/session", map[string]any{"location": map[string]string{"directory": req.Cwd}}, &resp)
	case req.Fork:
		err = s.call(ctx, http.MethodPost, sessionPath(req.NativeID, "/fork"), map[string]any{}, &resp)
	default:
		err = s.call(ctx, http.MethodGet, sessionPath(req.NativeID, ""), nil, &resp)
	}
	if err != nil {
		return nil, err
	}
	info := resp.Data
	if info.ID == "" {
		return nil, errors.New("opencode: empty native session id")
	}
	cwd := info.Location.Directory
	if cwd == "" {
		cwd = req.Cwd
	}
	history, err := s.history(ctx, info.ID)
	if err != nil {
		return nil, err
	}
	// Attach cannot wait for a consumer that starts only after Start returns.
	// Reserve room for the complete initial replay plus live events.
	capacity := 4096 + 2*len(history)
	for _, msg := range history {
		capacity += 3 * len(msg.Content)
	}
	rt := &Runtime{server: s, native: info.ID, cwd: cwd, events: make(chan domain.Event, capacity), done: make(chan struct{}), mapper: newMapper(req.SessionID, req.Passive || req.Fork), model: req.Model, variant: req.Effort}
	if req.NativeID == "" {
		// A new session already runs on the default model.
		rt.applied = modelKey("", "")
	}
	s.mu.Lock()
	if prev := s.runtimes[info.ID]; prev != nil {
		s.mu.Unlock()
		return prev, nil
	}
	s.runtimes[info.ID] = rt
	buffered := s.orphans[info.ID]
	delete(s.orphans, info.ID)
	s.mu.Unlock()
	if err = rt.reconcile(ctx, req.Passive || req.Fork, history); err != nil {
		_ = rt.Close()
		return nil, err
	}
	for _, ev := range buffered {
		rt.handle(ev)
	}
	return rt, nil
}
func sessionPath(id, suffix string) string { return "/api/session/" + url.PathEscape(id) + suffix }

// located scopes a catalog request to a project directory.
func located(path, cwd string) string {
	if cwd == "" {
		return path
	}
	return path + "?" + url.Values{"location[directory]": {cwd}}.Encode()
}

// history reads every stored message, oldest first. The next cursor is set
// even on the last page, so a short page ends the walk.
func (s *server) history(ctx context.Context, native string) ([]message, error) {
	const limit = 200
	var all []message
	query := url.Values{"order": {"asc"}, "limit": {fmt.Sprint(limit)}}
	for {
		var page struct {
			Data   []message `json:"data"`
			Cursor struct {
				Next string `json:"next"`
			} `json:"cursor"`
		}
		if err := s.call(ctx, http.MethodGet, sessionPath(native, "/message?"+query.Encode()), nil, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Data...)
		if len(page.Data) < limit || page.Cursor.Next == "" {
			return all, nil
		}
		query = url.Values{"cursor": {page.Cursor.Next}, "limit": {fmt.Sprint(limit)}}
	}
}

func (f *Factory) Close() error {
	f.mu.Lock()
	f.closed = true
	s := f.server
	f.mu.Unlock()
	if s != nil {
		s.stop()
	}
	return nil
}
func (s *server) stop() {
	s.cancel()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	<-s.processDone
	s.client.CloseIdleConnections()
}
func (s *server) closeRuntimes() {
	s.mu.Lock()
	all := make([]*Runtime, 0, len(s.runtimes))
	for _, rt := range s.runtimes {
		all = append(all, rt)
	}
	s.mu.Unlock()
	for _, rt := range all {
		_ = rt.Close()
	}
}

type envelope[T any] struct {
	Data T `json:"data"`
}

func (s *server) call(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(b))
	}
	r, err := http.NewRequestWithContext(ctx, method, s.base+path, reader)
	if err != nil {
		return err
	}
	r.SetBasicAuth("opencode", s.password)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(r)
	if err != nil {
		return fmt.Errorf("opencode: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var reason struct {
			Message string `json:"message"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&reason)
		return &httpError{Method: method, Path: path, Status: resp.StatusCode, Message: reason.Message}
	}
	if out != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(out); err != nil {
			return fmt.Errorf("opencode: decode %s: %w", path, err)
		}
	}
	return nil
}

func (f *Factory) Models(ctx context.Context, agent domain.AgentKind) ([]app.ModelInfo, error) {
	return f.ModelsInFolder(ctx, agent, "")
}
func (f *Factory) ModelsInFolder(ctx context.Context, _ domain.AgentKind, cwd string) ([]app.ModelInfo, error) {
	s, err := f.ensure(ctx)
	if err != nil {
		return nil, err
	}
	return s.models(ctx, cwd)
}
func (s *server) models(ctx context.Context, cwd string) ([]app.ModelInfo, error) {
	var list envelope[[]modelInfo]
	if err := s.call(ctx, http.MethodGet, located("/api/model", cwd), nil, &list); err != nil {
		return nil, err
	}
	def, err := s.defaultModel(ctx, cwd)
	if err != nil {
		return nil, err
	}
	out := []app.ModelInfo{}
	for _, m := range list.Data {
		if !m.Enabled {
			continue
		}
		variants := make([]string, 0, len(m.Variants))
		for _, v := range m.Variants {
			variants = append(variants, v.ID)
		}
		image := slices.Contains(m.Capabilities.Input, "image")
		out = append(out, app.ModelInfo{ID: m.ProviderID + "/" + m.ID, Name: m.Name, Provider: m.ProviderID, Efforts: variants, Default: def != nil && *def == modelRef{ID: m.ID, ProviderID: m.ProviderID}, Images: &image})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// defaultModel is the model a session uses unless one is selected, or nil.
func (s *server) defaultModel(ctx context.Context, cwd string) (*modelRef, error) {
	var def envelope[*modelInfo]
	if err := s.call(ctx, http.MethodGet, located("/api/model/default", cwd), nil, &def); err != nil {
		return nil, err
	}
	if def.Data == nil {
		return nil, nil
	}
	return &modelRef{ID: def.Data.ID, ProviderID: def.Data.ProviderID}, nil
}
func (f *Factory) Commands(ctx context.Context, _ domain.AgentKind, cwd string) ([]app.Command, error) {
	s, err := f.ensure(ctx)
	if err != nil {
		return nil, err
	}
	return s.commands(ctx, cwd)
}
func (s *server) commands(ctx context.Context, cwd string) ([]app.Command, error) {
	var list envelope[[]app.Command]
	if err := s.call(ctx, http.MethodGet, located("/api/command", cwd), nil, &list); err != nil {
		return nil, err
	}
	for i := range list.Data {
		list.Data[i].Insert = "/" + list.Data[i].Name
	}
	return list.Data, nil
}

// Account reports the providers that have enabled models; credentials and
// custom endpoints stay in OpenCode's own configuration.
func (f *Factory) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	s, err := f.ensure(ctx)
	if err != nil {
		return app.AccountInfo{}, err
	}
	var list envelope[[]modelInfo]
	if err = s.call(ctx, http.MethodGet, "/api/model", nil, &list); err != nil {
		return app.AccountInfo{}, err
	}
	providers := []string{}
	for _, m := range list.Data {
		if m.Enabled && !slices.Contains(providers, m.ProviderID) {
			providers = append(providers, m.ProviderID)
		}
	}
	sort.Strings(providers)
	return app.AccountInfo{Agent: agent, AuthMode: "config", LoggedIn: len(providers) > 0, Providers: providers}, nil
}
func (*Factory) StartLogin(context.Context, domain.AgentKind) (app.LoginChallenge, error) {
	return app.LoginChallenge{}, app.ErrAccountsUnsupported
}

var _ app.RuntimeFactory = (*Factory)(nil)
var _ app.ModelCatalog = (*Factory)(nil)
var _ app.FolderModelCatalog = (*Factory)(nil)
var _ app.CommandCatalog = (*Factory)(nil)
var _ app.AccountManager = (*Factory)(nil)

type httpError struct {
	Method, Path, Message string
	Status                int
}

func (e *httpError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("opencode: %s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Message)
	}
	return fmt.Sprintf("opencode: %s %s: HTTP %d", e.Method, e.Path, e.Status)
}
