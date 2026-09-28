package claude

import (
	"context"
	"encoding/base64"
	"os"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// SendImages starts a turn with text and images, sent inline as base64
// image blocks of the user message.
func (r *Runtime) SendImages(_ context.Context, turn domain.TurnID, text string, images []app.Image) error {
	content := make([]any, 0, len(images)+1)
	for _, img := range images {
		data, err := os.ReadFile(img.Path)
		if err != nil {
			return err
		}
		content = append(content, map[string]any{
			"type":   "image",
			"source": map[string]string{"type": "base64", "media_type": img.MimeType, "data": base64.StdEncoding.EncodeToString(data)},
		})
	}
	content = append(content, map[string]string{"type": "text", "text": text})
	r.mapper.SetTurn(turn)
	return r.sendContent(content)
}
