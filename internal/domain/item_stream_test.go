package domain

import (
	"strings"
	"testing"
)

func TestAppendTextAllocationsGrowWithContentRatherThanChunks(t *testing.T) {
	const chunks = 4096
	chunk := strings.Repeat("x", 32)
	var item Item
	allocations := testing.AllocsPerRun(1, func() {
		item = Item{Text: "prefix"}
		for i := 0; i < chunks; i++ {
			item.AppendText(chunk)
		}
	})
	if item.Text != "prefix"+strings.Repeat(chunk, chunks) {
		t.Fatal("streamed text changed")
	}
	if allocations > 64 {
		t.Fatalf("4096 chunks allocated %.0f times, want <=64", allocations)
	}
}

func TestAppendTextKeepsCopiesIndependentAndRespectsAssignedText(t *testing.T) {
	original := &Item{}
	original.AppendText("hello")
	detached := DetachItems([]Event{{Item: original}})[0].Item
	copied := *original
	original.AppendText(" original")
	detached.AppendText(" detached")
	copied.AppendText(" copied")
	if original.Text != "hello original" || detached.Text != "hello detached" || copied.Text != "hello copied" {
		t.Fatalf("original=%q detached=%q copied=%q", original.Text, detached.Text, copied.Text)
	}
	original.Text = "replacement"
	original.AppendText(" tail")
	if original.Text != "replacement tail" {
		t.Fatalf("assigned text lost: %q", original.Text)
	}
	original.AppendText("")
	if original.Text != "replacement tail" {
		t.Fatal("empty delta changed text")
	}
}

func TestDetachedTextStreamsCanAdvanceConcurrently(t *testing.T) {
	original := &Item{}
	original.AppendText("seed")
	detached := DetachItems([]Event{{Item: original}})[0].Item
	done := make(chan struct{})
	go func() {
		for range 1000 {
			original.AppendText("a")
		}
		close(done)
	}()
	for range 1000 {
		detached.AppendText("b")
	}
	<-done
	if original.Text != "seed"+strings.Repeat("a", 1000) || detached.Text != "seed"+strings.Repeat("b", 1000) {
		t.Fatal("detached streams shared text")
	}
}
