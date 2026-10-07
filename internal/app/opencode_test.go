package app

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type folderCatalog struct{ cwd string }

func (f *folderCatalog) Models(context.Context, domain.AgentKind) ([]ModelInfo, error) {
	return []ModelInfo{{ID: "global"}}, nil
}
func (f *folderCatalog) ModelsInFolder(_ context.Context, _ domain.AgentKind, cwd string) ([]ModelInfo, error) {
	f.cwd = cwd
	return []ModelInfo{{ID: "project"}}, nil
}

func TestOpenCodeCapabilitiesAndFolderModels(t *testing.T) {
	f := &folderCatalog{}
	m := NewManager(ManagerConfig{Models: f})
	clis := m.CLIs()
	if len(clis) != 3 {
		t.Fatalf("agents = %+v", clis)
	}
	if clis[2].Name != "OpenCode" || !clis[2].Capabilities.Steer || clis[2].Capabilities.Login || clis[2].Capabilities.PermissionModes {
		t.Fatalf("capabilities = %+v", clis[2])
	}
	models, err := m.ModelsInFolder(context.Background(), "opencode", "/project")
	if err != nil || len(models) != 1 || models[0].ID != "project" || f.cwd != "/project" {
		t.Fatalf("models=%+v cwd=%q err=%v", models, f.cwd, err)
	}
	legacy := NewManager(ManagerConfig{Models: &fakeCatalog{}})
	models, err = legacy.ModelsInFolder(context.Background(), domain.AgentClaude, "/project")
	if err != nil || len(models) != 1 || models[0].ID != "opus" {
		t.Fatalf("legacy = %+v %v", models, err)
	}
}
