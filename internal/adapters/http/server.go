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
	s.archiveRoutes()
	s.fileRoutes()
	return &auth{token: []byte(cfg.Token), next: s.mux}
}

type auth struct {
	token []byte
	next  http.Handler
}

func (a *auth) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if q := r.URL.Query(); q.Has("token") {
		a.login(w, r, q.Get("token"))
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
	if !a.valid(token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	setTokenCookie(w, r, token)
	q := r.URL.Query()
	q.Del("token")
	target := r.URL.Path
	if enc := q.Encode(); enc != "" {
		target += "?" + enc
	}
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
<style>
:root{color-scheme:light dark;font:15px/1.4 system-ui,sans-serif}
body{display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
form{display:grid;gap:10px;width:min(360px,100%)}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #8886}
button{cursor:pointer}
.err{color:#d33;margin:0}
</style></head><body>
<form method="post" action="/login">
<h1>go-chamber</h1>
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="{{.Next}}">
{{if .Failed}}<p class="err" role="alert">Wrong token</p>{{end}}
<button type="submit">Sign in</button>
<p><small>The token is printed at startup and stored in the data folder.</small></p>
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
