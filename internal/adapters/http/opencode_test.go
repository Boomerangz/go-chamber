package httpapi

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type folderSessions struct {
	fakeSessions
	cwd string
}

func (f *folderSessions) ModelsInFolder(_ context.Context, _ domain.AgentKind, cwd string) ([]app.ModelInfo, error) {
	f.cwd = cwd
	return []app.ModelInfo{{ID: "provider/model"}}, nil
}
func TestContextualModels(t *testing.T) {
	f := &folderSessions{}
	s := &server{cfg: Config{Sessions: f}}
	r := httptest.NewRequest("GET", "/api/agents/opencode/models?cwd=%2Fproject", nil)
	r.SetPathValue("agent", "opencode")
	w := httptest.NewRecorder()
	s.listModels(w, r)
	if w.Code != 200 || f.cwd != "/project" {
		t.Fatal(w.Code, f.cwd, w.Body.String())
	}
}
