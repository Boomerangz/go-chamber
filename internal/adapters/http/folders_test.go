package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/igorzygin/go-chamber/internal/app"
)

type stubFolders struct {
	dir    string
	hidden bool
	err    error
}

func (s *stubFolders) List(dir string, hidden bool) (app.FolderListing, error) {
	s.dir, s.hidden = dir, hidden
	if s.err != nil {
		return app.FolderListing{}, s.err
	}
	return app.FolderListing{Path: "/home/me", Parent: "/home", Home: "/home/me",
		Folders: []app.Folder{{Name: "proj", Path: "/home/me/proj", Repo: true}}}, nil
}

func getFolders(t *testing.T, folders Folders, query string) (int, []byte) {
	t.Helper()
	ts := httptest.NewServer(NewServer(Config{Token: testToken, Static: fstest.MapFS{}, Folders: folders}))
	t.Cleanup(ts.Close)
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/folders"+query, nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, body
}

func TestListFolders(t *testing.T) {
	stub := &stubFolders{}
	status, raw := getFolders(t, stub, "?path=%2Fhome%2Fme&hidden=1")
	if status != http.StatusOK {
		t.Fatalf("status %d", status)
	}
	if stub.dir != "/home/me" || !stub.hidden {
		t.Fatalf("called with %q hidden=%v", stub.dir, stub.hidden)
	}
	var body app.FolderListing
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatal(err)
	}
	if body.Parent != "/home" || len(body.Folders) != 1 || !body.Folders[0].Repo {
		t.Fatalf("body = %+v", body)
	}
	getFolders(t, stub, "")
	if stub.dir != "" || stub.hidden {
		t.Fatalf("defaults: %q hidden=%v", stub.dir, stub.hidden)
	}
}

func TestListFoldersErrors(t *testing.T) {
	cases := map[error]int{
		app.ErrInvalidFolder:   http.StatusBadRequest,
		app.ErrFolderNotFound:  http.StatusNotFound,
		app.ErrFolderForbidden: http.StatusForbidden,
		errors.New("boom"):     http.StatusInternalServerError,
	}
	for err, status := range cases {
		if got, _ := getFolders(t, &stubFolders{err: err}, "?path=x"); got != status {
			t.Errorf("%v: status %d, want %d", err, got, status)
		}
	}
}
