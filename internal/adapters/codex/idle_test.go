package codex

import (
	"encoding/json"
	"testing"
	"time"
)

func TestCloseUnsubscribesOwnedThread(t *testing.T) {
	s, peer := newPipeServer(t)
	rt := s.newRuntime("idle", NewMapper("s"))
	s.register(rt)
	done := make(chan error, 1)
	go func() { done <- rt.Close() }()
	request := make(chan rpcMessage, 1)
	go func() {
		line, _ := peer.r.ReadBytes('\n')
		var m rpcMessage
		_ = json.Unmarshal(line, &m)
		request <- m
	}()
	select {
	case m := <-request:
		if m.Method != "thread/unsubscribe" || string(m.Params) != `{"threadId":"idle"}` {
			t.Fatalf("unsubscribe = %+v", m)
		}
		peer.send(rpcMessage{JSONRPC: "2.0", ID: m.ID, Result: json.RawMessage(`{"status":"unsubscribed"}`)})
	case <-time.After(time.Second):
		t.Fatal("Close did not unsubscribe the loaded thread")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	if !s.alive() {
		t.Fatal("closing one thread stopped the shared server")
	}
}

func TestCloseReplacedRuntimeKeepsNewSubscription(t *testing.T) {
	s, _ := newPipeServer(t)
	old := s.newRuntime("thread", NewMapper("old"))
	s.register(old)
	current := s.newRuntime("thread", NewMapper("new"))
	s.register(current)
	done := make(chan error, 1)
	go func() { done <- old.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("stale runtime attempted unsubscribe")
	}
	s.mu.Lock()
	got := s.threads["thread"]
	s.mu.Unlock()
	if got != current {
		t.Fatal("closed the replacement runtime")
	}
}

func TestCloseFinishesUnsubscribeBeforeReplacementAttaches(t *testing.T) {
	s, peer := newPipeServer(t)
	old := s.newRuntime("thread", NewMapper("old"))
	s.register(old)
	done := make(chan error, 1)
	go func() { done <- old.Close() }()
	request := peer.read()
	if request.Method != "thread/unsubscribe" {
		t.Fatalf("method = %s", request.Method)
	}
	attached := make(chan *Runtime, 1)
	go func() { rt, _ := s.attachThread("thread", "new"); attached <- rt }()
	select {
	case <-attached:
		t.Fatal("replacement attached before unsubscribe finished")
	case <-time.After(20 * time.Millisecond):
	}
	peer.send(rpcMessage{JSONRPC: "2.0", ID: request.ID, Result: json.RawMessage(`{"status":"unsubscribed"}`)})
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case rt := <-attached:
		if rt == old {
			t.Fatal("reused the closed runtime")
		}
	case <-time.After(time.Second):
		t.Fatal("replacement remained blocked")
	}
}

func TestCrashRecoveryDoesNotResumeClosedRuntime(t *testing.T) {
	s, _ := newPipeServer(t)
	rt := s.newRuntime("thread", NewMapper("s"))
	// An unregistered runtime needs no unsubscribe.
	if err := rt.Close(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.resume(rt) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("closed runtime attempted resume")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.threads) != 0 {
		t.Fatal("closed runtime registered again")
	}
}

func TestHungUnsubscribeDoesNotBlockOtherThreads(t *testing.T) {
	s, peer := newPipeServer(t)
	old := s.newRuntime("idle", NewMapper("old"))
	s.register(old)
	go func() { _ = old.Close() }()
	if request := peer.read(); request.Method != "thread/unsubscribe" {
		t.Fatalf("method = %s", request.Method)
	}
	attached := make(chan *Runtime, 1)
	go func() { rt, _ := s.attachThread("other", "new"); attached <- rt }()
	select {
	case rt := <-attached:
		if rt == nil {
			t.Fatal("attach failed")
		}
	case <-time.After(time.Second):
		t.Fatal("another thread waited for a hung unsubscribe")
	}
}
