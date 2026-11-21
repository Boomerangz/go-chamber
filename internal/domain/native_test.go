package domain

import "testing"

func TestNativeSessionSupportsPermissionModesAndFork(t *testing.T) {
	s, err := NewSession("native", AgentKind("native"), "/project")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SetPermissionMode("read-only"); err != nil {
		t.Fatal(err)
	}
	if err = s.RuntimeAttached("journal"); err != nil {
		t.Fatal(err)
	}
	fork, err := NewForkSession("fork", s)
	if err != nil || fork.Agent() != AgentKind("native") {
		t.Fatalf("%+v %v", fork, err)
	}
}
