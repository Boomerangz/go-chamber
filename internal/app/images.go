package app

import (
	"context"
	"errors"

	"github.com/igorzygin/go-chamber/internal/domain"
)

var ErrImagesUnsupported = errors.New("agent does not accept images")

// Image is a picture the user attached to a message, stored on disk.
type Image struct {
	ID       string
	Path     string
	MimeType string
}

// ImageSender is implemented by runtimes that take images with a message.
type ImageSender interface {
	SendImages(ctx context.Context, turn domain.TurnID, text string, images []Image) error
}
