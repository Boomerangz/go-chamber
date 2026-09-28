// Package httpapi is the HTTP adapter: REST/WS API and the embedded web UI.
package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/igorzygin/go-chamber/internal/adapters/hub"
)

// CookieName holds the access token after a ?token= login.
const CookieName = "gc_token"

type Config struct {
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
}

type server struct {
	cfg Config
	mux *http.ServeMux
}

func NewServer(cfg Config) http.Handler {
	if cfg.Token == "" {
		panic("httpapi: empty token")
	}
	s := &server{cfg: cfg, mux: http.NewServeMux()}
	s.routes()
	s.completeRoutes()
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
	if !a.authorized(r) {
		http.Error(w, "unauthorized: open the URL with ?token= printed at startup", http.StatusUnauthorized)
		return
	}
	if !safeMethod(r.Method) && !sameOrigin(r) {
		http.Error(w, "forbidden: cross-origin request", http.StatusForbidden)
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
	http.SetCookie(w, &http.Cookie{
		Name: CookieName, Value: token, Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	})
	q := r.URL.Query()
	q.Del("token")
	target := r.URL.Path
	if enc := q.Encode(); enc != "" {
		target += "?" + enc
	}
	http.Redirect(w, r, target, http.StatusFound)
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
