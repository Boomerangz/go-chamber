package domain

import "testing"

func TestRequestGist(t *testing.T) {
	cases := []struct {
		name string
		req  Request
		want string
	}{
		{"question", Request{Kind: RequestQuestion, Title: "Question",
			Payload: []byte(`{"input":{"questions":[{"question":"Which  colour?\n"}]}}`)}, "Which colour?"},
		{"questions", Request{Kind: RequestQuestion,
			Payload: []byte(`{"input":{"questions":[{"question":"One?"},{"question":"Two?"},{"question":"Three?"}]}}`)}, "One? (+2 more)"},
		{"command", Request{Kind: RequestPermission, Title: "Run command",
			Payload: []byte(`{"toolName":"Bash","input":{"command":"rm -rf  build"}}`)}, "rm -rf build"},
		{"file", Request{Kind: RequestPermission, Title: "Edit",
			Payload: []byte(`{"toolName":"Edit","input":{"file_path":"/src/app/main.go"}}`)}, "Edit main.go"},
		{"path without tool", Request{Kind: RequestPermission,
			Payload: []byte(`{"input":{"path":"/src/app/dir/"}}`)}, "dir"},
		{"prompt", Request{Kind: RequestElicitation, Title: "Input", Prompt: "Pick a\nname"}, "Pick a name"},
		{"title", Request{Kind: RequestPermission, Title: "Run command", Payload: []byte(`not json`)}, "Run command"},
		{"tool", Request{Kind: RequestPermission, Payload: []byte(`{"toolName":"WebFetch"}`)}, "WebFetch"},
		{"nothing", Request{Kind: RequestPermission}, "Request"},
	}
	for _, c := range cases {
		if got := c.req.Gist(); got != c.want {
			t.Errorf("%s: Gist() = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestInterruptedWithRequestKeepsTheFirstRequestsGist(t *testing.T) {
	s := newTestSession(t)
	mustNoErr(t, s.RuntimeAttached("n"))
	mustNoErr(t, s.TurnStarted())
	mustNoErr(t, s.TurnInterrupted(ExitCrashed))
	s.InterruptedWithRequest(&Request{Kind: RequestPermission, Payload: []byte(`{"input":{"command":"make deploy"}}`)})
	s.InterruptedWithRequest(&Request{Kind: RequestQuestion, Title: "later"})
	if got := s.Interruption(); !got.WithRequest || got.Request != "make deploy" {
		t.Fatalf("interruption = %+v", got)
	}
	restored, err := RestoreSession(s.Snapshot())
	mustNoErr(t, err)
	if restored.Interruption().Request != "make deploy" {
		t.Fatal("the request's gist was lost on restore")
	}
	mustNoErr(t, s.TurnStarted())
	if s.Interruption().Request != "" {
		t.Fatal("a new turn keeps the old request")
	}
}
