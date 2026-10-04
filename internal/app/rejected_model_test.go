package app

import (
	"context"
	"errors"
	"testing"
)

func TestRejectedModelIsNotSaved(t *testing.T) {
	m, repo, _, factory, _ := newTestManager(t)
	defer m.Close()
	snap := createClaude(t, m)
	rt := &modelRuntime{fakeRuntime: newFakeRuntime("n1"), err: errors.New("model rejected")}
	startWith(t, m, factory, snap.ID, rt)
	if _, err := m.SetModel(context.Background(), snap.ID, "bad-model", ""); err == nil {
		t.Fatal("expected rejection")
	}
	saved, err := repo.Get(context.Background(), snap.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Model != "" {
		t.Fatalf("rejected model persisted as %q", saved.Model)
	}
}
