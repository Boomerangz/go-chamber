package claude

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
)

func toolInputFrames(t *testing.T, input string) [][]byte {
	t.Helper()
	var frames [][]byte
	for start := 0; start < len(input); start += 128 {
		frame, err := json.Marshal(map[string]any{"type": "stream_event", "event": map[string]any{
			"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": input[start:min(start+128, len(input))]},
		}})
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame)
	}
	return frames
}

func startInput(t *testing.T, m *Mapper) {
	t.Helper()
	feed(t, m,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m"}}}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"w","name":"Write"}}}`,
	)
}

func TestStreamedToolInputHasBoundedAllocationAndReleasesBuffer(t *testing.T) {
	input := `{"file_path":"/tmp/generated.txt","content":"` + strings.Repeat("x", 512<<10) + `"}`
	frames := toolInputFrames(t, input)
	m := NewMapper("s")
	startInput(t, m)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	for _, frame := range frames {
		if _, err := m.Map(frame); err != nil {
			t.Fatal(err)
		}
	}
	runtime.ReadMemStats(&after)
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > uint64(len(input))*64 {
		t.Fatalf("streamed %d bytes allocated %d bytes; budget is 64x input", len(input), allocated)
	}
	events := feed(t, m, `{"type":"stream_event","event":{"type":"content_block_stop","index":0}}`)
	if len(events) != 1 || string(events[0].Item.Input) != input {
		t.Fatal("streamed input changed")
	}
	if len(m.inputBuf) != 0 {
		t.Fatalf("completed tool retains %d input buffers", len(m.inputBuf))
	}
}

func TestFullToolInputReleasesPartialStreamBuffer(t *testing.T) {
	m := NewMapper("s")
	startInput(t, m)
	feed(t, m, `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":"}}}`)
	events := feed(t, m, `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"w","name":"Write","input":{"file_path":"/tmp/x","content":"full"}}]}}`)
	if len(events) != 1 || !strings.Contains(string(events[0].Item.Input), `"content":"full"`) {
		t.Fatal("full input missing")
	}
	if len(m.inputBuf) != 0 {
		t.Fatal("full input retains partial stream buffer")
	}
}
