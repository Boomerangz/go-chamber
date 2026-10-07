package opencode

import (
	"testing"

	"github.com/igorzygin/go-chamber/internal/app/apptest"
)

func TestRuntimeContract(t *testing.T) {
	apptest.RuntimeContract(t, start(t, factory(t, ""), "contract", t.TempDir()))
}
