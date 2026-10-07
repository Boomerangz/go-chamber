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
	var info sessionInfo
	path, method := "/session", http.MethodPost
	if req.NativeID != "" {
		path += "/" + url.PathEscape(req.NativeID)
		method = http.MethodGet
		if req.Fork {
			path += "/fork"
			method = http.MethodPost
		}
	}
	if err = s.call(ctx, method, path, req.Cwd, nil, &info); err != nil {
		return nil, err
	}
	if info.ID == "" {
		return nil, errors.New("opencode: empty native session id")
	}
	cwd := info.Directory
	if cwd == "" {
		cwd = req.Cwd
	}
	var history []transcript
	if err := s.call(ctx, http.MethodGet, "/session/"+url.PathEscape(info.ID)+"/message", cwd, nil, &history); err != nil {
		return nil, err
	}
	// Attach cannot wait for a consumer that starts only after Start returns.
	// Reserve room for the complete initial replay plus live events.
	capacity := 4096 + 2*len(history)
	for _, msg := range history {
		capacity += 3 * len(msg.Parts)
	}
	rt := &Runtime{server: s, native: info.ID, cwd: cwd, events: make(chan domain.Event, capacity), done: make(chan struct{}), mapper: newMapper(req.SessionID, req.Passive || req.Fork), model: req.Model, variant: req.Effort}
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

func (s *server) call(ctx context.Context, method, path, cwd string, body, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(b))
	}
	address := s.base + path
	if cwd != "" {
		address += "?" + url.Values{"directory": {cwd}}.Encode()
	}
	r, err := http.NewRequestWithContext(ctx, method, address, reader)
	if err != nil {
		return err
	}
	r.SetBasicAuth("opencode", s.password)
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	client := s.client
	if strings.HasSuffix(path, "/command") {
		copy := *client
		copy.Timeout = 0
		client = &copy
	}
	resp, err := client.Do(r)
	if err != nil {
		return fmt.Errorf("opencode: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &httpError{Method: method, Path: path, Status: resp.StatusCode}
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
	var err error
	var ps providers
	if err = s.call(ctx, http.MethodGet, "/provider", cwd, nil, &ps); err != nil {
		return nil, err
	}
	var config struct {
		Model string `json:"model"`
	}
	if err = s.call(ctx, http.MethodGet, "/config", cwd, nil, &config); err != nil {
		return nil, err
	}
	out := []app.ModelInfo{}
	for _, p := range ps.All {
		if !slices.Contains(ps.Connected, p.ID) {
			continue
		}
		for id, m := range p.Models {
			variants := make([]string, 0, len(m.Variants))
			for v := range m.Variants {
				variants = append(variants, v)
			}
			sort.Strings(variants)
			image := m.Capabilities.Input.Image
			out = append(out, app.ModelInfo{ID: p.ID + "/" + id, Name: m.Name, Provider: p.Name, Efforts: variants, Default: config.Model == p.ID+"/"+id, Images: &image})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}
func (f *Factory) Commands(ctx context.Context, _ domain.AgentKind, cwd string) ([]app.Command, error) {
	s, err := f.ensure(ctx)
	if err != nil {
		return nil, err
	}
	var out []app.Command
	if err = s.call(ctx, http.MethodGet, "/command", cwd, nil, &out); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Insert = "/" + out[i].Name
	}
	return out, nil
}
func (f *Factory) Account(ctx context.Context, agent domain.AgentKind) (app.AccountInfo, error) {
	s, err := f.ensure(ctx)
	if err != nil {
		return app.AccountInfo{}, err
	}
	var ps providers
	if err = s.call(ctx, http.MethodGet, "/provider", "", nil, &ps); err != nil {
		return app.AccountInfo{}, err
	}
	return app.AccountInfo{Agent: agent, AuthMode: "config", LoggedIn: len(ps.Connected) > 0, Providers: ps.Connected}, nil
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
	Method, Path string
	Status       int
}

func (e *httpError) Error() string {
	return fmt.Sprintf("opencode: %s %s: HTTP %d", e.Method, e.Path, e.Status)
}
