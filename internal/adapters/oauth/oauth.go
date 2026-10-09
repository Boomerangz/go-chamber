// Package oauth is a single-owner OAuth 2.1 authorization server for the MCP
// endpoint, so that clients which only speak OAuth (ChatGPT) can link to
// go-chamber. The owner approves each link on a consent page behind the
// usual login; the tokens it issues open /api/mcp and nothing else.
package oauth

import (
	"cmp"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
)

const (
	// MCPPath is the protected resource.
	MCPPath    = "/api/mcp"
	codeTTL    = time.Minute
	accessTTL  = time.Hour
	refreshTTL = 90 * 24 * time.Hour
	scope      = "mcp"
)

// allowedRedirect limits who can be linked at all to ChatGPT's own OAuth
// callbacks, matched exactly, so a crafted consent link cannot hand a code
// to any other page.
// ponytail: ChatGPT only; widen the list when another OAuth-only client
// needs to link.
func allowedRedirect(uri string) bool {
	path, ok := chatgptPath(uri)
	if !ok {
		return false
	}
	if path == "/connector_platform_oauth_redirect" {
		return true
	}
	id, ok := strings.CutPrefix(path, "/connector/oauth/")
	return ok && callbackID(id)
}

// clientDocument reports whether id is the URL of ChatGPT's client metadata
// document.
func clientDocument(id string) bool {
	path, ok := chatgptPath(id)
	if !ok {
		return false
	}
	if path == "/oauth/client.json" {
		return true
	}
	middle, ok := strings.CutPrefix(path, "/oauth/")
	middle, ok2 := strings.CutSuffix(middle, "/client.json")
	return ok && ok2 && callbackID(middle)
}

// chatgptPath is the path of a plain https://chatgpt.com URL: no user,
// query, fragment or escapes to hide anything in.
func chatgptPath(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "chatgpt.com" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" || strings.Contains(raw, "#") {
		return "", false
	}
	return u.Path, true
}

