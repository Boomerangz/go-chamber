package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

func (f *fakeSessions) Continue(_ context.Context, id domain.SessionID) error {
	if f.err != nil {
		return f.err
	}
	f.continued = id
	return nil
}

func (f *fakeSessions) SetAutoContinue(_ context.Context, id domain.SessionID, on bool) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	return domain.SessionSnapshot{ID: id, AutoContinue: on}, nil
}

func (f *fakeSessions) Fork(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if f.err != nil {
		return domain.SessionSnapshot{}, f.err
	}
	return domain.SessionSnapshot{ID: "forked", ForkOf: id}, nil
}

func TestContinueEndpoint(t *testing.T) {
	f := &fakeSessions{}
	rec := do(newSessionsServer(f, nil), authed("POST", "/api/sessions/a/continue", ""))
	if rec.Code != http.StatusAccepted || f.continued != "a" {
		t.Fatalf("code=%d continued=%q", rec.Code, f.continued)
	}
	f = &fakeSessions{err: fmt.Errorf("%w: nothing to continue", domain.ErrInvalidTransition)}
	if rec := do(newSessionsServer(f, nil), authed("POST", "/api/sessions/a/continue", "")); rec.Code != http.StatusConflict {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestAutoContinueEndpoint(t *testing.T) {
	rec := do(newSessionsServer(&fakeSessions{}, nil), authed("POST", "/api/sessions/a/auto-continue", `{"on":true}`))
	var got domain.SessionSnapshot
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &got) != nil || !got.AutoContinue {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body)
	}
	if rec := do(newSessionsServer(&fakeSessions{}, nil), authed("POST", "/api/sessions/a/auto-continue", `{`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad body code = %d", rec.Code)
	}
	f := &fakeSessions{err: errors.New("boom")}
	if rec := do(newSessionsServer(f, nil), authed("POST", "/api/sessions/a/auto-continue", `{"on":false}`)); rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d", rec.Code)
	}
}

func TestForkEndpoint(t *testing.T) {
	rec := do(newSessionsServer(&fakeSessions{}, nil), authed("POST", "/api/sessions/a/fork", ""))
	var got domain.SessionSnapshot
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &got) != nil || got.ForkOf != "a" {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body)
	}
	f := &fakeSessions{err: fmt.Errorf("%w: fork before the first turn", domain.ErrInvalidTransition)}
	if rec := do(newSessionsServer(f, nil), authed("POST", "/api/sessions/a/fork", "")); rec.Code != http.StatusConflict {
		t.Fatalf("code = %d", rec.Code)
	}
}
