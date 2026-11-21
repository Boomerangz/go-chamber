// Command native-probe verifies native model transports before UI integration.
// It does not execute model tools or read the installed Codex CLI credentials.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/igorzygin/go-chamber/internal/adapters/openai"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/internal/domain"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err := run(ctx, os.Args[1:], os.Stdout)
	stop()
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out io.Writer) error {
	f := flag.NewFlagSet("native-probe", flag.ContinueOnError)
	f.SetOutput(out)
	data := f.String("data", "", "isolated directory for native credentials (required)")
	listModels := f.Bool("list-models", false, "fetch current provider model catalog without inference")
	login := f.Bool("login", false, "sign in to Codex subscription with a device code")
	wire := f.String("wire", string(openai.Codex), "codex-responses, responses, chat-completions, or openrouter")
	base := f.String("base-url", "", "model endpoint base URL; Codex defaults to its subscription endpoint")
	model := f.String("model", "", "exact model ID (required for inference)")
	message := f.String("message", "Reply with exactly: native transport works", "one smoke prompt")
	keyEnv := f.String("key-env", "", "explicit environment variable containing a compatible endpoint API key")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *data == "" {
		return errors.New("-data must name an isolated credential directory")
	}
	auth := &openai.CodexAuth{Path: filepath.Join(*data, "codex.json")}
	if *login {
		challenge, err := auth.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err = fmt.Fprintf(out, "Open %s and enter %s\n", challenge.URL, challenge.UserCode); err != nil {
			return err
		}
		if err = auth.Complete(ctx, challenge); err != nil {
			return err
		}
		_, err = fmt.Fprintln(out, "Native Codex subscription connected.")
		return err
	}
	if *model == "" && !*listModels {
		return errors.New("-model must name an exact model ID")
	}
	c := &openai.Client{Wire: openai.Wire(*wire), BaseURL: *base}
	if c.Wire == openai.Codex {
		if *keyEnv != "" {
			return errors.New("codex subscription does not accept -key-env")
		}
		c.Credentials = auth
	} else if *keyEnv != "" {
		key := os.Getenv(*keyEnv)
		if key == "" {
			return errors.New("selected API key environment variable is empty")
		}
		c.Credentials = openai.StaticCredentials{Token: key}
	}
	if *listModels {
		catalog, err := app.NewModelCache(c, 0, nil).List(ctx, false)
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		return encoder.Encode(catalog)
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result, err := c.Stream(ctx, domain.ModelRequest{Model: *model, Messages: []domain.ModelMessage{{Role: "user", Text: *message}}}, func(d domain.ModelDelta) error { _, err := io.WriteString(out, d.Text); return err })
	if err != nil {
		return err
	}
	if len(result.Message.ToolCalls) != 0 {
		return errors.New("smoke response unexpectedly requested tools")
	}
	_, err = fmt.Fprintf(out, "\nCompleted. Tokens: %d input, %d output, %d cached input.\n", result.Usage.Input, result.Usage.Output, result.Usage.CachedInput)
	return err
}
