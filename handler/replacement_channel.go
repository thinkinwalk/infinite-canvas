package handler

import (
	"context"
	"fmt"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

type replacementChannelKey struct{}

// Only server-side orchestration sets this context value; clients cannot select
// an unauthorized channel using a request field or header.
func replacementModelChannel(ctx context.Context, name, group string, replicate bool) (model.ModelChannel, error) {
	if selected := service.ManagedSelectionFromContext(ctx); selected != nil {
		if selected.Route.Model != name {
			return model.ModelChannel{}, fmt.Errorf("模型身份与执行上下文不一致")
		}
		return selected.Channel, nil
	}
	id, _ := ctx.Value(replacementChannelKey{}).(int)
	if replicate {
		return service.SelectReplicateChannelForID(name, group, id)
	}
	if id == 0 {
		return service.SelectModelChannelForGroup(name, group)
	}
	channels, err := service.SelectModelChannelsForGroup(name, group)
	if err != nil {
		return model.ModelChannel{}, err
	}
	for _, channel := range channels {
		if channel.ID == id {
			return channel, nil
		}
	}
	return model.ModelChannel{}, fmt.Errorf("整片任务原渠道已不可用，已暂停；不会切换渠道")
}
