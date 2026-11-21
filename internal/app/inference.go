package app

import (
	"context"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// ModelClient performs one inference request. A failed or interrupted request
// returns no executable tool calls; deltas delivered before failure are display-only.
type ModelClient interface {
	Stream(context.Context, domain.ModelRequest, func(domain.ModelDelta) error) (domain.ModelResult, error)
}
