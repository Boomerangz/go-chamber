package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

const testToken = "s3cret"

func newTestServer() http.Handler {
	static := fstest.MapFS{
		"index.html":    {Data: []byte("<html>app</html>")},
		"assets/a.js":   {Data: []byte("console.log(1)")},
		"manifest.json": {Data: []byte("{}")},
	}
	return NewServer(Config{Token: testToken, Static: static})
}

func do(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func withCookie(req *http.Request, value string) *http.Request {
	req.AddCookie(&http.Cookie{Name: CookieName, Value: value})
	return req
}

func TestAPIRequiresAuth(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/api/health", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestAPIRejectsWrongCookie(t *testing.T) {
	rec := do(newTestServer(), withCookie(httptest.NewRequest("GET", "/api/health", nil), "nope"))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestAPIAcceptsCookie(t *testing.T) {
	rec := do(newTestServer(), withCookie(httptest.NewRequest("GET", "/api/health", nil), testToken))
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["status"] != "ok" {
		t.Fatalf("body = %q, err = %v", rec.Body.String(), err)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
}

func TestAPIAcceptsBearer(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/health", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	if rec := do(newTestServer(), req); rec.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", rec.Code)
	}
}

func TestAPIRejectsWrongBearer(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/health", nil)
	req.Header.Set("Authorization", "Bearer x")
	if rec := do(newTestServer(), req); rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestTokenQueryLogsInAndRedirects(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/sessions/x?token="+testToken+"&tab=diff", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("code = %d, want 302", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/sessions/x?tab=diff" {
		t.Fatalf("location = %q", loc)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies = %v", cookies)
	}
	c := cookies[0]
	if c.Name != CookieName || c.Value != testToken || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Fatalf("cookie = %+v", c)
	}
}

func TestTokenQueryRedirectWithoutOtherParams(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/?token="+testToken, nil))
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Fatalf("location = %q", loc)
	}
}

func TestWrongTokenQueryIsUnauthorized(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/?token=bad", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("must not set cookie for bad token")
	}
}

func TestPagesRequireAuth(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestServesStaticAndSPAFallback(t *testing.T) {
	h := newTestServer()
	cases := map[string]string{
		"/":            "<html>app</html>",
		"/assets/a.js": "console.log(1)",
		"/sessions/42": "<html>app</html>",
	}
	for path, want := range cases {
		rec := do(h, withCookie(httptest.NewRequest("GET", path, nil), testToken))
		if rec.Code != http.StatusOK || rec.Body.String() != want {
			t.Fatalf("%s: code=%d body=%q", path, rec.Code, rec.Body.String())
		}
	}
}

func TestMissingAssetIs404NotFallback(t *testing.T) {
	rec := do(newTestServer(), withCookie(httptest.NewRequest("GET", "/assets/missing.js", nil), testToken))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestUnknownAPIRouteIs404(t *testing.T) {
	rec := do(newTestServer(), withCookie(httptest.NewRequest("GET", "/api/nope", nil), testToken))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestEmptyTokenConfigPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("want panic on empty token")
		}
	}()
	NewServer(Config{Token: ""})
}
