package oauth_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/igorzygin/go-chamber/internal/adapters/oauth"
)

const (
	base     = "https://chamber.example.dev"
	resource = base + "/api/mcp"
	redirect = "https://chatgpt.com/connector_platform_oauth_redirect"
	cimdID   = "https://chatgpt.com/oauth/client.json"
	movedID  = "https://chatgpt.com/oauth/moved/client.json"
	verifier = "a-long-enough-code-verifier-0123456789-abcdefghijkl"
)

func challenge(v string) string {
	sum := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// documents serves client metadata documents in place of their hosts; a
// body starting with "->" redirects there.
type documents map[string]string

func (d documents) RoundTrip(r *http.Request) (*http.Response, error) {
	body, ok := d[r.URL.String()]
	code, header := http.StatusOK, http.Header{"Content-Type": {"application/json"}}
	switch {
	case !ok:
		code, body = http.StatusTeapot, "upstream-secret-status"
	case strings.HasPrefix(body, "->"):
		code = http.StatusFound
		header.Set("Location", strings.TrimPrefix(body, "->"))
	}
	return &http.Response{StatusCode: code, Status: fmt.Sprint(code, " ", body), Body: io.NopCloser(strings.NewReader(body)), Header: header, Request: r}, nil
}

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

type fixture struct {
	t     *testing.T
	srv   *oauth.Server
	path  string
	clock *clock
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, path: filepath.Join(t.TempDir(), "oauth.json"), clock: &clock{now: time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)}}
	f.srv = f.open()
	return f
}

func (f *fixture) open() *oauth.Server {
	f.t.Helper()
	srv, err := oauth.New(oauth.Config{
		StatePath: f.path,
		Base:      base,
		HTTP: &http.Client{Transport: documents{
			cimdID:                         `{"client_id":"` + cimdID + `","client_name":"ChatGPT","redirect_uris":["` + redirect + `"],"token_endpoint_auth_method":"none"}`,
			movedID:                        "->http://127.0.0.1:22/internal",
			"http://127.0.0.1:22/internal": `{"client_id":"` + movedID + `","redirect_uris":["` + redirect + `"]}`,
		}},
		Now: f.clock.Now,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return srv
}

func (f *fixture) do(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	return rec
}

func (f *fixture) getJSON(path string) map[string]any {
	f.t.Helper()
	rec := f.do(httptest.NewRequest("GET", path, nil))
	if rec.Code != http.StatusOK {
		f.t.Fatalf("GET %s = %d %s", path, rec.Code, rec.Body)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		f.t.Fatal(err)
	}
	return out
}

func authorizeQuery(client string) url.Values {
	return url.Values{
		"response_type": {"code"}, "client_id": {client}, "redirect_uri": {redirect},
		"code_challenge": {challenge(verifier)}, "code_challenge_method": {"S256"},
		"state": {"st8"}, "resource": {resource}, "scope": {"mcp"},
	}
}

// approve walks the owner's consent and returns the code the client gets.
func (f *fixture) approve(client string) string {
	f.t.Helper()
	q := authorizeQuery(client)
	page := f.do(httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), "chatgpt.com") {
		f.t.Fatalf("consent page = %d %s", page.Code, page.Body)
	}
	form := url.Values{"decision": {"allow"}}
	for k, v := range q {
		form[k] = v
	}
	req := httptest.NewRequest("POST", "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := f.do(req)
	if rec.Code != http.StatusFound {
		f.t.Fatalf("consent = %d %s", rec.Code, rec.Body)
	}
	to, _ := url.Parse(rec.Header().Get("Location"))
	if !strings.HasPrefix(to.String(), redirect+"?") || to.Query().Get("state") != "st8" || to.Query().Get("iss") != base {
		f.t.Fatalf("redirect = %s", to)
	}
	return to.Query().Get("code")
}

func (f *fixture) token(form url.Values) (int, map[string]any) {
	f.t.Helper()
	req := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := f.do(req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (f *fixture) exchange(client, code string) map[string]any {
	f.t.Helper()
	code2, out := f.token(url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect},
		"client_id": {client}, "code_verifier": {verifier}, "resource": {resource},
	})
	if code2 != http.StatusOK {
		f.t.Fatalf("token = %d %v", code2, out)
	}
	return out
}

func (f *fixture) valid(access string) bool {
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+access)
	return f.srv.Valid(req)
}

func TestMetadata(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"} {
		pr := f.getJSON(path)
		if pr["resource"] != resource || pr["authorization_servers"].([]any)[0] != base {
			t.Fatalf("%s = %v", path, pr)
		}
	}
	as := f.getJSON("/.well-known/oauth-authorization-server")
	if as["issuer"] != base || as["authorization_endpoint"] != base+"/oauth/authorize" || as["token_endpoint"] != base+"/oauth/token" ||
		as["client_id_metadata_document_supported"] != true || as["registration_endpoint"] != base+"/oauth/register" {
		t.Fatalf("as = %v", as)
	}
	if got := as["code_challenge_methods_supported"].([]any); len(got) != 1 || got[0] != "S256" {
		t.Fatalf("pkce = %v", got)
	}
	if !strings.Contains(f.srv.Challenge(httptest.NewRequest("POST", "/api/mcp", nil)), `resource_metadata="`+base+`/.well-known/oauth-protected-resource/api/mcp"`) {
		t.Fatal("challenge does not point at the metadata")
	}
}

