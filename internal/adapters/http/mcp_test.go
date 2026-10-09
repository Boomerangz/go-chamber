package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMCPIsServedBehindTheToken(t *testing.T) {
	var reached []string
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = append(reached, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusAccepted)
	})
	srv := NewServer(Config{Token: testToken, MCP: mcp})

	if rec := do(srv, httptest.NewRequest("POST", "/api/mcp", nil)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: code = %d", rec.Code)
	}
	for _, method := range []string{"POST", "GET", "DELETE"} {
		req := httptest.NewRequest(method, "/api/mcp", nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		if rec := do(srv, req); rec.Code != http.StatusAccepted {
			t.Fatalf("%s: code = %d", method, rec.Code)
		}
	}
	if len(reached) != 3 {
		t.Fatalf("reached = %v", reached)
	}
}
