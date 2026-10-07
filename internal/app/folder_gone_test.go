package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// folderProbe answers FolderExists from a set of existing folders.
type folderProbe struct {
	mu       sync.Mutex
	existing map[string]bool
	err      error
}

func (p *folderProbe) FolderExists(path string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.existing[path], p.err
}

func (p *folderProbe) remove(path string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.existing, path)
}

func TestCreateSessionRefusesAMissingFolder(t *testing.T) {
	repo := newMemRepo()
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		Folders: &folderProbe{existing: map[string]bool{"/tmp/here": true}}})
	ctx := context.Background()
	_, err := m.CreateSession(ctx, domain.AgentClaude, "/tmp/gone")
	if !errors.Is(err, domain.ErrFolderGone) || !strings.Contains(err.Error(), "/tmp/gone") {
		t.Fatalf("err = %v", err)
	}
	if all, _ := repo.List(ctx); len(all) != 0 {
		t.Fatalf("a session in a missing folder was kept: %+v", all)
	}
	if _, err := m.CreateSession(ctx, domain.AgentClaude, "/tmp/here"); err != nil {
		t.Fatalf("existing folder: %v", err)
	}
}

func TestCreateSessionReportsAFolderItCannotCheck(t *testing.T) {
	boom := errors.New("stat: permission denied")
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		Folders: &folderProbe{err: boom}})
	if _, err := m.CreateSession(context.Background(), domain.AgentClaude, "/tmp/x"); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestCreateSessionChecksTheFolderOfAValidSessionOnly(t *testing.T) {
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		Folders: &folderProbe{}})
	if _, err := m.CreateSession(context.Background(), domain.AgentKind("x"), "/p"); !errors.Is(err, domain.ErrInvalidSession) {
		t.Fatalf("err = %v", err)
	}
}

func TestForkRefusesAMissingFolder(t *testing.T) {
	repo, factory := newMemRepo(), &fakeFactory{}
	probe := &folderProbe{existing: map[string]bool{"/tmp/proj": true}}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: newFakeBus(), Folders: probe,
		NewID: (&counter{}).next})
	t.Cleanup(m.Close)
	parent := createClaude(t, m)
	startWith(t, m, factory, parent.ID, newFakeRuntime("native-1"))
	starts := len(factory.requests())
	probe.remove("/tmp/proj")
	ctx := context.Background()
	if _, err := m.Fork(ctx, parent.ID); !errors.Is(err, domain.ErrFolderGone) {
		t.Fatalf("err = %v", err)
	}
	if len(factory.requests()) != starts {
		t.Fatal("an agent was started in a missing folder")
	}
	if all, _ := repo.List(ctx); len(all) != 1 {
		t.Fatalf("sessions = %+v", all)
	}
}
