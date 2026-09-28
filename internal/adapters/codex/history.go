package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// historyLimit bounds thread/list: app-server reads every listed rollout
// file, about 0.1 s per thread, so listing all of them takes minutes.
// ponytail: newest historyLimit threads only; page through the API if older ones are needed.
const historyLimit = 50

// Sessions lists Codex's recorded threads (thread/list). Subagent threads
// belong to their parent and are left out.
func (f *Factory) Sessions(ctx context.Context) ([]app.ExternalSession, error) {
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return nil, err
	}
	out := []app.ExternalSession{}
	cursor := ""
	for len(out) < historyLimit {
		params := map[string]any{"limit": historyLimit - len(out), "sortKey": "updated_at"}
		if cursor != "" {
			params["cursor"] = cursor
		}
		res, err := srv.client.Call(ctx, "thread/list", params)
		if err != nil {
			return nil, fmt.Errorf("codex: thread/list: %w", err)
		}
		var page struct {
			Data []struct {
				ID             string `json:"id"`
				Cwd            string `json:"cwd"`
				Name           string `json:"name"`
				Preview        string `json:"preview"`
				ParentThreadID string `json:"parentThreadId"`
				UpdatedAt      int64  `json:"updatedAt"`
			} `json:"data"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(res, &page); err != nil {
			return nil, fmt.Errorf("codex: thread/list response: %w", err)
		}
		for _, th := range page.Data {
			if th.ParentThreadID != "" {
				continue
			}
			title := th.Name
			if title == "" {
				title = th.Preview
			}
			out = append(out, app.ExternalSession{
				Agent: domain.AgentCodex, NativeID: th.ID, Cwd: th.Cwd, Title: title,
				UpdatedAt: time.Unix(th.UpdatedAt, 0).UTC(),
			})
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	return out, nil
}

// historyTurns bounds an imported transcript: reading a long thread whole
// (thread/read with turns) takes minutes.
// ponytail: the newest historyTurns turns only; page with the cursor if older ones are needed.
const historyTurns = 50

// Transcript reads a thread's newest turns (thread/turns/list) and maps them
// to items, user messages included.
func (f *Factory) Transcript(ctx context.Context, nativeID string, session domain.SessionID) ([]domain.Item, error) {
	srv, err := f.ensureServer(ctx)
	if err != nil {
		return nil, err
	}
	res, err := srv.client.Call(ctx, "thread/turns/list", map[string]any{
		"threadId": nativeID, "limit": historyTurns, "itemsView": "full",
	})
	if err != nil {
		return nil, fmt.Errorf("%w: codex %s: %w", app.ErrHistoryNotFound, nativeID, err)
	}
	var page struct {
		Data []rpcTurn `json:"data"`
	}
	if err := json.Unmarshal(res, &page); err != nil {
		return nil, fmt.Errorf("codex: thread/turns/list response: %w", err)
	}
	slices.Reverse(page.Data) // newest first on the wire
	m := NewMapper(session)
	m.IncludeUserMessages = true
	var items []domain.Item
	for _, turn := range page.Data {
		m.SetTurn(domain.TurnID(turn.ID))
		for _, it := range turn.Items {
			if item, _, _ := m.apply(it, true); item != nil {
				items = append(items, *item)
			}
		}
	}
	return items, nil
}
