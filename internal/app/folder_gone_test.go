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

// A detached session whose folder went away refuses the next message with
// the folder named, without trying to start its agent there.
func TestSendMessageRefusesAMissingFolder(t *testing.T) {
	repo, factory := newMemRepo(), &fakeFactory{}
	probe := &folderProbe{existing: map[string]bool{"/tmp/proj": true}}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: factory, Bus: newFakeBus(), Folders: probe,
		NewID: (&counter{}).next})
	t.Cleanup(m.Close)
	s := createClaude(t, m)
	probe.remove("/tmp/proj")
	err := m.SendMessage(context.Background(), s.ID, "hi")
	if !errors.Is(err, domain.ErrFolderGone) || err.Error() != "Folder /tmp/proj no longer exists" {
		t.Fatalf("err = %v", err)
	}
	if len(factory.requests()) != 0 {
		t.Fatal("an agent was started in a missing folder")
	}
}

// The runtime's own error already names the agent: it is not prefixed again.
func TestStartFailureIsReportedAsTheRuntimeSaidIt(t *testing.T) {
	factory := &fakeFactory{err: errors.New("claude: start claude: boom")}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: factory, Bus: newFakeBus(),
		NewID: (&counter{}).next})
	t.Cleanup(m.Close)
	s := createClaude(t, m)
	if err := m.SendMessage(context.Background(), s.ID, "hi"); err == nil || err.Error() != "claude: start claude: boom" {
		t.Fatalf("err = %v", err)
	}
}

// A session made in a folder that was never there says so, not "no longer".
func TestCreateSessionSaysAFolderDoesNotExist(t *testing.T) {
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(),
		Folders: &folderProbe{}})
	_, err := m.CreateSession(context.Background(), domain.AgentClaude, "/tmp/never")
	if !errors.Is(err, domain.ErrFolderGone) || err.Error() != "Folder /tmp/never doesn't exist" {
		t.Fatalf("err = %v", err)
	}
}

// countingProbe counts how often each folder is looked at.
type countingProbe struct {
	folderProbe
	calls map[string]int
}

func (p *countingProbe) FolderExists(path string) (bool, error) {
	p.mu.Lock()
	p.calls[path]++
	p.mu.Unlock()
	return p.folderProbe.FolderExists(path)
}

// The list marks sessions whose folder is gone, looking at each folder once;
// a removed worktree is already marked as such and its folder isn't looked at.
func TestListSessionsMarksMissingFolders(t *testing.T) {
	repo := newMemRepo()
	probe := &countingProbe{folderProbe: folderProbe{existing: map[string]bool{"/tmp/here": true, "/tmp/gone": true}},
		calls: map[string]int{}}
	m := NewManager(ManagerConfig{Repo: repo, Runtimes: &fakeFactory{}, Bus: newFakeBus(), Folders: probe,
		NewID: (&counter{}).next})
	ctx := context.Background()
	here, _ := m.CreateSession(ctx, domain.AgentClaude, "/tmp/here")
	gone1, _ := m.CreateSession(ctx, domain.AgentClaude, "/tmp/gone")
	gone2, _ := m.CreateSession(ctx, domain.AgentCodex, "/tmp/gone")
	wt := domain.SessionSnapshot{ID: "wt", Agent: domain.AgentClaude, Cwd: "/tmp/wt", Status: domain.StatusDetached,
		Worktree: &domain.Worktree{Repo: "/tmp/here", Path: "/tmp/wt", Branch: "chamber/x", Removed: true}}
	if err := repo.Save(ctx, wt); err != nil {
		t.Fatal(err)
	}
	probe.remove("/tmp/gone")
	probe.mu.Lock()
	probe.calls = map[string]int{}
	probe.mu.Unlock()
	all, err := m.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gone := map[domain.SessionID]bool{}
	for _, s := range all {
		gone[s.ID] = s.FolderGone
	}
	if gone[here.ID] || !gone[gone1.ID] || !gone[gone2.ID] || gone["wt"] {
		t.Fatalf("folderGone = %v", gone)
	}
	if probe.calls["/tmp/gone"] != 1 || probe.calls["/tmp/here"] != 1 || probe.calls["/tmp/wt"] != 0 {
		t.Fatalf("probes = %v", probe.calls)
	}
	one, err := m.GetSession(ctx, gone1.ID)
	if err != nil || !one.FolderGone {
		t.Fatalf("GetSession = %+v, %v", one, err)
	}
	if one, _ := m.GetSession(ctx, here.ID); one.FolderGone {
		t.Fatal("an existing folder was marked gone")
	}
}

// A folder that can't be looked at is not called gone.
func TestListSessionsLeavesUncheckableFoldersUnmarked(t *testing.T) {
	probe := &folderProbe{existing: map[string]bool{"/tmp/x": true}}
	m := NewManager(ManagerConfig{Repo: newMemRepo(), Runtimes: &fakeFactory{}, Bus: newFakeBus(), Folders: probe,
		NewID: (&counter{}).next})
	ctx := context.Background()
	if _, err := m.CreateSession(ctx, domain.AgentClaude, "/tmp/x"); err != nil {
		t.Fatal(err)
	}
	probe.mu.Lock()
	probe.err = errors.New("stat: permission denied")
	probe.mu.Unlock()
	all, err := m.ListSessions(ctx)
	if err != nil || len(all) != 1 || all[0].FolderGone {
		t.Fatalf("list = %+v, %v", all, err)
	}
}