func callbackID(s string) bool {
	return s != "" && strings.Trim(s, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") == ""
}

// Tokens keeps the issued tokens across restarts.
type Tokens interface {
	PutToken(ctx context.Context, key string, g app.OAuthGrant) error
	Token(ctx context.Context, key string) (app.OAuthGrant, bool, error)
	TakeToken(ctx context.Context, key string) (app.OAuthGrant, bool, error)
	DeleteTokensExpiredBy(ctx context.Context, t time.Time) error
}

type Config struct {
	// Tokens keeps access and refresh tokens; required.
	Tokens Tokens
	// Base is the public origin (https://host); empty follows the request.
	Base string
	// HTTP fetches client metadata documents; http.DefaultClient when nil.
	HTTP *http.Client
	Now  func() time.Time
}

// Server serves the OAuth endpoints and checks the tokens it issued.
type Server struct {
	cfg   Config
	mux   *http.ServeMux
	fetch *http.Client

	mu sync.Mutex
	// clients are registered ones; registration is open to anyone, so they
	// are not written down: a restart only asks a half-done link again.
	clients map[string]client
	codes   map[string]grant
}

// grant is what a code or token stands for.
type grant struct {
	Client    string    `json:"client"`
	Redirect  string    `json:"redirect,omitempty"`
	Challenge string    `json:"-"`
	Resource  string    `json:"resource"`
	Expires   time.Time `json:"expires"`
}

type client struct {
	Name         string    `json:"name,omitempty"`
	RedirectURIs []string  `json:"redirect_uris"`
	Created      time.Time `json:"created"`
}

// Registration is open to anyone, so it is bounded: the oldest client gives
// way (tokens already issued to it keep working), and a client is small.
const (
	maxClients   = 50
	maxName      = 200
	maxRedirects = 5
)

func New(cfg Config) *Server {
	if cfg.HTTP == nil {
		cfg.HTTP = http.DefaultClient
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	// A client document is fetched from chatgpt.com and nowhere it points.
	fetch := *cfg.HTTP
	fetch.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if fetch.Timeout == 0 {
		fetch.Timeout = 5 * time.Second
	}
	s := &Server{cfg: cfg, mux: http.NewServeMux(), fetch: &fetch, clients: map[string]client{}, codes: map[string]grant{}}
	s.mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.resourceMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-protected-resource"+MCPPath, s.resourceMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.serverMetadata)
	s.mux.HandleFunc("POST /oauth/register", s.register)
	s.mux.HandleFunc("GET /oauth/authorize", s.consent)
	s.mux.HandleFunc("POST /oauth/authorize", s.decide)
	s.mux.HandleFunc("POST /oauth/token", s.token)
	return s
}

// ServeHTTP serves the metadata and /oauth/ endpoints. /oauth/authorize
// must only be reached by the logged-in owner.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// Public reports whether path is an endpoint clients reach without the
// owner's login.
func (s *Server) Public(path string) bool {
	return strings.HasPrefix(path, "/.well-known/") || path == "/oauth/register" || path == "/oauth/token"
}

// Valid reports whether the request carries a live token issued for the
// resource it asks for.
func (s *Server) Valid(r *http.Request) bool {
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || raw == "" {
		return false
	}
	g, ok, err := s.cfg.Tokens.Token(r.Context(), accessKey+hash(raw))
	return err == nil && ok && s.cfg.Now().Before(g.Expires) && g.Resource == s.base(r)+r.URL.Path
}

// Challenge is the WWW-Authenticate value that sends a client to the
// metadata.
func (s *Server) Challenge(r *http.Request) string {
	c := fmt.Sprintf(`resource_metadata="%s/.well-known/oauth-protected-resource%s", scope="%s"`, s.base(r), MCPPath, scope)
	if r.Header.Get("Authorization") != "" {
		c += `, error="invalid_token", error_description="the token is unknown, expired or for another resource"`
	}
	return c
}

func (s *Server) base(r *http.Request) string {
	if s.cfg.Base != "" {
		return strings.TrimSuffix(s.cfg.Base, "/")
	}
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		proto = "http"
		if r.TLS != nil {
			proto = "https"
		}
	}
	return proto + "://" + cmp.Or(r.Header.Get("X-Forwarded-Host"), r.Host)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func oauthError(w http.ResponseWriter, code int, kind, description string) {
	writeJSON(w, code, map[string]string{"error": kind, "error_description": description})
}

func (s *Server) resourceMetadata(w http.ResponseWriter, r *http.Request) {
	b := s.base(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 b + MCPPath,
		"authorization_servers":    []string{b},
		"scopes_supported":         []string{scope},
		"bearer_methods_supported": []string{"header"},
	})
}

func (s *Server) serverMetadata(w http.ResponseWriter, r *http.Request) {
	b := s.base(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         b,
		"authorization_endpoint":                         b + "/oauth/authorize",
		"token_endpoint":                                 b + "/oauth/token",
		"registration_endpoint":                          b + "/oauth/register",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"client_id_metadata_document_supported":          true,
		"authorization_response_iss_parameter_supported": true,
		"scopes_supported":                               []string{scope},
	})
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name         string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "not JSON")
		return
	}
	if len(req.RedirectURIs) == 0 || len(req.RedirectURIs) > maxRedirects || slices.ContainsFunc(req.RedirectURIs, func(u string) bool { return !allowedRedirect(u) }) {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "only ChatGPT may link to this server")
		return
	}
	if len(req.Name) > maxName {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "client_name is too long")
		return
	}
	if req.AuthMethod != "" && req.AuthMethod != "none" {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "only public clients (none) are supported")
		return
	}
	id := random()
	s.mu.Lock()
	for len(s.clients) >= maxClients {
		oldest := ""
		for k, c := range s.clients {
			if oldest == "" || c.Created.Before(s.clients[oldest].Created) {
				oldest = k
			}
		}
		delete(s.clients, oldest)
	}
	s.clients[id] = client{Name: req.Name, RedirectURIs: req.RedirectURIs, Created: s.cfg.Now()}
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id": id, "client_name": req.Name, "redirect_uris": req.RedirectURIs,
		"token_endpoint_auth_method": "none", "client_id_issued_at": s.cfg.Now().Unix(),
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
	})
}

// lookup finds a client: a registered one, or one whose id is the URL of
// its metadata document.
func (s *Server) lookup(ctx context.Context, id string) (client, error) {
	s.mu.Lock()
	c, ok := s.clients[id]
	s.mu.Unlock()
	if ok {
		return c, nil
	}
	if !clientDocument(id) {
		return client{}, errors.New("unknown client")
	}
	// What chatgpt.com answered stays here: the page says only that it failed.
	unavailable := errors.New("the client's metadata document is unavailable")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, id, nil)
	if err != nil {
		return client{}, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.fetch.Do(req)
	if err != nil {
		return client{}, unavailable
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return client{}, unavailable
	}
	var doc struct {
		ID           string   `json:"client_id"`
		Name         string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&doc); err != nil {
		return client{}, unavailable
	}
	if doc.ID != id {
		return client{}, errors.New("client metadata names another client")
	}
	return client{Name: doc.Name, RedirectURIs: doc.RedirectURIs}, nil
}

