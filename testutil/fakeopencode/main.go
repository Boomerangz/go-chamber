// Command fakeopencode implements the OpenCode 2.0.15 HTTP/SSE contract
// without provider calls. Both adapter tests and browser tests launch it.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type object = map[string]any
type session struct {
	ID         string   `json:"id"`
	Directory  string   `json:"directory"`
	ParentID   string   `json:"parentID,omitempty"`
	Title      string   `json:"title"`
	Model      object   `json:"model,omitempty"`
	Messages   []object `json:"messages"`
	Cost       float64  `json:"cost"`
	Generation int      `json:"generation"`
	Status     string   `json:"-"`
	Pending    []object `json:"-"`
	Text       string   `json:"-"`
}
type server struct {
	mu       sync.Mutex
	sessions map[string]*session
	subs     map[chan object]bool
	next     int
	mode     string
	allowed  map[string]bool
	data     string
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("opencode v2.0.15")
		return
	}
	port := 0
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port, _ = strconv.Atoi(os.Args[i+1])
		}
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		panic(err)
	}
	s := &server{sessions: map[string]*session{}, subs: map[chan object]bool{}, mode: os.Getenv("FAKEOPENCODE_MODE"), data: os.Getenv("FAKEOPENCODE_DATA"), allowed: map[string]bool{}}
	s.load()
	fmt.Printf("Server listening on http://%s\n", ln.Addr())
	_ = http.Serve(ln, http.HandlerFunc(s.handle))
}
func (s *server) load() {
	if s.data == "" {
		return
	}
	b, _ := os.ReadFile(filepath.Join(s.data, "sessions.json"))
	_ = json.Unmarshal(b, &s.sessions)
	for _, v := range s.sessions {
		v.Status = "idle"
	}
	s.next = len(s.sessions)
}
func (s *server) save() {
	if s.data == "" {
		return
	}
	_ = os.MkdirAll(s.data, 0o700)
	b, _ := json.Marshal(s.sessions)
	_ = os.WriteFile(filepath.Join(s.data, "sessions.json"), b, 0o600)
}
func write(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(object{"_tag": "Error", "message": message})
}
func (s *server) id(prefix string) string {
	s.next++
	return fmt.Sprintf("%s_%d", prefix, s.next)
}
func (s *server) emit(typ string, data object) {
	ev := object{"id": s.id("evt"), "type": typ, "data": data}
	encoded, _ := json.Marshal(ev)
	var detached object
	_ = json.Unmarshal(encoded, &detached)
	for ch := range s.subs {
		select {
		case ch <- detached:
		default:
		}
	}
}
func (v *session) info() object {
	out := object{"id": v.ID, "title": v.Title, "cost": v.Cost, "tokens": object{"input": 10 * v.Generation, "output": 5 * v.Generation, "reasoning": 0, "cache": object{"read": 0, "write": 0}}, "location": object{"directory": v.Directory}}
	if v.ParentID != "" {
		out["parentID"] = v.ParentID
	}
	return out
}
func (s *server) idle(v *session, outcome string) {
	v.Status = "idle"
	v.Messages = append(v.Messages, object{"id": s.id("msg_idle"), "type": "idle", "outcome": outcome})
	s.emit("session.execution."+outcome, object{"sessionID": v.ID})
	if parent := s.sessions[v.ParentID]; parent != nil && parent.Status == "running" {
		s.idle(parent, outcome)
	}
	s.save()
}
func model(id string) object {
	return object{"id": id, "modelID": id, "providerID": "openrouter", "name": "Test model", "enabled": true, "status": "active", "capabilities": object{"tools": true, "input": []string{"text", "image"}}, "variants": []object{{"id": "high"}, {"id": "low"}}}
}
func (s *server) models() []object {
	if s.mode == "no-provider" {
		return []object{}
	}
	m := model("vendor/model")
	if s.mode == "no-images" {
		m["capabilities"] = object{"tools": true, "input": []string{"text"}}
	}
	off := model("vendor/disabled")
	off["enabled"] = false
	return []object{m, off}
}
func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	user, pw, ok := r.BasicAuth()
	if !ok || user != "opencode" || pw != os.Getenv("OPENCODE_SERVER_PASSWORD") {
		http.Error(w, "auth required", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/api/event" {
		s.events(w, r)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mode == "http-error" {
		fail(w, 500, "fake failure")
		return
	}
	query := r.URL.Query()
	dir := query.Get("location[directory]")
	located := func(data any) { write(w, object{"location": object{"directory": dir}, "data": data}) }
	switch r.URL.Path {
	case "/api/model":
		located(s.models())
		return
	case "/api/model/default":
		if models := s.models(); len(models) > 0 {
			located(models[0])
		} else {
			located(nil)
		}
		return
	case "/api/command":
		located([]object{{"name": "echo", "description": "Echo command"}})
		return
	case "/api/session/active":
		out := object{}
		for id, v := range s.sessions {
			if v.Status == "running" {
				out[id] = object{"type": "running"}
			}
		}
		write(w, object{"data": out})
		return
	case "/api/permission/request", "/api/form":
		if dir == "" {
			fail(w, 400, "location required")
			return
		}
		kind := map[string]string{"/api/permission/request": "permission", "/api/form": "form"}[r.URL.Path]
		out := []object{}
		for _, v := range s.sessions {
			for _, p := range v.Pending {
				if v.Directory == dir && p["kind"] == kind {
					out = append(out, p["data"].(object))
				}
			}
		}
		located(out)
		return
	case "/api/session":
		if r.Method == http.MethodGet {
			out := []object{}
			for _, v := range s.sessions {
				if parent := query.Get("parentID"); parent == "" || v.ParentID == parent {
					out = append(out, v.info())
				}
			}
			write(w, object{"data": out, "cursor": object{}})
			return
		}
		var body struct {
			Location struct {
				Directory string `json:"directory"`
			} `json:"location"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		v := &session{ID: s.id("ses"), Directory: body.Location.Directory, Title: "OpenCode session", Status: "idle", Messages: []object{}}
		if s.mode == "history" {
			for i := 0; i < 1800; i++ {
				v.Messages = append(v.Messages, object{"id": fmt.Sprintf("msg_history_%d", i), "type": "assistant", "content": []object{{"type": "text", "text": "past reply"}}})
			}
		}
		s.sessions[v.ID] = v
		s.save()
		write(w, object{"data": v.info()})
		return
	}
	bits := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/session/"), "/")
	v := s.sessions[bits[0]]
	if !strings.HasPrefix(r.URL.Path, "/api/session/") || v == nil {
		fail(w, 404, "session not found")
		return
	}
	if len(bits) == 1 {
		write(w, object{"data": v.info()})
		return
	}
	switch bits[1] {
	case "message":
		s.messages(w, v, query)
	case "fork":
		child := &session{ID: s.id("ses"), Directory: v.Directory, Title: "Fork", Status: "idle", Messages: append([]object(nil), v.Messages...)}
		s.sessions[child.ID] = child
		s.save()
		write(w, object{"data": child.info()})
	case "model":
		var body struct {
			Model object `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		v.Model = body.Model
		s.emit("session.model.selected", object{"sessionID": v.ID, "model": body.Model})
		w.WriteHeader(204)
	case "interrupt":
		v.Generation++
		v.Pending = nil
		if v.Status == "running" {
			s.idle(v, "interrupted")
		}
		write(w, object{"interrupted": true})
	case "prompt", "command":
		var body struct {
			Text  string   `json:"text"`
			Name  string   `json:"name"`
			Files []object `json:"files"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		text := body.Text
		if bits[1] == "command" {
			text = "command: " + body.Name + " " + body.Text
		}
		id := s.id("msg_user")
		v.Messages = append(v.Messages, object{"id": id, "type": "user", "text": text})
		if v.Status == "running" {
			v.Text += " " + text
		} else {
			s.start(v, text, id)
		}
		if bits[1] == "command" {
			w.WriteHeader(204)
			return
		}
		write(w, object{"data": object{"id": id, "sessionID": v.ID, "type": "user", "payload": object{"text": text}, "delivery": "steer"}})
	case "permission", "form":
		s.reply(w, r, v, bits)
	default:
		fail(w, 404, "no route")
	}
}

// messages pages like the real server: the next cursor is always set, the
// limit is capped and a cursor cannot be combined with an order.
func (s *server) messages(w http.ResponseWriter, v *session, query map[string][]string) {
	get := func(k string) string {
		if len(query[k]) > 0 {
			return query[k][0]
		}
		return ""
	}
	if get("cursor") != "" && get("order") != "" {
		fail(w, 400, "Do not combine cursor with order")
		return
	}
	limit, _ := strconv.Atoi(get("limit"))
	if limit > 200 {
		fail(w, 400, "Expected a value less than or equal to 200")
		return
	}
	if limit <= 0 {
		limit = 50
	}
	start, _ := strconv.Atoi(strings.TrimPrefix(get("cursor"), "at-"))
	end := min(start+limit, len(v.Messages))
	start = min(start, end)
	write(w, object{"data": v.Messages[start:end], "cursor": object{"next": fmt.Sprintf("at-%d", end)}})
}
func (s *server) start(v *session, text, user string) {
	v.Text = text
	v.Generation++
	v.Status = "running"
	s.emit("session.execution.started", object{"sessionID": v.ID})
	switch {
	case s.mode == "crash":
		go func() { time.Sleep(20 * time.Millisecond); os.Exit(2) }()
	case text == "child":
		child := &session{ID: s.id("ses_child"), ParentID: v.ID, Directory: v.Directory, Title: "Explore child", Status: "running", Messages: []object{}}
		s.sessions[child.ID] = child
		s.emit("session.created", object{"sessionID": child.ID, "parentID": v.ID, "title": child.Title})
	case s.mode == "permission" || text == "permission":
		data := object{"id": "per_" + user, "sessionID": v.ID, "action": "shell", "resources": []string{"echo hi"}, "save": []string{"echo *"}, "source": object{"type": "tool", "id": "shell_1"}}
		if s.allowed[v.Directory] {
			go s.finish(v, "approved")
			return
		}
		v.Pending = []object{{"kind": "permission", "data": data}}
		s.emit("permission.asked", data)
	case s.mode == "question" || text == "question":
		data := object{"id": "frm_" + user, "sessionID": v.ID, "title": "Questions", "metadata": object{"kind": "question"}, "fields": []object{{"key": "q0", "title": "Choice", "description": "Pick?", "type": "multiselect", "options": []object{{"value": "alpha", "label": "Alpha", "description": "First"}, {"value": "beta", "label": "Beta", "description": "Second"}}}}}
		v.Pending = []object{{"kind": "form", "data": data}}
		s.emit("form.created", object{"form": data})
	default:
		if text == "model" && v.Model != nil {
			v.Text = fmt.Sprint(v.Model["providerID"], "/", v.Model["id"], " ", v.Model["variant"])
		}
		go s.run(v, v.Generation)
	}
}
func (s *server) reply(w http.ResponseWriter, r *http.Request, v *session, bits []string) {
	if len(bits) < 3 || len(v.Pending) == 0 || v.Pending[0]["data"].(object)["id"] != bits[2] {
		fail(w, 404, "request not found")
		return
	}
	var body struct {
		Decision string `json:"decision"`
		Answer   object `json:"answer"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	v.Pending = nil
	word := "approved"
	switch {
	case bits[1] == "permission":
		if body.Decision == "always" {
			s.allowed[v.Directory] = true
		}
		if body.Decision == "reject" {
			word = "denied"
		}
		s.emit("permission.replied", object{"sessionID": v.ID, "requestID": bits[2], "reply": body.Decision})
	case r.Method == http.MethodDelete:
		word = "denied"
		s.emit("form.cancelled", object{"sessionID": v.ID, "id": bits[2]})
	default:
		answer, _ := json.Marshal(body.Answer)
		word += " " + string(answer)
		s.emit("form.replied", object{"sessionID": v.ID, "id": bits[2], "answer": body.Answer})
	}
	go s.finish(v, word)
	w.WriteHeader(204)
}
func (s *server) events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	f := w.(http.Flusher)
	ch := make(chan object, 256)
	s.mu.Lock()
	s.subs[ch] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.subs, ch); s.mu.Unlock() }()
	_, _ = fmt.Fprint(w, "data: {\"type\":\"server.connected\",\"data\":{}}\n\n: heartbeat\n\n")
	f.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			b, _ := json.Marshal(e)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
			f.Flush()
			if s.mode == "disconnect" && e["type"] == "session.text.delta" {
				return
			}
		}
	}
}
func (s *server) run(v *session, gen int) {
	time.Sleep(30 * time.Millisecond)
	s.mu.Lock()
	if gen != v.Generation {
		s.mu.Unlock()
		return
	}
	id := s.id("msg_assistant")
	s.emit("session.step.started", object{"sessionID": v.ID, "assistantMessageID": id})
	s.emit("session.text.started", object{"sessionID": v.ID, "assistantMessageID": id, "ordinal": 0})
	s.emit("session.text.delta", object{"sessionID": v.ID, "assistantMessageID": id, "ordinal": 0, "delta": "echo: "})
	s.mu.Unlock()
	if s.mode == "slow" {
		time.Sleep(150 * time.Millisecond)
	}
	s.mu.Lock()
	text := v.Text
	s.mu.Unlock()
	s.answer(v, gen, id, "echo: "+text)
}
func (s *server) finish(v *session, text string) {
	s.mu.Lock()
	gen := v.Generation
	id := s.id("msg_result")
	s.mu.Unlock()
	s.answer(v, gen, id, text)
}
func (s *server) answer(v *session, gen int, id, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gen != v.Generation {
		return
	}
	sid := v.ID
	at := func(data object) object { data["sessionID"], data["assistantMessageID"] = sid, id; return data }
	s.emit("session.text.ended", at(object{"ordinal": 0, "text": text}))
	content := []object{{"type": "text", "text": text}}
	if v.Text == "tools" {
		tools := []object{
			{"id": "shell_" + id, "name": "shell", "input": object{"command": "echo hi"}, "metadata": object{"exit": 0}},
			{"id": "write_" + id, "name": "write", "input": object{"path": "test.txt"}, "metadata": object{"files": []object{{"file": "test.txt", "patch": "+hello"}}}},
		}
		for _, t := range tools {
			s.emit("session.tool.input.started", at(object{"id": t["id"], "name": t["name"]}))
			s.emit("session.tool.called", at(object{"id": t["id"], "input": t["input"]}))
			output := []object{{"type": "text", "text": "done"}}
			s.emit("session.tool.success", at(object{"id": t["id"], "content": output, "metadata": t["metadata"]}))
			content = append(content, object{"type": "tool", "id": t["id"], "name": t["name"], "state": object{"status": "completed", "input": t["input"], "content": output, "metadata": t["metadata"]}})
		}
		s.emit("session.reasoning.started", at(object{"ordinal": 0}))
		s.emit("session.reasoning.ended", at(object{"ordinal": 0, "text": "Thinking"}))
		content = append(content, object{"type": "reasoning", "text": "Thinking"})
	}
	v.Cost += 0.01
	usage := object{"input": 10 * v.Generation, "output": 5 * v.Generation, "reasoning": 0, "cache": object{"read": 0, "write": 0}}
	s.emit("session.step.ended", at(object{"finish": "stop", "cost": 0.01, "tokens": object{"input": 10, "output": 5}}))
	s.emit("session.usage.updated", object{"sessionID": sid, "cost": v.Cost, "tokens": usage})
	v.Messages = append(v.Messages, object{"id": id, "type": "assistant", "content": content, "cost": 0.01})
	s.idle(v, "succeeded")
}
