package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func postForm(path string, form url.Values) *http.Request {
	req := httptest.NewRequest("POST", path, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return req
}

func TestLoginCookieOutlivesTheBrowser(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/?token="+testToken, nil))
	c := rec.Result().Cookies()[0]
	if c.MaxAge < 300*24*3600 {
		t.Fatalf("MaxAge = %d, want about a year", c.MaxAge)
	}
	if c.Secure {
		t.Fatal("plain http must not get a Secure cookie")
	}
}

func TestLoginCookieIsSecureBehindHTTPS(t *testing.T) {
	req := httptest.NewRequest("GET", "/?token="+testToken, nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	if c := do(newTestServer(), req).Result().Cookies()[0]; !c.Secure {
		t.Fatal("cookie behind https must be Secure")
	}
}

func TestPageWithoutCookieShowsLoginForm(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/s/abc", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `action="/login"`) || !strings.Contains(body, `name="token"`) || !strings.Contains(body, `value="/s/abc"`) {
		t.Fatalf("body = %s", body)
	}
}

func TestAPIWithoutCookieStaysPlain401(t *testing.T) {
	rec := do(newTestServer(), httptest.NewRequest("GET", "/api/sessions", nil))
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "<form") {
		t.Fatalf("code = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestLoginFormSetsCookieAndReturns(t *testing.T) {
	rec := do(newTestServer(), postForm("/login", url.Values{"token": {testToken}, "next": {"/s/abc?x=1"}}))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("code = %d, want 303", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/s/abc?x=1" {
		t.Fatalf("location = %q", loc)
	}
	if c := rec.Result().Cookies(); len(c) != 1 || c[0].Value != testToken {
		t.Fatalf("cookies = %v", c)
	}
}

func TestLoginFormRejectsWrongToken(t *testing.T) {
	rec := do(newTestServer(), postForm("/login", url.Values{"token": {"bad"}, "next": {"/"}}))
	if rec.Code != http.StatusUnauthorized || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("code = %d cookies = %v", rec.Code, rec.Result().Cookies())
	}
	if !strings.Contains(rec.Body.String(), "Wrong token") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestLoginFormRejectsCrossOrigin(t *testing.T) {
	req := postForm("/login", url.Values{"token": {testToken}})
	req.Header.Set("Origin", "http://evil.example")
	if rec := do(newTestServer(), req); rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestLoginNeverRedirectsOffSite(t *testing.T) {
	for _, next := range []string{"//evil.example/x", "https://evil.example", `/\evil.example`, "relative"} {
		rec := do(newTestServer(), postForm("/login", url.Values{"token": {testToken}, "next": {next}}))
		if loc := rec.Header().Get("Location"); loc != "/" {
			t.Errorf("next %q: location = %q, want /", next, loc)
		}
	}
	if loc := do(newTestServer(), httptest.NewRequest("GET", "//evil.example?token="+testToken, nil)).Header().Get("Location"); loc != "/" {
		t.Errorf("token query on //host: location = %q, want /", loc)
	}
}

func TestLogoutClearsTheCookie(t *testing.T) {
	req := withCookie(httptest.NewRequest("POST", "/logout", nil), testToken)
	rec := do(newTestServer(), req)
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/" {
		t.Fatalf("code = %d location = %q", rec.Code, rec.Header().Get("Location"))
	}
	c := rec.Result().Cookies()
	if len(c) != 1 || c[0].Name != CookieName || c[0].MaxAge >= 0 {
		t.Fatalf("cookies = %v", c)
	}
}
