package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
)

const maxImageBytes = 10 << 20

// imageTypes are the pictures agents take, by sniffed type.
var imageTypes = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}

// imageName is the name an upload is stored and served under.
var imageName = regexp.MustCompile(`^[0-9a-f]{32}\.(png|jpg|gif|webp)$`)

var errUnknownImage = errors.New("unknown image")

func (s *server) imageRoutes() {
	if s.cfg.ImagesDir == "" || s.cfg.Sessions == nil {
		return
	}
	s.mux.HandleFunc("POST /api/sessions/{id}/images", s.uploadImage)
	s.mux.HandleFunc("GET /api/sessions/{id}/images/{image}", s.serveImage)
}

// uploadImage stores the request body, a png/jpeg/gif/webp of at most
// maxImageBytes, under the session's image folder. The type is sniffed from
// the bytes, not taken from the client.
func (s *server) uploadImage(w http.ResponseWriter, r *http.Request) {
	id := sessionID(r)
	if _, err := s.cfg.Sessions.GetSession(r.Context(), id); err != nil {
		s.fail(w, err)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImageBytes))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, errorBody{Error: "image is larger than 10 MB"})
		return
	}
	mime := http.DetectContentType(data)
	ext, ok := imageTypes[mime]
	if !ok {
		writeJSON(w, http.StatusUnsupportedMediaType, errorBody{Error: "only png, jpeg, gif and webp images are accepted"})
		return
	}
	dir := filepath.Join(s.cfg.ImagesDir, string(id))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		s.fail(w, err)
		return
	}
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	name := hex.EncodeToString(buf) + ext
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": name, "mimeType": mime})
}

func (s *server) serveImage(w http.ResponseWriter, r *http.Request) {
	images, err := s.resolveImages(r, []string{r.PathValue("image")})
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", images[0].MimeType)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, images[0].Path)
}

// resolveImages maps uploaded image ids of the request's session to files.
func (s *server) resolveImages(r *http.Request, ids []string) ([]app.Image, error) {
	id := sessionID(r)
	if _, err := s.cfg.Sessions.GetSession(r.Context(), id); err != nil {
		return nil, err
	}
	out := make([]app.Image, 0, len(ids))
	for _, name := range ids {
		if !imageName.MatchString(name) {
			return nil, errUnknownImage
		}
		path, err := filepath.Abs(filepath.Join(s.cfg.ImagesDir, string(id), name))
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(path); err != nil {
			return nil, errUnknownImage
		}
		mime := "image/" + strings.TrimPrefix(filepath.Ext(name), ".")
		if mime == "image/jpg" {
			mime = "image/jpeg"
		}
		out = append(out, app.Image{ID: name, Path: path, MimeType: mime})
	}
	return out, nil
}
