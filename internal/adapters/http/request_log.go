package httpapi

import (
	"bytes"
	"cmp"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// requestLog writes one line per MCP and OAuth request, so a client that
// fails to connect leaves a trace of what it asked and what it was told.
type requestLog struct {
	out  io.Writer
	next http.Handler
}

func logged(path string) bool {
	return path == "/api/mcp" || strings.HasPrefix(path, "/oauth/") || strings.HasPrefix(path, "/.well-known/")
}

func (l *requestLog) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !logged(r.URL.Path) {
		l.next.ServeHTTP(w, r)
		return
	}
	var rpc string
	if r.URL.Path == "/api/mcp" && r.Body != nil {
		head, _ := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		r.Body = struct {
			io.Reader
			io.Closer
		}{io.MultiReader(bytes.NewReader(head), r.Body), r.Body}
		rpc = rpcMethods(head)
	}
	rec := &recorder{ResponseWriter: w, status: http.StatusOK}
	start := time.Now()
	l.next.ServeHTTP(rec, r)
	bearer := "no"
	if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		bearer = "yes"
	}
	line := fmt.Sprintf("http: %s %s %d %s rpc=%s protocol=%s bearer=%s ua=%q",
		r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond),
		cmp.Or(rpc, "-"), cmp.Or(r.Header.Get("Mcp-Protocol-Version"), "-"), bearer, r.Header.Get("User-Agent"))
	if rec.status >= 400 || bytes.Contains(rec.head, []byte(`"error"`)) {
		line += fmt.Sprintf(" reply=%q", strings.TrimSpace(string(rec.head)))
	}
	_, _ = fmt.Fprintln(l.out, line)
}

// rpcMethods names the JSON-RPC methods in a message or a batch.
func rpcMethods(body []byte) string {
	type msg struct {
		Method string `json:"method"`
	}
	var one msg
	if json.Unmarshal(body, &one) == nil {
		return one.Method
	}
	var batch []msg
	if json.Unmarshal(body, &batch) != nil {
		return ""
	}
	names := make([]string, 0, len(batch))
	for _, m := range batch {
		names = append(names, m.Method)
	}
	return strings.Join(names, ",")
}

// recorder keeps the status and the start of the reply; Unwrap lets the
// SDK still flush its event stream through http.ResponseController.
type recorder struct {
	http.ResponseWriter
	status int
	head   []byte
	wrote  bool
}

func (r *recorder) WriteHeader(code int) {
	if !r.wrote {
		r.status, r.wrote = code, true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	r.wrote = true
	if n := 300 - len(r.head); n > 0 {
		r.head = append(r.head, b[:min(n, len(b))]...)
	}
	return r.ResponseWriter.Write(b)
}

func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }
