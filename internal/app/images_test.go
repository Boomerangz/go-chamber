package app

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// imageRuntime is a runtime that accepts images with a message.
type imageRuntime struct {
	*fakeRuntime
	mu     sync.Mutex
	images []Image
	text   string
}

func (r *imageRuntime) SendImages(_ context.Context, _ domain.TurnID, text string, images []Image) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.text, r.images = text, images
	return nil
}

func TestSendInputHandsImagesToTheAgentAndShowsThem(t *testing.T) {
	m, _, bus, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := &imageRuntime{fakeRuntime: newFakeRuntime("n1")}
	factory.next = rt
	images := []Image{{ID: "i1", Path: "/data/i1.png", MimeType: "image/png"}}
	if err := m.SendInput(context.Background(), snap.ID, "what is this?", images); err != nil {
		t.Fatal(err)
	}
	rt.mu.Lock()
	got, text := rt.images, rt.text
	rt.mu.Unlock()
	if text != "what is this?" || !slices.Equal(got, images) {
		t.Fatalf("sent %q %v", text, got)
	}
	var user *domain.Item
	for _, ev := range bus.snapshot() {
		if ev.Item != nil && ev.Item.Kind == domain.ItemUserMessage {
			user = ev.Item
		}
	}
	if user == nil || !slices.Equal(user.Images, []string{"i1"}) {
		t.Fatalf("user item = %+v", user)
	}
}

func TestSendInputWithoutImagesIsAPlainMessage(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	rt := newFakeRuntime("n1")
	factory.next = rt
	if err := m.SendInput(context.Background(), snap.ID, "hi", nil); err != nil {
		t.Fatal(err)
	}
	if got := rt.sentMessages(); len(got) != 1 {
		t.Fatalf("sent = %v", got)
	}
}

func TestSendInputRejectsImagesTheAgentCannotTake(t *testing.T) {
	m, _, _, factory, _ := newTestManager(t)
	snap := createClaude(t, m)
	factory.next = newFakeRuntime("n1")
	err := m.SendInput(context.Background(), snap.ID, "hi", []Image{{ID: "i1", Path: "/x.png", MimeType: "image/png"}})
	if !errors.Is(err, ErrImagesUnsupported) {
		t.Fatalf("err = %v", err)
	}
	if s, _ := m.GetSession(context.Background(), snap.ID); s.Status == domain.StatusRunning {
		t.Fatal("session left running after a refused send")
	}
}