// request is an authorization request as the consent page carries it.
type request struct {
	Client, ClientName, Redirect, Challenge, State, Resource string
}

// parse checks an authorization request. A request whose client or
// redirect cannot be trusted is refused on the page (redirect false);
// other faults go back to the client.
func (s *Server) parse(r *http.Request, v url.Values) (req request, redirect bool, err error) {
	req = request{Client: v.Get("client_id"), Redirect: v.Get("redirect_uri"), Challenge: v.Get("code_challenge"), State: v.Get("state"), Resource: v.Get("resource")}
	c, err := s.lookup(r.Context(), req.Client)
	if err != nil {
		return req, false, err
	}
	if !allowedRedirect(req.Redirect) || !slices.Contains(c.RedirectURIs, req.Redirect) {
		return req, false, errors.New("redirect_uri is not one the client registered")
	}
	req.ClientName = cmp.Or(c.Name, req.Client)
	switch {
	case v.Get("response_type") != "code":
		return req, true, errors.New("unsupported_response_type")
	case len(req.Challenge) != 43 || v.Get("code_challenge_method") != "S256":
		return req, true, errors.New("invalid_request")
	case req.Resource != "" && req.Resource != s.base(r)+MCPPath:
		return req, true, errors.New("invalid_target")
	}
	req.Resource = s.base(r) + MCPPath
	return req, true, nil
}

// back sends the browser to the client with params, iss and state.
func (s *Server) back(w http.ResponseWriter, r *http.Request, req request, params url.Values) {
	params.Set("iss", s.base(r))
	if req.State != "" {
		params.Set("state", req.State)
	}
	to, _ := url.Parse(req.Redirect)
	q := to.Query()
	for k, v := range params {
		q[k] = v
	}
	to.RawQuery = q.Encode()
	http.Redirect(w, r, to.String(), http.StatusFound)
}

func (s *Server) consent(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	req, redirect, err := s.parse(r, q)
	if err != nil {
		if redirect {
			s.back(w, r, req, url.Values{"error": {err.Error()}})
			return
		}
		http.Error(w, "authorization refused: "+err.Error(), http.StatusBadRequest)
		return
	}
	host := req.Redirect
	if u, err := url.Parse(req.Redirect); err == nil {
		host = u.Host
	}
	fields := []struct{ Name, Value string }{}
	for _, k := range []string{"response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"} {
		if q.Has(k) {
			fields = append(fields, struct{ Name, Value string }{k, q.Get(k)})
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// The page grants access: nobody may frame it to steal a click.
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	_ = consentTemplate.Execute(w, struct {
		Client, Host string
		Fields       []struct{ Name, Value string }
	}{req.ClientName, host, fields})
}

func (s *Server) decide(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	req, redirect, err := s.parse(r, r.PostForm)
	if err != nil {
		if redirect {
			s.back(w, r, req, url.Values{"error": {err.Error()}})
			return
		}
		http.Error(w, "authorization refused: "+err.Error(), http.StatusBadRequest)
		return
	}
	if r.PostForm.Get("decision") != "allow" {
		s.back(w, r, req, url.Values{"error": {"access_denied"}})
		return
	}
	code := random()
	s.mu.Lock()
	s.codes[hash(code)] = grant{Client: req.Client, Redirect: req.Redirect, Challenge: req.Challenge, Resource: req.Resource, Expires: s.cfg.Now().Add(codeTTL)}
	s.mu.Unlock()
	s.back(w, r, req, url.Values{"code": {code}})
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", "bad form")
		return
	}
	f := r.PostForm
	switch f.Get("grant_type") {
	case "authorization_code":
		s.mu.Lock()
		key := hash(f.Get("code"))
		g, ok := s.codes[key]
		// Spent on the first try, right or wrong: a stolen code gets one.
		delete(s.codes, key)
		s.mu.Unlock()
		switch {
		case !ok || !s.cfg.Now().Before(g.Expires):
			oauthError(w, http.StatusBadRequest, "invalid_grant", "unknown or expired code")
		case g.Client != f.Get("client_id") || f.Get("redirect_uri") != "" && g.Redirect != f.Get("redirect_uri"):
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the code was issued to another client")
		case !verifies(f.Get("code_verifier"), g.Challenge):
			oauthError(w, http.StatusBadRequest, "invalid_grant", "code_verifier does not match")
		case f.Get("resource") != "" && f.Get("resource") != g.Resource:
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the code was issued for another resource")
		default:
			s.issue(w, r, app.OAuthGrant{Client: g.Client, Resource: g.Resource}, "")
		}
	case "refresh_token":
		key := refreshKey + hash(f.Get("refresh_token"))
		g, ok, err := s.cfg.Tokens.Token(r.Context(), key)
		switch {
		case err != nil:
			oauthError(w, http.StatusInternalServerError, "server_error", "could not read the token")
		case !ok || !s.cfg.Now().Before(g.Expires):
			oauthError(w, http.StatusBadRequest, "invalid_grant", "unknown or expired refresh token")
		case g.Client != f.Get("client_id"):
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the token was issued to another client")
		case f.Get("resource") != "" && f.Get("resource") != g.Resource:
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the token was issued for another resource")
		default:
			s.issue(w, r, g, key)
		}
	default:
		oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "authorization_code or refresh_token")
	}
}

