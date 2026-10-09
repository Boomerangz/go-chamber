package app

import (
	"context"

	"github.com/igorzygin/go-chamber/internal/domain"
)

type originKey struct{}

// WithOrigin marks what is sent or answered with ctx as coming from
// someone other than the owner: it is labelled so, and it is not taken as
// the owner having looked at the session.
func WithOrigin(ctx context.Context, o domain.Origin) context.Context {
	return context.WithValue(ctx, originKey{}, o)
}

// OriginOf is the origin WithOrigin put on ctx, empty for the owner.
func OriginOf(ctx context.Context) domain.Origin {
	o, _ := ctx.Value(originKey{}).(domain.Origin)
	return o
}
