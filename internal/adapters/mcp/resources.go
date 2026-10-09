package mcpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/igorzygin/go-chamber/internal/domain"
)

const sessionsURI = "chamber://sessions"

// resourceLimit bounds a transcript resource; the tool pages by since_seq.
const resourceLimit = 200_000

func (s *Server) resources() {
	s.mcp.AddResource(&sdk.Resource{URI: sessionsURI, Name: "sessions", Description: "Every session, as list_sessions shows it", MIMEType: "application/json"}, s.readSessions)
	s.mcp.AddResourceTemplate(&sdk.ResourceTemplate{URITemplate: sessionsURI + "/{id}", Name: "session", Description: "A session's compacted transcript", MIMEType: "text/plain"}, s.readTranscript)
	if s.cfg.Worktrees != nil {
		s.mcp.AddResourceTemplate(&sdk.ResourceTemplate{URITemplate: sessionsURI + "/{id}/diff", Name: "session diff", Description: "What a session's folder changed against its base", MIMEType: "text/x-diff"}, s.readDiff)
	}
}

func textResource(uri, mime, text string) *sdk.ReadResourceResult {
	return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{URI: uri, MIMEType: mime, Text: text}}}
}

func (s *Server) readSessions(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
	_, out, err := s.listSessions(ctx, nil, listIn{})
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(out.Sessions)
	if err != nil {
		return nil, err
	}
	return textResource(req.Params.URI, "application/json", string(raw)), nil
}

// sessionOf is the session a resource URI names, with what follows it.
func sessionOf(uri string) (domain.SessionID, string) {
	rest := strings.TrimPrefix(uri, sessionsURI+"/")
	id, sub, _ := strings.Cut(rest, "/")
	return domain.SessionID(id), sub
}

func (s *Server) readTranscript(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
	uri := req.Params.URI
	id, sub := sessionOf(uri)
	if sub != "" {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	if _, err := s.cfg.Sessions.GetSession(ctx, id); err != nil {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	return textResource(uri, "text/plain", fold(s.cfg.Events.History(id, 0)).render(resourceLimit)), nil
}

func (s *Server) readDiff(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
	uri := req.Params.URI
	id, sub := sessionOf(uri)
	if sub != "diff" {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	if _, err := s.cfg.Sessions.GetSession(ctx, id); err != nil {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	_, diff, err := s.diff(ctx, id, "")
	if err != nil {
		return nil, err
	}
	return textResource(uri, "text/x-diff", diff), nil
}

// subscribe takes only URIs Watch sends updates for: they must match it
// exactly.
func (s *Server) subscribe(ctx context.Context, req *sdk.SubscribeRequest) error {
	uri := req.Params.URI
	if uri == sessionsURI {
		return nil
	}
	id, sub := sessionOf(uri)
	ok := strings.HasPrefix(uri, sessionsURI+"/") && id != "" && (sub == "" || sub == "diff" && s.cfg.Worktrees != nil)
	if ok {
		_, err := s.cfg.Sessions.GetSession(ctx, id)
		ok = err == nil
	}
	if !ok {
		return fmt.Errorf("no such resource: %s", uri)
	}
	return nil
}

// Watch tells subscribed clients when a session resource changes, until
// ctx is done. It is subscribed to the hub when it returns.
func (s *Server) Watch(ctx context.Context) {
	sub := s.cfg.Events.Subscribe()
	go func() {
		defer sub.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-sub.Events():
				for _, uri := range touched(ev) {
					_ = s.mcp.ResourceUpdated(ctx, &sdk.ResourceUpdatedNotificationParams{URI: uri})
				}
			}
		}
	}()
}

// touched lists the resources an event changes; streaming fragments are
// not news, finished items are.
func touched(ev domain.Event) []string {
	session := sessionsURI + "/" + string(ev.SessionID)
	switch ev.Type {
	case domain.EventSessionState, domain.EventTurnStarted, domain.EventSessionRemoved,
		domain.EventRequestOpened, domain.EventRequestResolved:
		return []string{sessionsURI, session}
	case domain.EventTurnEnded:
		return []string{sessionsURI, session, session + "/diff"}
	case domain.EventItemUpdated:
		if ev.Item == nil || !ev.Item.Status.Terminal() {
			return nil
		}
		if ev.Item.Kind == domain.ItemFileChange {
			return []string{session, session + "/diff"}
		}
		return []string{session}
	}
	return nil
}
