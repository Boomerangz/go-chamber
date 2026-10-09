package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeOAuth accepts the bearer "linked" and serves its own endpoints.
type fakeOAuth struct{ served []string }

func (f *fakeOAuth) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.served = append(f.served, r.Method+" "+r.URL.Path)
	w.WriteHeader(http.StatusTeapot)
}
func (f *fakeOAuth) Public(path string) bool {
	return strings.HasPrefix(path, "/.well-known/oauth-") || path == "/oauth/token" || path == "/oauth/register"
}
func (f *fakeOAuth) Valid(r *http.Request) bool {
	return r.Header.Get("Authorization") == "Bearer linked" && r.URL.Path == "/api/mcp"
}
func (f *fakeOAuth) Challenge(*http.Request) string {
	return `Bearer resource_metadata="https://x/.well-known/oauth-protected-resource/api/mcp"`
}

func newOAuthServer() (http.Handler, *fakeOAuth) {
	o := &fakeOAuth{}
	mcp := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	return NewServer(Config{Token: testToken, MCP: mcp, OAuth: o}), o
}

func TestOAuthTokenOpensOnlyTheMCPEndpoint(t *testing.T) {
	srv, _ := newOAuthServer()
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer linked")
	// ChatGPT's servers may say where they come from; a bearer is no cookie
	// a page could ride on.
	req.Header.Set("Origin", "https://chatgpt.com")
	if rec := do(srv, req); rec.Code != http.StatusAccepted {
		t.Fatalf("mcp with an OAuth token = %d %s", rec.Code, rec.Body)
	}
	req = httptest.NewRequest("GET", "/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer linked")
	if rec := do(srv, req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("sessions with an OAuth token = %d", rec.Code)
	}
}

func TestMCPWithoutATokenPointsAtTheOAuthMetadata(t *testing.T) {
	srv, _ := newOAuthServer()
	rec := do(srv, httptest.NewRequest("POST", "/api/mcp", nil))
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Header().Get("WWW-Authenticate"), "oauth-protected-resource") {
		t.Fatalf("code %d, challenge %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
}

func TestOAuthEndpointsClientsUseNeedNoLogin(t *testing.T) {
	srv, o := newOAuthServer()
	for _, r := range []*http.Request{
		httptest.NewRequest("GET", "/.well-known/oauth-protected-resource/api/mcp", nil),
		httptest.NewRequest("GET", "/.well-known/oauth-authorization-server", nil),
		withOrigin(httptest.NewRequest("POST", "/oauth/token", nil), "https://chatgpt.com"),
		httptest.NewRequest("POST", "/oauth/register", nil),
	} {
		if rec := do(srv, r); rec.Code != http.StatusTeapot {
			t.Fatalf("%s %s = %d", r.Method, r.URL.Path, rec.Code)
		}
	}
	if len(o.served) != 4 {
		t.Fatalf("served = %v", o.served)
	}
}

func withOrigin(r *http.Request, origin string) *http.Request {
	r.Header.Set("Origin", origin)
	return r
}

func TestConsentPageIsTheOwnersOnly(t *testing.T) {
	srv, o := newOAuthServer()
	rec := do(srv, httptest.NewRequest("GET", "/oauth/authorize?client_id=x&state=y", nil))
	if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `value="/oauth/authorize?client_id=x&amp;state=y"`) {
		t.Fatalf("anonymous consent = %d %s", rec.Code, rec.Body)
	}
	// A page elsewhere cannot submit the owner's approval.
	post := httptest.NewRequest("POST", "/oauth/authorize", nil)
	post.AddCookie(&http.Cookie{Name: CookieName, Value: testToken})
	if rec := do(srv, withOrigin(post, "https://evil.example")); rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin approval = %d", rec.Code)
	}
	get := httptest.NewRequest("GET", "/oauth/authorize?client_id=x", nil)
	get.AddCookie(&http.Cookie{Name: CookieName, Value: testToken})
	if rec := do(srv, get); rec.Code != http.StatusTeapot || len(o.served) != 1 {
		t.Fatalf("owner consent = %d, served %v", rec.Code, o.served)
	}
}

// A link from another site (ChatGPT sending the owner to consent) carries no
// Strict cookie; the page looks again from here, where it does.
func TestPageOpenedFromAnotherSiteLooksAgainFromHere(t *testing.T) {
	srv, _ := newOAuthServer()
	req := httptest.NewRequest("GET", "/oauth/authorize?client_id=x&state=y", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := do(srv, req)
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, `http-equiv="refresh"`) || !strings.Contains(body, "/oauth/authorize?client_id=x&amp;state=y") || strings.Contains(body, `name="token"`) {
		t.Fatalf("cross-site open = %d %s", rec.Code, body)
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if rec := do(srv, req); rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `name="token"`) {
		t.Fatalf("second look without a cookie = %d", rec.Code)
	}
}
