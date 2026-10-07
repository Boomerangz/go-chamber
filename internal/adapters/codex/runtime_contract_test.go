package codex

import (
	"testing"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/app/apptest"
)

func TestRuntimeContract(t *testing.T) {
	apptest.RuntimeContract(t, startCodex(t, app.StartRequest{SessionID: "contract", Cwd: t.TempDir()}))
}
