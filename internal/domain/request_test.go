package domain

import (
	"encoding/json"
	"errors"
	"testing"
)

func pendingRequest() *Request {
	return &Request{ID: "r1", SessionID: "s1", TurnID: "t1", Kind: RequestPermission, State: RequestPending}
}

func TestRequestValidate(t *testing.T) {
	cases := []struct {
		name string
		r    Request
	}{
		{"empty id", Request{SessionID: "s1", Kind: RequestPermission}},
		{"empty session", Request{ID: "r1", Kind: RequestPermission}},
		{"unknown kind", Request{ID: "r1", SessionID: "s1", Kind: RequestKind("nope")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.r.Validate(); !errors.Is(err, ErrInvalidRequest) {
				t.Fatalf("want ErrInvalidRequest, got %v", err)
			}
		})
	}
	if err := pendingRequest().Validate(); err != nil {
		t.Fatalf("valid request rejected: %v", err)
	}
}

func TestRequestResolve(t *testing.T) {
	r := pendingRequest()
	answer := json.RawMessage(`{"behavior":"allow"}`)
	if err := r.Resolve(answer); err != nil {
		t.Fatal(err)
	}
	if r.State != RequestResolved || string(r.Answer) != string(answer) {
		t.Fatalf("request = %+v", r)
	}
	if err := r.Resolve(answer); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("second resolve: want ErrInvalidRequest, got %v", err)
	}
}

func TestRequestMarkStale(t *testing.T) {
	r := pendingRequest()
	r.MarkStale()
	if r.State != RequestStale {
		t.Fatalf("state = %s", r.State)
	}
	if err := r.Resolve(nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("resolve stale: want ErrInvalidRequest, got %v", err)
	}
}

func TestRequestKindValid(t *testing.T) {
	for _, k := range []RequestKind{RequestPermission, RequestQuestion, RequestElicitation} {
		if !k.Valid() {
			t.Errorf("%s should be valid", k)
		}
	}
	if RequestKind("x").Valid() {
		t.Error("unknown kind must be invalid")
	}
}
