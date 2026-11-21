package app

import (
	"context"
	"sync"
	"time"
)

// InferenceModelCatalog belongs to one authenticated provider profile. Recreate
// its cache when changing endpoint or account; never share it across accounts.
type InferenceModelCatalog interface {
	ListModels(context.Context) ([]ModelInfo, error)
}

type ModelList struct {
	Models    []ModelInfo `json:"models"`
	UpdatedAt time.Time   `json:"updatedAt"`
	Stale     bool        `json:"stale"`
}

// ModelCache refreshes on demand: session creation/model picker can call List.
// It has no background goroutine and coalesces simultaneous refreshes.
type ModelCache struct {
	source      InferenceModelCatalog
	ttl         time.Duration
	now         func() time.Time
	mu          sync.Mutex
	pending     chan struct{}
	snapshot    ModelList
	nextAttempt time.Time
	lastError   error
}

func NewModelCache(source InferenceModelCatalog, ttl time.Duration, now func() time.Time) *ModelCache {
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	if now == nil {
		now = time.Now
	}
	return &ModelCache{source: source, ttl: ttl, now: now}
}

// List returns the last successful snapshot AND an error if refresh failed.
// Callers may display stale models with a warning, never as a fresh catalog.
// force bypasses TTL/backoff (for a user-requested refresh).
func (c *ModelCache) List(ctx context.Context, force bool) (ModelList, error) {
	if err := ctx.Err(); err != nil {
		return ModelList{}, err
	}
	c.mu.Lock()
	if pending := c.pending; pending != nil {
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return ModelList{}, ctx.Err()
		case <-pending:
			return c.List(ctx, false)
		}
	}
	if !force && c.now().Before(c.nextAttempt) {
		snapshot, err := cloneModelList(c.snapshot), c.lastError
		c.mu.Unlock()
		return snapshot, err
	}
	c.pending = make(chan struct{})
	c.mu.Unlock()
	models, err := c.source.ListModels(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil {
		c.snapshot = cloneModelList(ModelList{Models: models, UpdatedAt: c.now()})
		c.nextAttempt = c.now().Add(c.ttl)
	} else {
		c.snapshot.Stale = true
		if ctx.Err() == nil {
			c.nextAttempt = c.now().Add(time.Minute)
		}
	}
	c.lastError = err
	close(c.pending)
	c.pending = nil
	return cloneModelList(c.snapshot), err
}

func cloneModelList(in ModelList) ModelList {
	out := in
	out.Models = append([]ModelInfo{}, in.Models...)
	for i := range out.Models {
		out.Models[i].Efforts = append([]string(nil), in.Models[i].Efforts...)
		if in.Models[i].Images != nil {
			v := *in.Models[i].Images
			out.Models[i].Images = &v
		}
	}
	return out
}