func TestBaseFollowsTheRequestWhenNotSet(t *testing.T) {
	srv, err := oauth.New(oauth.Config{StatePath: filepath.Join(t.TempDir(), "o.json")})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/.well-known/oauth-protected-resource", nil)
	req.Host = "chamber.zygin.dev"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"resource":"https://chamber.zygin.dev/api/mcp"`) {
		t.Fatalf("metadata = %s", rec.Body)
	}
}

func TestClientMetadataDocumentFlow(t *testing.T) {
	f := newFixture(t)
	tok := f.exchange(cimdID, f.approve(cimdID))
	if tok["token_type"] != "Bearer" || tok["refresh_token"] == "" || tok["expires_in"].(float64) <= 0 {
		t.Fatalf("token = %v", tok)
	}
	if !f.valid(tok["access_token"].(string)) {
		t.Fatal("access token not accepted")
	}
	if f.valid("nonsense") {
		t.Fatal("nonsense accepted")
	}
}

func TestRegisteredClientFlow(t *testing.T) {
	f := newFixture(t)
	req := httptest.NewRequest("POST", "/oauth/register", strings.NewReader(`{"client_name":"ChatGPT","redirect_uris":["`+redirect+`"],"token_endpoint_auth_method":"none"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := f.do(req)
	var reg map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &reg)
	if rec.Code != http.StatusCreated || reg["client_id"] == "" {
		t.Fatalf("register = %d %s", rec.Code, rec.Body)
	}
	client := reg["client_id"].(string)
	tok := f.exchange(client, f.approve(client))
	if !f.valid(tok["access_token"].(string)) {
		t.Fatal("access token not accepted")
	}
}

func TestRegistrationOnlyForChatGPTRedirects(t *testing.T) {
	f := newFixture(t)
	req := httptest.NewRequest("POST", "/oauth/register", strings.NewReader(`{"redirect_uris":["https://evil.example/cb"]}`))
	if rec := f.do(req); rec.Code != http.StatusBadRequest {
		t.Fatalf("register = %d %s", rec.Code, rec.Body)
	}
}

