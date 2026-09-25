//go:build !embedweb

package web

import (
	"io/fs"
	"testing/fstest"
)

func Dist() fs.FS {
	return fstest.MapFS{"index.html": {Data: []byte(
		"<!doctype html><title>go-chamber</title><p>UI not embedded: run <code>make build</code>.</p>")}}
}
