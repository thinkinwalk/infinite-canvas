package service

import (
	"context"

	"github.com/basketikun/infinite-canvas/model"
)

type userContextKey struct{}
type opsRedemptionContextKey struct{}

func WithUser(ctx context.Context, user model.AuthUser) context.Context {
	return context.WithValue(ctx, userContextKey{}, user)
}

func UserFromContext(ctx context.Context) (model.AuthUser, bool) {
	user, ok := ctx.Value(userContextKey{}).(model.AuthUser)
	return user, ok
}

func WithOpsRedemptionAuth(ctx context.Context) context.Context {
	return context.WithValue(ctx, opsRedemptionContextKey{}, true)
}

func IsOpsRedemptionRequest(ctx context.Context) bool {
	authenticated, _ := ctx.Value(opsRedemptionContextKey{}).(bool)
	return authenticated
}
