package app

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type modelSourceFunc func(context.Context) ([]ModelInfo, error)

func (f modelSourceFunc) ListModels(ctx context.Context) ([]ModelInfo, error) { return f(ctx) }

func TestModelCacheRefreshAndStaleFallback(t *testing.T) {
	now := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	calls := 0
	offline := false
	source := modelSourceFunc(func(context.Context) ([]ModelInfo, error) {
		calls++
		if offline {
			return nil, errors.New("offline")
		}
		return []ModelInfo{{ID: "new", Efforts: []string{"high"}}}, nil
	})
	cache := NewModelCache(source, time.Minute, func() time.Time { return now })
	first, err := cache.List(context.Background(), false)
	if err != nil || first.Stale || calls != 1 || !first.UpdatedAt.Equal(now) {
		t.Fatalf("%+v %v calls=%d", first, err, calls)
	}
	first.Models[0].Efforts[0] = "corrupted"
	next, err := cache.List(context.Background(), false)
	if err != nil || calls != 1 || next.Models[0].Efforts[0] != "high" {
		t.Fatal("cache mutated or refetched")
	}
	now = now.Add(time.Minute)
	offline = true
	stale, err := cache.List(context.Background(), false)
	if err == nil || !stale.Stale || len(stale.Models) != 1 || calls != 2 || stale.UpdatedAt.Equal(now) {
		t.Fatalf("%+v %v calls=%d", stale, err, calls)
	}
	_, _ = cache.List(context.Background(), false)
	if calls != 2 {
		t.Fatal("retry storm after refresh failure")
	}
	offline = false
	fresh, err := cache.List(context.Background(), true)
	if err != nil || fresh.Stale || calls != 3 || !fresh.UpdatedAt.Equal(now) {
		t.Fatalf("%+v %v", fresh, err)
	}
}

func TestModelCacheCoalescesConcurrentSessions(t *testing.T) {
	var calls atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	cache := NewModelCache(modelSourceFunc(func(context.Context) ([]ModelInfo, error) {
		calls.Add(1)
		close(started)
		<-release
		return []ModelInfo{{ID: "model"}}, nil
	}), time.Minute, nil)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			list, err := cache.List(context.Background(), false)
			if err != nil || len(list.Models) != 1 {
				t.Errorf("%+v %v", list, err)
			}
		})
	}
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.List(ctx, false); !errors.Is(err, context.Canceled) {
		t.Errorf("cancel error=%v", err)
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("requests=%d", calls.Load())
	}
}

func TestModelCacheReplacesRemovedModelsAndRecoversFromInitialFailure(t *testing.T) {
	now := time.Date(2026, 11, 21, 0, 0, 0, 0, time.UTC)
	calls := 0
	cache := NewModelCache(modelSourceFunc(func(context.Context) ([]ModelInfo, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("offline")
		}
		id := "old"
		if calls > 2 {
			id = "new"
		}
		images := true
		return []ModelInfo{{ID: id, Images: &images}}, nil
	}), 0, func() time.Time { return now })
	empty, err := cache.List(context.Background(), false)
	if err == nil || !empty.Stale || len(empty.Models) != 0 || !empty.UpdatedAt.IsZero() {
		t.Fatalf("%+v %v", empty, err)
	}
	now = now.Add(time.Minute)
	old, err := cache.List(context.Background(), false)
	if err != nil || old.Models[0].ID != "old" {
		t.Fatalf("%+v %v", old, err)
	}
	*old.Models[0].Images = false
	cached, err := cache.List(context.Background(), false)
	if err != nil || !*cached.Models[0].Images {
		t.Fatal("mutated cached capabilities")
	}
	now = now.Add(15 * time.Minute)
	fresh, err := cache.List(context.Background(), false)
	if err != nil || fresh.Stale || len(fresh.Models) != 1 || fresh.Models[0].ID != "new" {
		t.Fatalf("%+v %v", fresh, err)
	}
}
