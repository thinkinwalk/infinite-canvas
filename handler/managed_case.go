package handler

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

type managedCaseCountKey struct{}

func managedCaseParameters(r *http.Request, featureID string) (map[string]any, error) {
	parts := strings.Split(strings.TrimPrefix(featureID, "case:"), ":")
	if len(parts) != 2 {
		return nil, fmt.Errorf("案例功能编号无效")
	}
	item, found, err := service.GetCase(parts[0], true)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("案例已不可用，请重新确认")
	}
	count := 1
	if parts[1] == "image" {
		if value, ok := r.Context().Value(managedCaseCountKey{}).(int); ok {
			count = value
		} else if item.ID == "official-image-variations" {
			count = variationCount(r.URL.Query().Get("count"))
		} else if item.ID == "official-fusion" {
			count = fusionCount(r.URL.Query().Get("count"))
		}
	}
	return map[string]any{"case": item.ID, "runtime": item.RuntimeConfig, "version": item.PublishedVersion, "fee": item.PriceCredits, "memberFee": item.MemberPriceCredits, "count": count}, nil
}

func withManagedCaseCount(r *http.Request, count int) {
	*r = *r.WithContext(context.WithValue(r.Context(), managedCaseCountKey{}, count))
}

func casePrice(w http.ResponseWriter, r *http.Request, price map[string]any) {
	if selected := service.ManagedSelectionFromContext(r.Context()); selected != nil {
		user, _ := service.UserFromContext(r.Context())
		parameters, err := managedCaseParameters(r, selected.Feature.ID)
		if err != nil {
			Fail(w, err.Error())
			return
		}
		price["quoteToken"] = service.SignManagedQuote(user.ID, selected, parameters)
		price["revision"] = selected.Revision
	}
	OK(w, price)
}

func resolveManagedCase(r *http.Request, featureID, group string) (*service.ManagedSelection, error) {
	if selected := service.ManagedSelectionFromContext(r.Context()); selected != nil && selected.Feature.ID == featureID {
		ctx, err := service.RevalidateManagedSelection(r.Context())
		if err != nil {
			return nil, err
		}
		return service.ManagedSelectionFromContext(ctx), nil
	}
	channelID, modelID, revision := 0, "", 0
	if !strings.HasSuffix(r.URL.Path, "price") {
		user, _ := service.UserFromContext(r.Context())
		parameters, err := managedCaseParameters(r, featureID)
		if err != nil {
			return nil, err
		}
		proof, err := service.VerifyManagedQuote(r.Header.Get("X-Case-Quote"), user.ID, parameters)
		if err != nil {
			return nil, err
		}
		if proof.Group != group {
			return nil, fmt.Errorf("用户分组已变化，请重新确认报价")
		}
		if proof.FeatureID != featureID {
			return nil, fmt.Errorf("案例报价步骤已变化，请重新确认费用")
		}
		channelID, modelID, revision = proof.ChannelID, proof.ModelID, proof.Revision
	}
	selected, err := service.ResolveManagedModel(featureID, modelID, group, channelID)
	if err != nil {
		return nil, err
	}
	if revision != 0 && selected.Revision != revision {
		return nil, fmt.Errorf("模型配置已变化，请重新确认案例费用；本次未扣费")
	}
	*r = *r.WithContext(service.WithManagedSelection(r.Context(), selected))
	return selected, nil
}
