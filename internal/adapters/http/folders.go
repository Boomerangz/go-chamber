package httpapi

import (
	"net/http"

	"github.com/igorzygin/go-chamber/internal/app"
)

// Folders is the folder-picker use case the HTTP API needs.
type Folders interface {
	List(dir string, hidden bool) (app.FolderListing, error)
}

func (s *server) listFolders(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	listing, err := s.cfg.Folders.List(q.Get("path"), q.Get("hidden") == "1")
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, listing)
}
