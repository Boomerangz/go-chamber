//go:build embedweb

// Package web exposes the built UI. Build with -tags embedweb after
// `npm run build`; without the tag a placeholder page is served so that
// `go test ./...` works on a fresh clone.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
