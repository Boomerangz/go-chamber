package httpapi

import (
	"net/http"
	"strconv"

	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func (s *server) terminalHistoryRoutes() {
	service, ok := s.cfg.Terminals.(interface {
		History(domain.TerminalID, uint64, int, string) (app.TerminalHistoryPage, error)
	})
	if !ok {
		return
	}
	s.mux.HandleFunc("GET /api/terminals/{id}/history", func(w http.ResponseWriter, r *http.Request) {
		before, err := strconv.ParseUint(r.URL.Query().Get("before"), 10, 64)
		if r.URL.Query().Has("before") && err != nil {
			http.Error(w, "invalid history cursor", 400)
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		query := r.URL.Query().Get("q")
		if len(query) > 1024 {
			http.Error(w, "query is too long", 400)
			return
		}
		page, err := service.History(domain.TerminalID(r.PathValue("id")), before, limit, query)
		if err != nil {
			s.fail(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, page)
	})
}
