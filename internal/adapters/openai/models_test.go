package openai

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLiveModelCatalogProtocols(t *testing.T) {
	for _, wire := range []Wire{Codex, OpenRouter, Responses} {
		t.Run(string(wire), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.Header.Get("Authorization") != "Bearer key" {
					t.Error("wrong catalog request")
				}
				if wire == Codex {
					if r.URL.Path != "/codex/models" || r.URL.Query().Get("client_version") == "" || r.Header.Get("ChatGPT-Account-ID") != "account" {
						t.Error("wrong Codex catalog route")
					}
					_, _ = fmt.Fprint(w, `{"models":[{"slug":"fresh-codex","display_name":"Fresh Codex","visibility":"list","supported_in_api":true,"input_modalities":["text","image"],"default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"}]},{"slug":"internal","visibility":"hide","supported_in_api":true}]}`)
				} else {
					if r.URL.Path != "/models" || r.Header.Get("ChatGPT-Account-ID") != "" {
						t.Error("wrong compatible catalog route")
					}
					_, _ = fmt.Fprint(w, `{"data":[{"id":"vendor/new-model","name":"New model","architecture":{"input_modalities":["text","image"]},"supported_parameters":["reasoning"]}]}`)
				}
			}))
			defer srv.Close()
			models, err := (&Client{Wire: wire, BaseURL: srv.URL, Credentials: StaticCredentials{Token: "key", AccountID: "account"}}).ListModels(context.Background())
			if err != nil || len(models) != 1 {
				t.Fatalf("%+v %v", models, err)
			}
			if models[0].Images == nil || !*models[0].Images {
				t.Fatal("lost image capability")
			}
			if wire == Codex && (models[0].ID != "fresh-codex" || len(models[0].Efforts) != 2 || models[0].DefaultEffort != "medium") {
				t.Fatalf("%+v", models[0])
			}
			if wire != Codex && models[0].ID != "vendor/new-model" {
				t.Fatalf("%+v", models[0])
			}
		})
	}
}

func TestModelCatalogRejectsBadResponses(t *testing.T) {
	for _, body := range []string{`{`, `{}`, `{"data":[{}]}`, `{"data":[{"id":"x"},{"id":"x"}]}`} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = fmt.Fprint(w, body) }))
			defer srv.Close()
			if _, err := (&Client{Wire: OpenRouter, BaseURL: srv.URL, Credentials: StaticCredentials{Token: "key"}}).ListModels(context.Background()); err == nil {
				t.Fatal("invalid catalog accepted")
			}
		})
	}
}

func TestCatalogDoesNotFollowRedirectsOrExposeErrorBodies(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusTemporaryRedirect} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			requests := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests++
				w.Header().Set("Location", "/elsewhere")
				w.WriteHeader(status)
				_, _ = fmt.Fprint(w, "private-body")
			}))
			defer srv.Close()
			_, err := (&Client{Wire: OpenRouter, BaseURL: srv.URL, Credentials: StaticCredentials{Token: "key"}}).ListModels(context.Background())
			if err == nil || err.Error() != fmt.Sprintf("model endpoint returned HTTP %d", status) || requests != 1 {
				t.Fatalf("requests=%d error=%v", requests, err)
			}
		})
	}
}

func TestCatalogContextWindows(t *testing.T) {
	for _, tc := range []struct {
		wire Wire
		body string
	}{{Codex, `{"models":[{"slug":"m","visibility":"list","context_window":200000}]}`}, {OpenRouter, `{"data":[{"id":"m","context_length":200000}]}`}} {
		models, err := decodeModels([]byte(tc.body), tc.wire)
		if err != nil || models[0].ContextWindow != 200000 {
			t.Fatalf("%v %v", models, err)
		}
	}
}
