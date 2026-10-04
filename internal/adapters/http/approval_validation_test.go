package httpapi

import (
	"net/http"
	"testing"
)

func TestEmptyApprovalMustNotAllow(t *testing.T) {
	f := &fakeSessions{}
	h := newSessionsServer(f, nil)
	rec := do(h, authed("POST", "/api/sessions/a/requests/r1", `{}`))
	if rec.Code != http.StatusBadRequest || f.answered != nil {
		t.Fatalf("empty answer approved request: status=%d answer=%+v", rec.Code, f.answered)
	}
}