func TestAuthorizeRefusesWhatItCannotTrust(t *testing.T) {
	f := newFixture(t)
	for name, change := range map[string]func(url.Values){
		"unknown client":       func(q url.Values) { q.Set("client_id", "nope") },
		"foreign redirect":     func(q url.Values) { q.Set("redirect_uri", "https://evil.example/cb") },
		"document not found":   func(q url.Values) { q.Set("client_id", "https://chatgpt.com/oauth/gone/client.json") },
		"not a document url":   func(q url.Values) { q.Set("client_id", "https://chatgpt.com/share/x.json") },
		"redirected document":  func(q url.Values) { q.Set("client_id", movedID) },
		"another chatgpt path": func(q url.Values) { q.Set("redirect_uri", "https://chatgpt.com/share/abc") },
		"foreign document":     func(q url.Values) { q.Set("client_id", "https://evil.example/client.json") },
		"another resource":     func(q url.Values) { q.Set("resource", "https://elsewhere.dev/api/mcp") },
		"plain pkce":           func(q url.Values) { q.Set("code_challenge_method", "plain") },
		"no pkce":              func(q url.Values) { q.Del("code_challenge") },
		"not the code flow":    func(q url.Values) { q.Set("response_type", "token") },
	} {
		t.Run(name, func(t *testing.T) {
			q := authorizeQuery(cimdID)
			change(q)
			rec := f.do(httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil))
			if rec.Code == http.StatusOK {
				t.Fatalf("consent offered: %s", rec.Body)
			}
			if loc := rec.Header().Get("Location"); strings.HasPrefix(loc, "https://evil.example") {
				t.Fatalf("redirected to %s", loc)
			}
		})
	}
}

func TestDenyTellsTheClient(t *testing.T) {
	f := newFixture(t)
	form := authorizeQuery(cimdID)
	form.Set("decision", "deny")
	req := httptest.NewRequest("POST", "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := f.do(req)
	to, _ := url.Parse(rec.Header().Get("Location"))
	if rec.Code != http.StatusFound || to.Query().Get("error") != "access_denied" || to.Query().Get("code") != "" {
		t.Fatalf("deny = %d %s", rec.Code, to)
	}
}

func TestCodeIsCheckedAndSpent(t *testing.T) {
	f := newFixture(t)
	code := f.approve(cimdID)
	good := url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect},
		"client_id": {cimdID}, "code_verifier": {verifier}, "resource": {resource},
	}
	for name, change := range map[string]func(url.Values){
		"wrong verifier": func(v url.Values) { v.Set("code_verifier", "x"+verifier) },
		"wrong redirect": func(v url.Values) { v.Set("redirect_uri", redirect+"x") },
		"wrong client":   func(v url.Values) { v.Set("client_id", "https://chatgpt.com/oauth/x/client.json") },
		"wrong resource": func(v url.Values) { v.Set("resource", "https://elsewhere.dev/api/mcp") },
	} {
		bad := url.Values{}
		for k, v := range good {
			bad[k] = append([]string(nil), v...)
		}
		change(bad)
		if status, out := f.token(bad); status != http.StatusBadRequest || out["error"] != "invalid_grant" {
			t.Fatalf("%s: %d %v", name, status, out)
		}
	}
	// A failed attempt burns the code, as a stolen one must not be retried.
	if status, _ := f.token(good); status != http.StatusBadRequest {
		t.Fatalf("code survived failed attempts: %d", status)
	}
}

func TestCodeExpires(t *testing.T) {
	f := newFixture(t)
	code := f.approve(cimdID)
	f.clock.now = f.clock.now.Add(2 * time.Minute)
	if status, _ := f.token(url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect},
		"client_id": {cimdID}, "code_verifier": {verifier}, "resource": {resource},
	}); status != http.StatusBadRequest {
		t.Fatalf("expired code = %d", status)
	}
}

func TestAccessExpiresAndRefreshRotates(t *testing.T) {
	f := newFixture(t)
	tok := f.exchange(cimdID, f.approve(cimdID))
	f.clock.now = f.clock.now.Add(2 * time.Hour)
	if f.valid(tok["access_token"].(string)) {
		t.Fatal("expired access accepted")
	}
	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {cimdID}, "resource": {resource}}
	status, next := f.token(refresh)
	if status != http.StatusOK || !f.valid(next["access_token"].(string)) || next["refresh_token"] == tok["refresh_token"] {
		t.Fatalf("refresh = %d %v", status, next)
	}
	if status, _ := f.token(refresh); status != http.StatusBadRequest {
		t.Fatalf("old refresh token reused: %d", status)
	}
}

