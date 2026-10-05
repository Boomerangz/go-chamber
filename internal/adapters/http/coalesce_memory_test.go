package httpapi

import (
	"bytes"
	"fmt"
	"testing"
)

func TestCoalescedFrameCapacityScalesWithQueuedOutput(t *testing.T) {
	for _, count := range []int{2, 8, 32, 128, 256} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			chunk := bytes.Repeat([]byte("x"), 1024)
			out := make(chan []byte, count-1)
			for i := 1; i < count; i++ {
				out <- chunk
			}
			frame, open := coalesce(chunk, out, maxTerminalFrame)
			if !open || len(frame) != count*len(chunk) || !bytes.Equal(frame, bytes.Repeat(chunk, count)) {
				t.Fatal("coalesced output changed")
			}
			if cap(frame) > len(frame)*2 {
				t.Fatalf("%d-byte output retains %d-byte allocation", len(frame), cap(frame))
			}
			if !bytes.Equal(chunk, bytes.Repeat([]byte("x"), 1024)) {
				t.Fatal("shared chunk changed")
			}
		})
	}
}

func TestCoalesceVariableChunksStopsAtFrameLimit(t *testing.T) {
	out := make(chan []byte, 3)
	out <- []byte("bc")
	out <- []byte("defghi")
	out <- []byte("left")
	frame, open := coalesce([]byte("a"), out, 8)
	if string(frame) != "abcdefghi" || !open {
		t.Fatalf("frame=%q open=%v", frame, open)
	}
	if remaining := <-out; string(remaining) != "left" {
		t.Fatalf("remaining=%q", remaining)
	}
	close(out)
	frame, open = coalesce([]byte("tail"), out, 8)
	if string(frame) != "tail" || open {
		t.Fatal("closed output changed")
	}
}
