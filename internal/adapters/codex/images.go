package codex

import (
	"context"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// SendImages starts a turn with images, passed as localImage paths the
// app-server reads itself, followed by the text.
func (r *Runtime) SendImages(ctx context.Context, _ domain.TurnID, text string, images []app.Image) error {
	input := make([]map[string]any, 0, len(images)+1)
	for _, img := range images {
		input = append(input, map[string]any{"type": "localImage", "path": img.Path})
	}
	input = append(input, map[string]any{"type": "text", "text": text})
	return r.startTurn(ctx, input)
}