func TestRefreshSurvivesARestartAndAccessDoesNotNeedTo(t *testing.T) {
	f := newFixture(t)
	tok := f.exchange(cimdID, f.approve(cimdID))
	f.srv = f.open()
	status, next := f.token(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {cimdID}, "resource": {resource}})
	if status != http.StatusOK || !f.valid(next["access_token"].(string)) {
		t.Fatalf("refresh after restart = %d %v", status, next)
	}
}

func TestTokenForAnotherResourceIsRefused(t *testing.T) {
	f := newFixture(t)
	tok := f.exchange(cimdID, f.approve(cimdID))
	req := httptest.NewRequest("POST", "/api/other", nil)
	req.Header.Set("Authorization", "Bearer "+tok["access_token"].(string))
	if f.srv.Valid(req) {
		t.Fatal("token used outside the MCP endpoint")
	}
}

func TestRegisteredClientsAreCapped(t *testing.T) {
	f := newFixture(t)
	var first string
	for i := range 60 {
		f.clock.now = f.clock.now.Add(time.Second)
		rec := f.do(httptest.NewRequest("POST", "/oauth/register", strings.NewReader(`{"redirect_uris":["`+redirect+`"]}`)))
		var reg map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &reg)
		if i == 0 {
			first = reg["client_id"].(string)
		}
	}
	q := authorizeQuery(first)
	if rec := f.do(httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)); rec.Code == http.StatusOK {
		t.Fatal("the oldest client outlived the cap")
	}
	if _, err := os.Stat(f.path); !os.IsNotExist(err) {
		t.Fatalf("registration wrote the state: %v", err)
	}
}

func TestPublicEndpoints(t *testing.T) {
	f := newFixture(t)
	for path, want := range map[string]bool{
		"/.well-known/oauth-protected-resource/api/mcp": true, "/.well-known/oauth-authorization-server": true,
		"/oauth/token": true, "/oauth/register": true, "/oauth/authorize": false, "/api/mcp": false,
	} {
		if got := f.srv.Public(path); got != want {
			t.Errorf("Public(%s) = %v", path, got)
		}
	}
}

func register(f *fixture, body string) *httptest.ResponseRecorder {
	return f.do(httptest.NewRequest("POST", "/oauth/register", strings.NewReader(body)))
}

func TestRedirectMustBeChatGPTsCallback(t *testing.T) {
	f := newFixture(t)
	for uri, ok := range map[string]bool{
		redirect: true,
		"https://chatgpt.com/connector/oauth/cb_123-AZ":                      true,
		"https://chatgpt.com/share/abc":                                      false,
		"https://chatgpt.com/connector/oauth/a/b":                            false,
		"https://chatgpt.com/connector/oauth/":                               false,
		"https://chatgpt.com/%zz":                                            false,
		redirect + "#x":                                                      false,
		redirect + "?next=https://evil.example":                              false,
		"https://user@chatgpt.com/connector_platform_oauth_redirect":         false,
		"http://chatgpt.com/connector_platform_oauth_redirect":               false,
		"https://chatgpt.com.evil.example/connector_platform_oauth_redirect": false,
	} {
		rec := register(f, `{"redirect_uris":["`+uri+`"]}`)
		if got := rec.Code == http.StatusCreated; got != ok {
			t.Errorf("%s: %d %s", uri, rec.Code, rec.Body)
		}
	}
}

