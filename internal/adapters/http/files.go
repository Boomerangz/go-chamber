package httpapi

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

// SessionFiles resolves a file an agent mentioned, inside its session folder.
type SessionFiles interface {
	Resolve(ctx context.Context, id domain.SessionID, path string) (string, error)
}

// inlineTypes are shown in the browser; anything else downloads. Text of
// any kind goes out as text/plain so HTML or SVG never runs on this origin.
var inlineTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
}

func (s *server) fileRoutes() {
	if s.cfg.Files == nil {
		return
	}
	s.mux.HandleFunc("GET /api/sessions/{id}/file", s.sessionFile)
}

func (s *server) sessionFile(w http.ResponseWriter, r *http.Request) {
	real, err := s.cfg.Files.Resolve(r.Context(), sessionID(r), r.URL.Query().Get("path"))
	switch {
	case errors.Is(err, app.ErrFileOutsideSession):
		writeJSON(w, http.StatusForbidden, errorBody{err.Error()})
		return
	case errors.Is(err, app.ErrFileNotFound):
		writeJSON(w, http.StatusNotFound, errorBody{err.Error()})
		return
	case err != nil:
		s.fail(w, err)
		return
	}
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'")
	name := filepath.Base(real)
	ext := strings.ToLower(filepath.Ext(name))
	switch {
	case r.URL.Query().Get("download") != "":
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	case inlineTypes[ext] != "":
		h.Set("Content-Type", inlineTypes[ext])
	case textFile(ext):
		h.Set("Content-Type", "text/plain; charset=utf-8")
	default:
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	}
	http.ServeFile(w, r, real)
}

var textExts = map[string]bool{
	".md": true, ".markdown": true, ".txt": true, ".log": true, ".csv": true, ".json": true, ".yaml": true, ".yml": true,
	".toml": true, ".ini": true, ".xml": true, ".sql": true, ".diff": true, ".patch": true,
	".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".py": true, ".php": true,
	".rs": true, ".java": true, ".kt": true, ".swift": true, ".c": true, ".h": true, ".cpp": true, ".rb": true,
	".sh": true, ".bash": true, ".zsh": true, ".lua": true, ".proto": true, ".tl": true, ".css": true, ".mod": true,
}

func textFile(ext string) bool { return textExts[ext] }
