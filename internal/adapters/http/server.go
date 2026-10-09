// Package httpapi is the HTTP adapter: REST/WS API and the embedded web UI.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
)

// CookieName holds the access token after a ?token= login.
const CookieName = "gc_token"

type Config struct {
	// Lifecycle closes direct peer connections when the application shuts down.
	Lifecycle  context.Context
	ICEServers []ICEServer
	// Token is the single-user access token; required.
	Token string
	// Static is the built web UI (index.html at the root).
	Static fs.FS
	// Sessions serves the session REST API when non-nil.
	Sessions Sessions
	// Events is the live event hub for WebSocket and replay when non-nil.
	Events *hub.Hub
	// Terminals serves shells over REST and a binary WebSocket when non-nil.
	Terminals Terminals
	// Folders lists server directories for the folder picker when non-nil.
	Folders Folders
	// Search finds sessions by message text when non-nil.
	Search MessageSearch
	// Complete suggests files and commands for the composer when non-nil.
	Complete Completer
	// ImagesDir stores images attached to messages when non-empty.
	ImagesDir string
	// Worktrees creates worktree sessions and serves the diff panel when non-nil.
	Worktrees Worktrees
	// History lists and imports sessions recorded outside go-chamber when non-nil.
	History HistoryService
	// Push registers browsers for notifications when non-nil.
	Push PushSubscriptions
	// Files serves files agents mention inside their session folder when non-nil.
	Files SessionFiles
	// Presence learns where the owner is from the event socket when non-nil.
	Presence PresenceTracker
	// MCP serves the MCP endpoint at /api/mcp when non-nil.
	MCP http.Handler
	// OAuth lets clients that only speak OAuth reach MCP when non-nil.
	OAuth OAuth
}

// OAuth is an authorization server whose tokens open the MCP endpoint only.
type OAuth interface {
	// ServeHTTP serves /.well-known/oauth-* and /oauth/*.
	http.Handler
	// Public reports whether clients reach path without the owner's login.
	Public(path string) bool
	// Valid reports whether r carries a live token for what it asks.
	Valid(r *http.Request) bool
	// Challenge is the WWW-Authenticate value pointing at the metadata.
	Challenge(r *http.Request) string
}

type server struct {
	cfg      Config
	mux      *http.ServeMux
	started  time.Time
	rtcSlots chan struct{}
}

func NewServer(cfg Config) http.Handler {
	if cfg.Token == "" {
		panic("httpapi: empty token")
	}
	s := &server{cfg: cfg, mux: http.NewServeMux(), started: time.Now(), rtcSlots: make(chan struct{}, 64)}
	s.routes()
	s.diagnosticsRoutes()
	s.rtcRoutes()
	s.completeRoutes()
	s.imageRoutes()
	s.worktreeRoutes()
	s.historyRoutes()
	s.pushRoutes()
	s.renameRoutes()
	s.seenRoutes()
	s.archiveRoutes()
	s.fileRoutes()
	if cfg.MCP != nil {
		s.mux.Handle("/api/mcp", cfg.MCP)
	}
	if cfg.OAuth != nil {
		s.mux.Handle("/.well-known/", cfg.OAuth)
		s.mux.Handle("/oauth/", cfg.OAuth)
	}
	return &auth{token: []byte(cfg.Token), next: s.mux, oauth: cfg.OAuth}
}

type auth struct {
	token []byte
	next  http.Handler
	oauth OAuth
}

