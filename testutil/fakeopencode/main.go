// Command fakeopencode implements the OpenCode 1.18.34 HTTP/SSE contract
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
	Messages   []object `json:"messages"`
	Status     string   `json:"-"`
	Pending    []object `json:"-"`
	Text       string   `json:"-"`
	Generation int      `json:"generation"`
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
		fmt.Println("1.18.34")
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
	s := &server{sessions: map[string]*session{}, subs: map[chan object]bool{}, mode: os.Getenv("FAKEOPENCODE_MODE"), data: os.Getenv("FAKEOPENCODE_DATA")}
	s.allowed = map[string]bool{}
	s.load()
	fmt.Printf("opencode server listening on http://%s\n", ln.Addr())
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
func (s *server) emit(v *session, typ string, props object) {
	s.next++
	ev := object{"directory": v.Directory, "payload": object{"id": fmt.Sprintf("evt_%d", s.next), "type": typ, "properties": props}}
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
func (s *server) status(v *session, status string) {
	v.Status = status
	s.emit(v, "session.status", object{"sessionID": v.ID, "status": object{"type": status}})
}
func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	user, pw, ok := r.BasicAuth()
	if !ok || user != "opencode" || pw != os.Getenv("OPENCODE_SERVER_PASSWORD") {
		http.Error(w, "auth required", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/global/health" {
		write(w, object{"healthy": true, "version": "1.18.34"})
		return
	}
	if r.URL.Path == "/global/event" {
		s.events(w, r)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.mode == "http-error" {
		http.Error(w, `{"message":"fake failure"}`, 500)
		return
	}
	dir := r.URL.Query().Get("directory")
	switch r.URL.Path {
	case "/api/permission/request", "/api/question/request":
		out := []object{}
		kind := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/"), "/request")
		for _, v := range s.sessions {
			if v.Directory == dir {
				for _, p := range v.Pending {
					if p["kind"] == kind && p["v2"] == true {
						out = append(out, p["properties"].(object))
					}
				}
			}
		}
		write(w, object{"data": out})
		return
	case "/provider":
		connected := []string{"openrouter"}
		if s.mode == "no-provider" {
			connected = []string{}
		}
		write(w, object{"connected": connected, "default": object{"openrouter": "vendor/model"}, "all": []object{{"id": "openrouter", "name": "OpenRouter", "models": object{"vendor/model": object{"id": "vendor/model", "name": "Test model", "capabilities": object{"input": object{"image": s.mode != "no-images"}}, "variants": object{"high": object{}, "low": object{}}}}}}})
		return
	case "/config":
		write(w, object{"model": "openrouter/vendor/model"})
		return
	case "/command":
		write(w, []object{{"name": "echo", "description": "Echo command"}})
		return
	case "/session/status":
		out := object{}
		for id, v := range s.sessions {
			if v.Directory == dir && v.Status != "idle" {
				out[id] = object{"type": v.Status}
			}
		}
		write(w, out)
		return
	case "/permission", "/question":
		out := []object{}
		for _, v := range s.sessions {
			if v.Directory == dir {
				for _, p := range v.Pending {
					if p["kind"] == strings.TrimPrefix(r.URL.Path, "/") && p["v2"] != true {
						out = append(out, p["properties"].(object))
					}
				}
			}
		}
		write(w, out)
		return
	case "/session":
		if r.Method == "GET" {
			out := []*session{}
			for _, v := range s.sessions {
				if v.Directory == dir {
					out = append(out, v)
				}
			}
			write(w, out)
			return
		}
		s.next++
		v := &session{ID: fmt.Sprintf("ses_%d", s.next), Directory: dir, Title: "OpenCode session", Status: "idle", Messages: []object{}}
		if s.mode == "history" {
			for i := 0; i < 1800; i++ {
				id := fmt.Sprintf("msg_history_%d", i)
				v.Messages = append(v.Messages, object{"info": object{"id": id, "sessionID": v.ID, "role": "assistant"}, "parts": []object{{"id": "prt_" + id, "sessionID": v.ID, "messageID": id, "type": "text", "text": "past reply"}}})
			}
		}
		s.sessions[v.ID] = v
		s.save()
		write(w, v)
		return
	}
	bits := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(bits) < 2 {
		http.NotFound(w, r)
		return
	}
	if len(bits) == 6 && bits[0] == "api" && bits[1] == "session" {
		bits = []string{bits[3], bits[4], bits[5]}
	}
	if bits[0] == "permission" || bits[0] == "question" {
		for _, v := range s.sessions {
			if v.Directory != dir {
				continue
			}
			for _, p := range v.Pending {
				props := p["properties"].(object)
				if props["id"] != bits[1] {
					continue
				}
				var body object
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["reply"] == "always" {
					s.allowed[dir] = true
				}
				allow := body["reply"] != "reject" && bits[len(bits)-1] != "reject"
				v.Pending = nil
				word := "approved"
				if !allow {
					word = "denied"
				}
				eventType := bits[0] + ".replied"
				if p["v2"] == true {
					eventType = bits[0] + ".v2.replied"
				}
				s.emit(v, eventType, object{"sessionID": v.ID, "requestID": bits[1]})
				go s.finish(v, word)
				write(w, true)
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	v := s.sessions[bits[1]]
	if v == nil || v.Directory != dir {
		http.Error(w, "session not in this directory", 404)
		return
	}
	if len(bits) == 2 {
		write(w, v)
		return
	}
	switch bits[2] {
	case "message":
		write(w, v.Messages)
	case "children":
		out := []*session{}
		for _, child := range s.sessions {
			if child.ParentID == v.ID {
				out = append(out, child)
			}
		}
		write(w, out)
	case "fork":
		s.next++
		child := &session{ID: fmt.Sprintf("ses_%d", s.next), Directory: dir, Title: "Fork", Status: "idle", Messages: append([]object(nil), v.Messages...)}
		s.sessions[child.ID] = child
		s.save()
		write(w, child)
	case "abort":
		v.Generation++
		v.Pending = nil
		s.status(v, "idle")
		if parent := s.sessions[v.ParentID]; parent != nil {
			s.status(parent, "idle")
		}
		write(w, true)
	case "prompt_async", "command":
		var body object
		_ = json.NewDecoder(r.Body).Decode(&body)
		text := ""
		if parts, ok := body["parts"].([]any); ok {
			for _, raw := range parts {
				p := raw.(map[string]any)
				if p["type"] == "text" {
					text += p["text"].(string)
				}
			}
		}
		if bits[2] == "command" {
			if _, exists := body["model"]; exists {
				if _, ok := body["model"].(string); !ok {
					http.Error(w, "model must be a string", 400)
					return
				}
			}
			text = "command: " + fmt.Sprint(body["command"]) + " " + fmt.Sprint(body["arguments"])
		}
		if text == "model" {
			model, _ := body["model"].(map[string]any)
			text = fmt.Sprint(model["providerID"]) + "/" + fmt.Sprint(model["modelID"]) + " " + fmt.Sprint(body["variant"])
		}
		s.next++
		uid := fmt.Sprintf("msg_user_%d", s.next)
		user := object{"id": uid, "sessionID": v.ID, "role": "user", "time": object{"created": 1}}
		v.Messages = append(v.Messages, object{"info": user, "parts": []object{{"id": "prt_" + uid, "sessionID": v.ID, "messageID": uid, "type": "text", "text": text}}})
		s.emit(v, "message.updated", object{"info": user})
		s.emit(v, "message.part.updated", object{"part": object{"id": "prt_" + uid, "sessionID": v.ID, "messageID": uid, "type": "text", "text": text}})
		if v.Status == "busy" {
			v.Text += " " + text
			w.WriteHeader(204)
			return
		}
		v.Text = text
		v.Generation++
		gen := v.Generation
		s.status(v, "busy")
		if s.mode == "crash" {
			go func() { time.Sleep(20 * time.Millisecond); os.Exit(2) }()
			w.WriteHeader(204)
			return
		}
		if text == "child" {
			s.next++
			child := &session{ID: fmt.Sprintf("ses_child_%d", s.next), ParentID: v.ID, Directory: v.Directory, Title: "Explore child", Status: "busy", Messages: []object{}}
			s.sessions[child.ID] = child
			s.emit(v, "session.created", object{"info": child})
			w.WriteHeader(204)
			return
		}
		if s.mode == "permission" || s.mode == "question" || strings.HasPrefix(s.mode, "v2-") || text == "permission" || text == "question" {
			v2 := strings.HasPrefix(s.mode, "v2-")
			kind := strings.TrimPrefix(s.mode, "v2-")
			if text == "permission" || text == "question" {
				kind = text
			}
			props := object{"id": "req_" + uid, "sessionID": v.ID, "permission": "bash", "patterns": []string{"echo hi"}, "always": []string{"*"}, "metadata": object{"command": "echo hi"}}
			if kind == "question" {
				props = object{"id": "req_" + uid, "sessionID": v.ID, "questions": []object{{"question": "Pick?", "header": "Choice", "multiple": true, "options": []object{{"label": "Alpha", "description": "First"}, {"label": "Beta", "description": "Second"}}}}}
			}
			eventType := kind + ".asked"
			if v2 {
				eventType = kind + ".v2.asked"
				if kind == "permission" {
					props["action"], props["resources"], props["save"] = props["permission"], props["patterns"], props["always"]
					delete(props, "permission")
					delete(props, "patterns")
					delete(props, "always")
				}
			}
			if s.allowed[dir] {
				go s.finish(v, "approved")
				w.WriteHeader(204)
				return
			}
			v.Pending = []object{{"kind": kind, "v2": v2, "properties": props}}
			s.emit(v, eventType, props)
			w.WriteHeader(204)
			return
		}
		go s.run(v, gen)
		if s.mode == "blocked-command" && bits[2] == "command" {
			s.mu.Unlock()
			time.Sleep(250 * time.Millisecond)
			s.mu.Lock()
		}
		w.WriteHeader(204)
	default:
		http.NotFound(w, r)
	}
}
func (s *server) events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	f := w.(http.Flusher)
	ch := make(chan object, 256)
	s.mu.Lock()
	s.subs[ch] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.subs, ch); s.mu.Unlock() }()
	_, _ = fmt.Fprint(w, "data: {\"payload\":{\"type\":\"server.connected\",\"properties\":{}}}\n\n")
	f.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case e := <-ch:
			b, _ := json.Marshal(e)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
			f.Flush()
			if s.mode == "disconnect" && e["payload"].(object)["type"] == "message.part.delta" {
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
	id := "msg_assistant_" + v.ID + "_" + strconv.Itoa(gen)
	info := object{"id": id, "sessionID": v.ID, "role": "assistant", "cost": 0.01, "tokens": object{"input": 10, "output": 5, "reasoning": 0, "cache": object{"read": 0, "write": 0}}}
	s.emit(v, "message.updated", object{"info": info})
	p := object{"id": "prt_" + id, "sessionID": v.ID, "messageID": id, "type": "text", "text": ""}
	s.emit(v, "message.part.updated", object{"part": p})
	s.emit(v, "message.part.delta", object{"sessionID": v.ID, "messageID": id, "partID": p["id"], "field": "text", "delta": "echo: "})
	s.mu.Unlock()
	if s.mode == "slow" {
		time.Sleep(150 * time.Millisecond)
	}
	s.mu.Lock()
	text := v.Text
	if gen != v.Generation {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.finishMessage(v, gen, info, p, "echo: "+text)
}
func (s *server) finish(v *session, text string) {
	s.mu.Lock()
	gen := v.Generation
	s.mu.Unlock()
	s.runResult(v, gen, text)
}
func (s *server) runResult(v *session, gen int, text string) {
	id := "msg_result_" + v.ID + strconv.Itoa(gen)
	info := object{"id": id, "role": "assistant", "sessionID": v.ID, "cost": 0.01, "tokens": object{"input": 10, "output": 5}}
	p := object{"id": "prt_" + id, "messageID": id, "sessionID": v.ID, "type": "text"}
	s.finishMessage(v, gen, info, p, text)
}
func (s *server) finishMessage(v *session, gen int, info, p object, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if gen != v.Generation {
		return
	}
	p["text"] = text
	p["time"] = object{"start": 1, "end": 2}
	info["time"] = object{"created": 1, "completed": 2}
	info["finish"] = "stop"
	s.emit(v, "message.updated", object{"info": info})
	s.emit(v, "message.part.updated", object{"part": p})
	s.emit(v, "message.part.updated", object{"part": p})
	parts := []object{p}
	if v.Text == "tools" {
		for _, tool := range []string{"bash", "write"} {
			tp := object{"id": "prt_" + tool + info["id"].(string), "messageID": info["id"], "sessionID": v.ID, "type": "tool", "tool": tool, "callID": tool, "state": object{"status": "completed", "input": object{"command": "echo hi", "filePath": "test.txt"}, "output": "done", "metadata": object{"diff": "+hello"}}}
			s.emit(v, "message.part.updated", object{"part": tp})
			parts = append(parts, tp)
		}
		reason := object{"id": "prt_reason" + info["id"].(string), "messageID": info["id"], "sessionID": v.ID, "type": "reasoning", "text": "Thinking", "time": object{"end": 2}}
		s.emit(v, "message.part.updated", object{"part": reason})
		parts = append(parts, reason)
	}
	v.Messages = append(v.Messages, object{"info": info, "parts": parts})
	s.save()
	s.status(v, "idle")
	if v.ParentID != "" {
		if parent := s.sessions[v.ParentID]; parent != nil {
			s.status(parent, "idle")
		}
	}
}