func TestRegistrationIsBounded(t *testing.T) {
	f := newFixture(t)
	if rec := register(f, `{"client_name":"`+strings.Repeat("n", 300)+`","redirect_uris":["`+redirect+`"]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("long name = %d", rec.Code)
	}
	many := strings.TrimSuffix(strings.Repeat(`"`+redirect+`",`, 6), ",")
	if rec := register(f, `{"redirect_uris":[`+many+`]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("many redirects = %d", rec.Code)
	}
}

func TestConsentNamesTheWholeRedirectAndRefusesFrames(t *testing.T) {
	f := newFixture(t)
	rec := f.do(httptest.NewRequest("GET", "/oauth/authorize?"+authorizeQuery(cimdID).Encode(), nil))
	if !strings.Contains(rec.Body.String(), redirect) || rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatalf("consent = %s %v", rec.Body, rec.Header())
	}
}

func TestMetadataFetchFailureStaysVague(t *testing.T) {
	f := newFixture(t)
	q := authorizeQuery("https://chatgpt.com/oauth/gone/client.json")
	rec := f.do(httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil))
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), "upstream-secret-status") {
		t.Fatalf("refusal = %d %s", rec.Code, rec.Body)
	}
}

func TestCorruptStateIsSetAside(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oauth.json")
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := oauth.New(oauth.Config{StatePath: path, Base: base}); err != nil {
		t.Fatalf("a broken state stopped the server: %v", err)
	}
	if raw, err := os.ReadFile(path + ".corrupt"); err != nil || string(raw) != "{" {
		t.Fatalf("broken state not kept aside: %q %v", raw, err)
	}
}

func TestRefreshTokenOutlivesAFailedSave(t *testing.T) {
	f := newFixture(t)
	tok := f.exchange(cimdID, f.approve(cimdID))
	dir := filepath.Dir(f.path)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	refresh := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {cimdID}}
	status, _ := f.token(refresh)
	_ = os.Chmod(dir, 0o700)
	if status != http.StatusInternalServerError {
		t.Fatalf("refresh with an unwritable state = %d", status)
	}
	if status, _ := f.token(refresh); status != http.StatusOK {
		t.Fatalf("refresh token lost: %d", status)
	}
}

func TestTokenRequestMayOmitTheRedirect(t *testing.T) {
	f := newFixture(t)
	status, out := f.token(url.Values{"grant_type": {"authorization_code"}, "code": {f.approve(cimdID)}, "client_id": {cimdID}, "code_verifier": {verifier}})
	if status != http.StatusOK {
		t.Fatalf("token = %d %v", status, out)
	}
}

func TestShortVerifierIsRefused(t *testing.T) {
	f := newFixture(t)
	q := authorizeQuery(cimdID)
	q.Set("code_challenge", challenge("short"))
	form := url.Values{"decision": {"allow"}}
	for k, v := range q {
		form[k] = v
	}
	req := httptest.NewRequest("POST", "/oauth/authorize", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	to, _ := url.Parse(f.do(req).Header().Get("Location"))
	if status, _ := f.token(url.Values{"grant_type": {"authorization_code"}, "code": {to.Query().Get("code")}, "client_id": {cimdID}, "code_verifier": {"short"}}); status != http.StatusBadRequest {
		t.Fatalf("short verifier = %d", status)
	}
}

func TestUnknownWellKnownIsNotFound(t *testing.T) {
	f := newFixture(t)
	if !f.srv.Public("/.well-known/openid-configuration") {
		t.Fatal("well-known paths need no login")
	}
	if rec := f.do(httptest.NewRequest("GET", "/.well-known/openid-configuration", nil)); rec.Code != http.StatusNotFound {
		t.Fatalf("openid-configuration = %d", rec.Code)
	}
}

func TestChallengeSaysWhenTheTokenIsBad(t *testing.T) {
	f := newFixture(t)
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	if strings.Contains(f.srv.Challenge(req), "invalid_token") {
		t.Fatal("no token is no bad token")
	}
	req.Header.Set("Authorization", "Bearer stale")
	if !strings.Contains(f.srv.Challenge(req), `error="invalid_token"`) {
		t.Fatalf("challenge = %s", f.srv.Challenge(req))
	}
}
