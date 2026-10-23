package handler

import (
	"fmt"
	"net/http"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func managedCloudSelection(r *http.Request, input replicateRequest, submitting bool) (*service.ManagedSelection, service.ReplicateModel, error) {
	enabled, err := service.ManagementEnabled()
	if err != nil {
		return nil, service.ReplicateModel{}, err
	}
	if !enabled {
		spec, err := service.FindReplicateModel(input.Operation)
		return nil, spec, err
	}
	user, _ := service.UserFromContext(r.Context())
	selected := service.ManagedSelectionFromContext(r.Context())
	if selected != nil {
		ctx, checkErr := service.RevalidateManagedSelection(r.Context())
		if checkErr != nil {
			return nil, service.ReplicateModel{}, checkErr
		}
		selected = service.ManagedSelectionFromContext(ctx)
	}
	if selected == nil {
		feature := input.FeatureID
		if feature == "" {
			feature = r.Header.Get("X-Model-Feature")
		}
		channelID := 0
		proofRevision := 0
		if submitting {
			proof, err := service.VerifyManagedQuote(input.QuoteToken, user.ID, input.Input)
			if err != nil {
				return nil, service.ReplicateModel{}, err
			}
			if proof.Group != user.Group {
				return nil, service.ReplicateModel{}, fmt.Errorf("用户分组已变化，请重新确认报价")
			}
			if proof.FeatureID != feature || proof.ModelID != input.ModelID {
				return nil, service.ReplicateModel{}, fmt.Errorf("报价功能或模型已变化")
			}
			channelID, proofRevision = proof.ChannelID, proof.Revision
		}
		selected, err = service.ResolveManagedModel(feature, input.ModelID, user.Group, channelID)
		if err != nil {
			return nil, service.ReplicateModel{}, err
		}
		if proofRevision != 0 && proofRevision != selected.Revision {
			return nil, service.ReplicateModel{}, fmt.Errorf("配置已变化，请重新报价")
		}
	}
	if !managedHas(selected.Feature.Operations, input.Operation) || !managedHas(selected.Route.Operations, input.Operation) {
		return nil, service.ReplicateModel{}, fmt.Errorf("所选模型未绑定此功能操作")
	}
	spec, err := service.FindReplicateModel(input.Operation)
	if err != nil {
		return nil, spec, err
	}
	if spec.Model != selected.Route.Model {
		return nil, spec, fmt.Errorf("当前适配器不支持此真实模型，请检查模型接入")
	}
	if selected.Route.Version != "" && selected.Route.Version != spec.Version {
		return nil, spec, fmt.Errorf("模型版本已变化，请管理员核对适配版本")
	}
	return selected, spec, nil
}

func publicManagedCloudTask(task model.ReplicateTask) model.ReplicateTask {
	if task.PlatformModelID != "" {
		task.Model = task.PlatformModelID
		task.ChannelID, task.ChannelName, task.Version, task.Metrics, task.PricingSnapshot = 0, "", "", "", ""
		if task.Error != "" {
			task.Error = "模型任务未完成，请保留任务编号并恢复查询；详细原因可联系管理员核对"
		}
	}
	return task
}
