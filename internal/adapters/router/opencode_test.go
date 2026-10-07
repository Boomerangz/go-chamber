package router

import (
	"context"
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

type nativeFactory struct {
	catalogFactory
	cwd string
	stubAccounts
}

func (f *nativeFactory) ModelsInFolder(_ context.Context, _ domain.AgentKind, cwd string) ([]app.ModelInfo, error) {
	f.cwd = cwd
	return f.models, nil
}
func TestOpenCodeDispatchAndFolderCatalog(t *testing.T) {
	ctx := context.Background()
	f := &nativeFactory{catalogFactory: catalogFactory{stubFactory: stubFactory{name: "oc"}, models: []app.ModelInfo{{ID: "provider/model"}}}, stubAccounts: stubAccounts{info: app.AccountInfo{AuthMode: "config"}}}
	r := &Router{OpenCode: f}
	rt, err := r.Start(ctx, app.StartRequest{Agent: domain.AgentOpenCode})
	if err != nil || rt.NativeID() != "oc" {
		t.Fatalf("%v %v", rt, err)
	}
	models, err := r.ModelsInFolder(ctx, domain.AgentOpenCode, "/folder")
	if err != nil || len(models) != 1 || f.cwd != "/folder" {
		t.Fatal(models, err, f.cwd)
	}
	info, err := r.Account(ctx, domain.AgentOpenCode)
	if err != nil || info.AuthMode != "config" {
		t.Fatal(info, err)
	}
	if _, err := (&Router{}).Start(ctx, app.StartRequest{Agent: domain.AgentOpenCode}); err == nil {
		t.Fatal("missing runtime accepted")
	}
}
