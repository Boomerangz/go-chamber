package httpapi

import (
	"context"
	"net/http"
	"strconv"

	"github.com/igorzygin/go-chamber/internal/app"
)

// MessageSearch finds sessions by message text.
type MessageSearch interface {
	Search(ctx context.Context, query string, limit int) ([]app.SearchHit, error)
}

const defaultSearchLimit = 30

func (s *server) searchMessages(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, err := strconv.Atoi(q.Get("limit"))
	if err != nil || limit <= 0 || limit > 200 {
		limit = defaultSearchLimit
	}
	hits, err := s.cfg.Search.Search(r.Context(), q.Get("q"), limit)
	if err != nil {
		s.fail(w, err)
		return
	}
	if hits == nil {
		hits = []app.SearchHit{}
	}
	writeJSON(w, http.StatusOK, hits)
}