func (a *auth) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if q := r.URL.Query(); q.Has("token") {
		a.login(w, r, q.Get("token"))
		return
	}
	// OAuth clients are servers: they log in with codes and bearers, which a
	// page elsewhere cannot ride on as it would on the cookie.
	if a.oauth != nil && a.oauth.Public(r.URL.Path) {
		a.next.ServeHTTP(w, r)
		return
	}
	if a.oauth != nil && r.URL.Path == "/api/mcp" && !a.authorized(r) {
		if !a.oauth.Valid(r) {
			w.Header().Set("WWW-Authenticate", a.oauth.Challenge(r))
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		a.next.ServeHTTP(w, r)
		return
	}
	if !safeMethod(r.Method) && !sameOrigin(r) {
		http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/login" {
		a.loginForm(w, r)
		return
	}
	if safeMethod(r.Method) && publicFiles[r.URL.Path] {
		if r.URL.Path == "/sw.js" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		a.next.ServeHTTP(w, r)
		return
	}
	if !a.authorized(r) {
		if strings.HasPrefix(r.URL.Path, "/api/") || !safeMethod(r.Method) {
			http.Error(w, "unauthorized: open the URL with ?token= printed at startup", http.StatusUnauthorized)
			return
		}
		loginPage(w, localPath(r.URL.RequestURI()), false)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/logout" {
		http.SetCookie(w, &http.Cookie{Name: CookieName, Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	a.next.ServeHTTP(w, r)
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// sameOrigin rejects requests a browser sends on behalf of another origin.
// SameSite cookies don't cover this: every port on localhost is the same
// site, so a page on another local port would otherwise act as the user.
// Clients without Origin/Sec-Fetch-Site headers (curl) are not browsers.
// X-Forwarded-Host is trusted because a cross-origin page can't set it
// without a CORS preflight, which this server never grants.
func sameOrigin(r *http.Request) bool {
	if o := r.Header.Get("Origin"); o != "" {
		u, err := url.Parse(o)
		if err != nil || u.Host == "" {
			return false
		}
		return u.Host == r.Host || u.Host == r.Header.Get("X-Forwarded-Host")
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-site", "cross-site":
		return false
	}
	return true
}

func (a *auth) login(w http.ResponseWriter, r *http.Request, token string) {
	q := r.URL.Query()
	q.Del("token")
	target := r.URL.Path
	if enc := q.Encode(); enc != "" {
		target += "?" + enc
	}
	if !a.valid(token) {
		if strings.HasPrefix(r.URL.Path, "/api/") || !safeMethod(r.Method) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// The same page as a wrong token typed into the form.
		loginPage(w, localPath(target), true)
		return
	}
	setTokenCookie(w, r, token)
	http.Redirect(w, r, localPath(target), http.StatusFound)
}

// loginForm handles the token typed into the login page.
func (a *auth) loginForm(w http.ResponseWriter, r *http.Request) {
	next := localPath(r.PostFormValue("next"))
	if !a.valid(r.PostFormValue("token")) {
		loginPage(w, next, true)
		return
	}
	setTokenCookie(w, r, r.PostFormValue("token"))
	http.Redirect(w, r, next, http.StatusSeeOther)
}

// cookieMaxAge keeps the login across browser restarts; the token itself
// never expires, so the cookie is only as long-lived as the device is trusted.
const cookieMaxAge = 365 * 24 * 3600

func setTokenCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/", MaxAge: cookieMaxAge,
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

// localPath keeps redirects on this server: anything but an absolute path
// (including //host and /\host, which browsers treat as other sites) becomes /.
func localPath(p string) string {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.HasPrefix(p, "/\\") {
		return "/"
	}
	return p
}

var loginTemplate = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>go-chamber · sign in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
/* the app's sheet, ink and faces (web/src/index.css), kept by hand: this
   page is served before the app's own stylesheet may be fetched */
:root{color-scheme:light;--paper:#f3f3f1;--ink:#16171a;--ink-2:#45474d;--ink-3:#66686e;--rule-strong:#8c8c86;--act:#2433d6;--act-ink:#ffffff;--act-ring:rgba(36,51,214,.55);--bad:#b3261e;
--font-ui:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,'Segoe UI',Roboto,sans-serif;--font-mono:'PT Mono',ui-monospace,'SF Mono',Menlo,monospace;
font:14px/1.5 var(--font-ui);-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#0f1012;--ink:#e4e2dc;--ink-2:#b3b1ab;--ink-3:#8d8f95;--rule-strong:#5e6066;--act:#8c98ff;--act-ink:#0f1012;--act-ring:rgba(140,152,255,.6);--bad:#f07a6a}}
*{box-sizing:border-box}
body{display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:var(--paper);color:var(--ink);caret-color:var(--act)}
form{display:grid;gap:8px;width:min(360px,100%)}
h1{margin:0 0 12px;font:400 15px var(--font-mono);letter-spacing:.02em}
label{font:11.5px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
input,button{font:inherit;height:36px;border-radius:2px}
input{padding:0 10px;border:1px solid var(--rule-strong);background:var(--paper);color:var(--ink)}
input:focus{outline:2px solid var(--act-ring);outline-offset:1px;border-color:var(--act)}
.primary{margin-top:4px;border:1px solid var(--act);background:var(--act);color:var(--act-ink);font-family:var(--font-mono);font-size:13px;cursor:pointer}
.primary:hover{border-color:var(--ink)}
.primary:focus-visible{outline:2px solid var(--act-ring);outline-offset:2px}
.err{margin:0;color:var(--bad);font-size:13px}
.note{margin:8px 0 0;color:var(--ink-2);font-size:13px}
</style></head><body>
<form method="post" action="/login">
<h1>go-chamber</h1>
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="{{.Next}}">
{{if .Failed}}<p class="err" role="alert">Wrong token</p>{{end}}
<button type="submit" class="primary">Sign in</button>
<p class="note">The token is printed at startup and stored in the data folder.</p>
</form></body></html>`))

func loginPage(w http.ResponseWriter, next string, failed bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusUnauthorized)
	_ = loginTemplate.Execute(w, struct {
		Next   string
		Failed bool
	}{next, failed})
}

func (a *auth) authorized(r *http.Request) bool {
	if c, err := r.Cookie(CookieName); err == nil && a.valid(c.Value) {
		return true
	}
	bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && a.valid(bearer)
}

func (a *auth) valid(token string) bool {
	return subtle.ConstantTimeCompare([]byte(token), a.token) == 1
}

// spaHandler serves files from static and falls back to index.html for
// client-side routes. Paths with an extension are assets and 404 when missing.
func spaHandler(static fs.FS) http.Handler {
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		if _, err := fs.Stat(static, name); errors.Is(err, fs.ErrNotExist) {
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
			http.ServeFileFS(w, r, static, "index.html")
			return
		}
		files.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
