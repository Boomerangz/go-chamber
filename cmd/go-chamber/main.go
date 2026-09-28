// Command go-chamber serves the web UI for Claude Code and Codex sessions.
// It is the composition root: the only place where adapters meet the app.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/igorzygin/go-chamber/internal/adapters/claude"
	"github.com/igorzygin/go-chamber/internal/adapters/codex"
	"github.com/igorzygin/go-chamber/internal/adapters/fsys"
	httpapi "github.com/igorzygin/go-chamber/internal/adapters/http"
	"github.com/igorzygin/go-chamber/internal/adapters/hub"
	"github.com/igorzygin/go-chamber/internal/adapters/pty"
	"github.com/igorzygin/go-chamber/internal/adapters/router"
	"github.com/igorzygin/go-chamber/internal/adapters/sqlite"
	"github.com/igorzygin/go-chamber/internal/app"
	"github.com/igorzygin/go-chamber/web"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Stdout)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "go-chamber:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, out io.Writer) error {
	fl := flag.NewFlagSet("go-chamber", flag.ContinueOnError)
	addr := fl.String("addr", "127.0.0.1:7777", "listen address")
	home, _ := os.UserHomeDir()
	dataDir := fl.String("data", filepath.Join(home, ".go-chamber"), "data directory")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	token, err := loadOrCreateToken(filepath.Join(*dataDir, "token"))
	if err != nil {
		return err
	}
	store, err := sqlite.Open(filepath.Join(*dataDir, "go-chamber.db"))
	if err != nil {
		return err
	}
	defer store.Close()

	eventLog := store.Events()
	events := hub.NewLogged(eventLog, func(err error) {
		_, _ = fmt.Fprintln(os.Stderr, "event log:", err)
	})
	codexFactory := &codex.Factory{}
	runtimes := &router.Router{
		Claude:   &claude.Factory{},
		Codex:    codexFactory,
		Accounts: codexFactory,
		Quotas:   codexFactory,
	}
	manager := app.NewManager(app.ManagerConfig{
		Repo:          store.Sessions(),
		Runtimes:      runtimes,
		Accounts:      runtimes,
		Quotas:        store.Quotas(),
		QuotaProvider: runtimes,
		Bus:           events,
		History:       events,
		Models:        runtimes,
	})
	defer manager.Close()
	if _, err := manager.Restore(ctx); err != nil {
		return err
	}
	terminals := app.NewTerminals(app.TerminalsConfig{
		PTYs:     pty.Factory{},
		Sessions: store.Sessions(),
		Home:     home,
		Shell:    os.Getenv("SHELL"),
	})
	// Closing shells also ends their WebSockets, which Shutdown doesn't track.
	defer terminals.CloseAll()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler: httpapi.NewServer(httpapi.Config{
			Token:     token,
			Static:    web.Dist(),
			Sessions:  manager,
			Events:    events,
			Terminals: terminals,
			Folders:   app.NewFolders(app.FoldersConfig{Reader: fsys.Reader{}, Home: home}),
			Search:    eventLog,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	if _, err := fmt.Fprintf(out, "go-chamber listening on http://%s/?token=%s\n", ln.Addr(), token); err != nil {
		return err
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		terminals.CloseAll()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

// loadOrCreateToken keeps the access token stable across restarts so that
// bookmarked URLs and installed PWAs keep working.
func loadOrCreateToken(path string) (string, error) {
	if b, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(b)); t != "" {
			return t, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	t := hex.EncodeToString(buf)
	return t, os.WriteFile(path, []byte(t+"\n"), 0o600)
}
