package app

import (
	"context"
	"errors"
	"io/fs"
	"testing"

	"github.com/igorzygin/go-chamber/internal/domain"
)

// fakeResolver maps paths to their real location; missing paths don't exist.
type fakeResolver map[string]string

func (f fakeResolver) Resolve(path string) (string, error) {
	if real, ok := f[path]; ok {
		return real, nil
	}
	return "", fs.ErrNotExist
}

func TestSessionFileStaysInsideTheSessionFolder(t *testing.T) {
	sessions := cwdRepo{"s1": {ID: "s1", Cwd: "/work/proj"}}
	files := NewSessionFiles(sessions, fakeResolver{
		"/work/proj":              "/real/proj",
		"/work/proj/docs/plan.md": "/real/proj/docs/plan.md",
		"/work/proj/out.png":      "/real/proj/out.png",
		"/work/proj/escape":       "/etc/passwd",
		"/work/proj-other/x.md":   "/real/proj-other/x.md",
		"/etc/hosts":              "/etc/hosts",
		"/work/proj/docs":         "/real/proj/docs",
	})
	ctx := context.Background()

	cases := []struct {
		path string
		want string
		err  error
	}{
		{"/work/proj/docs/plan.md", "/real/proj/docs/plan.md", nil},
		{"docs/plan.md", "/real/proj/docs/plan.md", nil},
		{"./out.png", "/real/proj/out.png", nil},
		{"/etc/hosts", "", ErrFileOutsideSession},
		{"../../etc/hosts", "", ErrFileOutsideSession},
		{"/work/proj-other/x.md", "", ErrFileOutsideSession},
		{"escape", "", ErrFileOutsideSession},
		{"missing.md", "", ErrFileNotFound},
		{"", "", ErrFileNotFound},
	}
	for _, c := range cases {
		got, err := files.Resolve(ctx, "s1", c.path)
		if got != c.want || !errors.Is(err, c.err) {
			t.Errorf("%q: got %q, %v; want %q, %v", c.path, got, err, c.want, c.err)
		}
	}
	if _, err := files.Resolve(ctx, "nope", "x"); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("unknown session err = %v", err)
	}
}

type cwdRepo map[domain.SessionID]domain.SessionSnapshot

func (r cwdRepo) Get(_ context.Context, id domain.SessionID) (domain.SessionSnapshot, error) {
	if s, ok := r[id]; ok {
		return s, nil
	}
	return domain.SessionSnapshot{}, ErrSessionNotFound
}
