package openai

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"
)

// Bound provider-controlled records without Scanner's default 64 KiB limit.
const maxEventBytes = 8 << 20

func readSSE(ctx context.Context, r io.Reader, accept func([]byte) (bool, error)) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), maxEventBytes)
	var data strings.Builder
	dispatch := func() (bool, error) {
		if data.Len() == 0 {
			return false, nil
		}
		payload := []byte(strings.TrimSuffix(data.String(), "\n"))
		data.Reset()
		return accept(payload)
	}
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := scanner.Text()
		if line == "" {
			stop, err := dispatch()
			if err != nil || stop {
				return err
			}
		} else if value, ok := strings.CutPrefix(line, "data:"); ok {
			value = strings.TrimPrefix(value, " ")
			if data.Len()+len(value)+1 > maxEventBytes {
				return errors.New("model SSE event exceeds size limit")
			}
			data.WriteString(value)
			data.WriteByte('\n')
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if scanner.Err() != nil {
		return errors.New("model SSE read failed")
	}
	// Per SSE framing an unterminated event is not committed at EOF.
	return io.ErrUnexpectedEOF
}
