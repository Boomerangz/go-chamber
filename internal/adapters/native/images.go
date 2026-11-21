package native

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func LoadImages(directory string) func(context.Context, []app.Image) ([]domain.ModelImage, error) {
	return func(ctx context.Context, images []app.Image) ([]domain.ModelImage, error) {
		if len(images) > 10 {
			return nil, errors.New("at most ten images per message")
		}
		root, err := os.OpenRoot(directory)
		if err != nil {
			return nil, err
		}
		defer func() { _ = root.Close() }()
		var result []domain.ModelImage
		total := 0
		for _, im := range images {
			if err = ctx.Err(); err != nil {
				return nil, err
			}
			rel, e := filepath.Rel(directory, im.Path)
			if e != nil || !filepath.IsLocal(rel) {
				return nil, errors.New("image is outside uploads directory")
			}
			file, e := root.Open(rel)
			if e != nil {
				return nil, e
			}
			raw, e := io.ReadAll(io.LimitReader(file, 20<<20+1))
			_ = file.Close()
			if e != nil {
				return nil, e
			}
			total += len(raw)
			if total > 20<<20 {
				return nil, errors.New("images exceed 20 MiB")
			}
			mime := http.DetectContentType(raw)
			switch mime {
			case "image/png", "image/jpeg", "image/gif", "image/webp":
			default:
				return nil, errors.New("unsupported image type")
			}
			result = append(result, domain.ModelImage{URL: "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)})
		}
		return result, nil
	}
}
