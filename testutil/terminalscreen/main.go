// terminalscreen emits canonical snapshots for the browser compatibility gate.
// It is a test utility, never an HTTP endpoint accepting terminal contents.
package main

import (
	"encoding/json"
	"os"

	"github.com/igorzygin/go-chamber/internal/adapters/terminalscreen"
	"github.com/igorzygin/go-chamber/internal/app"
)

type fixture struct {
	Name          string                     `json:"name"`
	Cols          uint16                     `json:"cols"`
	Rows          uint16                     `json:"rows"`
	Before        string                     `json:"before"`
	ChunkBytes    int                        `json:"chunkBytes,omitempty"`
	Replies       int                        `json:"replies,omitempty"`
	After         string                     `json:"after"`
	ResizeCols    uint16                     `json:"resizeCols"`
	ResizeRows    uint16                     `json:"resizeRows"`
	Snapshot      app.TerminalScreenSnapshot `json:"snapshot"`
	AfterSnapshot app.TerminalScreenSnapshot `json:"afterSnapshot"`
}

func main() {
	var fixtures []fixture
	if err := json.NewDecoder(os.Stdin).Decode(&fixtures); err != nil {
		panic(err)
	}
	for i := range fixtures {
		f := &fixtures[i]
		s := terminalscreen.New(f.Cols, f.Rows)
		data := []byte(f.Before)
		if f.ChunkBytes > 0 {
			for len(data) > 0 {
				n := min(len(data), f.ChunkBytes)
				s.Feed(data[:n])
				data = data[n:]
			}
		} else {
			s.Feed(data)
		}
		if f.ResizeCols != 0 {
			s.Resize(f.ResizeCols, f.ResizeRows)
		}
		f.Snapshot = s.Snapshot()
		s.Feed([]byte(f.After))
		f.AfterSnapshot = s.Snapshot()
		s.Close()
	}
	if err := json.NewEncoder(os.Stdout).Encode(fixtures); err != nil {
		panic(err)
	}
}