// Tokens are kept under these prefixes and their hash, so neither kind
// passes for the other.
const (
	accessKey  = "access:"
	refreshKey = "refresh:"
)

// issue hands out a fresh access token and a rotated refresh token. The
// refresh token being spent, when set, goes only once the new ones are
// kept, so a failed save does not cost the client its link; if it was
// spent meanwhile, the new ones go too.
func (s *Server) issue(w http.ResponseWriter, r *http.Request, g app.OAuthGrant, spent string) {
	ctx := context.WithoutCancel(r.Context())
	access, refresh := random(), random()
	now := s.cfg.Now()
	_ = s.cfg.Tokens.DeleteTokensExpiredBy(ctx, now)
	newRefresh, newAccess := refreshKey+hash(refresh), accessKey+hash(access)
	drop := func() {
		_, _, _ = s.cfg.Tokens.TakeToken(ctx, newRefresh)
		_, _, _ = s.cfg.Tokens.TakeToken(ctx, newAccess)
	}
	err := s.cfg.Tokens.PutToken(ctx, newRefresh, app.OAuthGrant{Client: g.Client, Resource: g.Resource, Expires: now.Add(refreshTTL)})
	if err == nil {
		err = s.cfg.Tokens.PutToken(ctx, newAccess, app.OAuthGrant{Client: g.Client, Resource: g.Resource, Expires: now.Add(accessTTL)})
	}
	if err != nil {
		drop()
		oauthError(w, http.StatusInternalServerError, "server_error", "could not keep the token")
		return
	}
	if spent != "" {
		if _, ok, err := s.cfg.Tokens.TakeToken(ctx, spent); err != nil || !ok {
			drop()
			oauthError(w, http.StatusBadRequest, "invalid_grant", "unknown or expired refresh token")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": access, "token_type": "Bearer", "expires_in": int(accessTTL.Seconds()),
		"refresh_token": refresh, "scope": scope,
	})
}

func verifies(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	got := base64.RawURLEncoding.EncodeToString(sum[:])
	return subtle.ConstantTimeCompare([]byte(got), []byte(challenge)) == 1
}

func random() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

var consentTemplate = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>go-chamber · link {{.Client}}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:light;--paper:#f3f3f1;--ink:#16171a;--ink-2:#45474d;--rule-strong:#8c8c86;--act:#2433d6;--act-ink:#fff;--act-ring:rgba(36,51,214,.55);
font:14px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#0f1012;--ink:#e4e2dc;--ink-2:#b3b1ab;--rule-strong:#5e6066;--act:#8c98ff;--act-ink:#0f1012;--act-ring:rgba(140,152,255,.6)}}
*{box-sizing:border-box}
body{display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:var(--paper);color:var(--ink)}
form{display:grid;gap:8px;width:min(400px,100%)}
h1{margin:0 0 8px;font:400 15px 'PT Mono',ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:.02em}
p{margin:0 0 8px;color:var(--ink-2)}
b{color:var(--ink)}
.row{display:flex;gap:8px;margin-top:8px}
button{flex:1;font:13px 'PT Mono',ui-monospace,'SF Mono',Menlo,monospace;height:36px;border-radius:2px;cursor:pointer;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink)}
button.primary{border-color:var(--act);background:var(--act);color:var(--act-ink)}
button:focus-visible{outline:2px solid var(--act-ring);outline-offset:2px}
</style></head><body>
<form method="post" action="/oauth/authorize">
<h1>go-chamber</h1>
<p><b>{{.Client}}</b> (returns to <b>{{.Host}}</b>) asks to drive your agent sessions over MCP: start them, send messages, read transcripts and diffs.</p>
<p>It cannot grant agents' permission requests unless go-chamber runs with -mcp-allow-approvals.</p>
{{range .Fields}}<input type="hidden" name="{{.Name}}" value="{{.Value}}">
{{end}}<div class="row">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow" class="primary">Allow</button>
</div>
</form></body></html>`))
