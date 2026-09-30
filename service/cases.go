package service

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type CaseDraftInput struct {
	ID                  string   `json:"id"`
	Title               string   `json:"title"`
	Description         string   `json:"description"`
	CoverURL            string   `json:"coverUrl"`
	Category            string   `json:"category"`
	Tags                []string `json:"tags"`
	PublicSchema        any      `json:"publicSchema"`
	WorkflowSnapshot    any      `json:"workflowSnapshot"`
	RuntimeConfig       any      `json:"runtimeConfig"`
	PriceCredits        int      `json:"priceCredits"`
	MemberPriceCredits  int      `json:"memberPriceCredits"`
	CostCredits         int      `json:"costCredits"`
	RevenueSharePercent int      `json:"revenueSharePercent"`
}

func ListPublishedCases(q model.Query) (model.CaseList, error) {
	items, total, err := repository.ListPublishedCases(q)
	return model.CaseList{Items: items, Total: int(total)}, err
}

func ListOwnedCases(ownerID string, q model.Query) (model.CaseList, error) {
	items, total, err := repository.ListCasesByOwner(ownerID, q)
	return model.CaseList{Items: items, Total: int(total)}, err
}

func ListAllCases(q model.Query) (model.CaseList, error) {
	items, total, err := repository.ListAllCases(q)
	return model.CaseList{Items: items, Total: int(total)}, err
}

func GetCase(id string, publicOnly bool) (model.CaseApp, bool, error) {
	item, ok, err := repository.GetCaseByID(id)
	if err != nil || !ok {
		return item, ok, err
	}
	if publicOnly && item.Status != model.CaseStatusPublished {
		return model.CaseApp{}, false, nil
	}
	return item, true, nil
}

func SaveCaseDraft(ownerID string, input CaseDraftInput) (model.CaseApp, error) {
	title := strings.TrimSpace(input.Title)
	if title == "" {
		return model.CaseApp{}, safeMessageError{message: "请填写案例名称"}
	}
	publicSchema, err := json.Marshal(input.PublicSchema)
	if err != nil {
		return model.CaseApp{}, safeMessageError{message: "公开输入配置格式无效"}
	}
	workflow, err := json.Marshal(input.WorkflowSnapshot)
	if err != nil {
		return model.CaseApp{}, safeMessageError{message: "工作流快照格式无效"}
	}
	runtimeConfig, err := json.Marshal(input.RuntimeConfig)
	if err != nil {
		return model.CaseApp{}, safeMessageError{message: "运行配置格式无效"}
	}
	if input.RevenueSharePercent <= 0 || input.RevenueSharePercent > 100 {
		input.RevenueSharePercent = 60
	}
	if input.PriceCredits < 0 {
		input.PriceCredits = 0
	}
	if input.MemberPriceCredits < 0 {
		input.MemberPriceCredits = 0
	}
	if input.CostCredits < 0 {
		input.CostCredits = 0
	}
	nowValue := now()
	item := model.CaseApp{
		ID:                  strings.TrimSpace(input.ID),
		OwnerID:             ownerID,
		Title:               title,
		Description:         strings.TrimSpace(input.Description),
		CoverURL:            strings.TrimSpace(input.CoverURL),
		Category:            strings.TrimSpace(input.Category),
		Tags:                input.Tags,
		Status:              model.CaseStatusDraft,
		PublicSchema:        string(publicSchema),
		WorkflowSnapshot:    string(workflow),
		RuntimeConfig:       string(runtimeConfig),
		PriceCredits:        input.PriceCredits,
		MemberPriceCredits:  input.MemberPriceCredits,
		CostCredits:         input.CostCredits,
		RevenueSharePercent: input.RevenueSharePercent,
		UpdatedAt:           nowValue,
	}
	if item.ID == "" {
		item.ID = newID("case")
		item.CreatedAt = nowValue
	}
	return repository.SaveCase(item)
}

func SubmitCaseReview(ownerID string, id string) (model.CaseApp, error) {
	item, ok, err := repository.GetCaseByID(id)
	if err != nil {
		return item, err
	}
	if !ok || item.OwnerID != ownerID {
		return item, safeMessageError{message: "案例不存在或无权操作"}
	}
	if isEmptyJSON(item.WorkflowSnapshot) || isEmptyJSON(item.RuntimeConfig) {
		return item, safeMessageError{message: "请先完善工作流和运行配置"}
	}
	if err := validateCaseRuntime(item.RuntimeConfig); err != nil {
		return item, err
	}
	item, _, err = repository.UpdateCaseStatus(id, model.CaseStatusPending, "", item.PublishedVersion, now())
	return item, err
}

func isEmptyJSON(value string) bool {
	value = strings.TrimSpace(value)
	return value == "" || value == "{}" || value == "null"
}

func ReviewCase(id string, status model.CaseStatus, note string) (model.CaseApp, error) {
	if status != model.CaseStatusPublished && status != model.CaseStatusRejected && status != model.CaseStatusOffline {
		return model.CaseApp{}, errors.New("审核状态无效")
	}
	item, ok, err := repository.GetCaseByID(id)
	if err != nil {
		return item, err
	}
	if !ok {
		return item, safeMessageError{message: "案例不存在"}
	}
	if status == model.CaseStatusPublished {
		if isEmptyJSON(item.WorkflowSnapshot) || isEmptyJSON(item.RuntimeConfig) {
			return item, safeMessageError{message: "案例缺少工作流或运行配置"}
		}
		if err := validateCaseRuntime(item.RuntimeConfig); err != nil {
			return item, err
		}
	}
	version := item.PublishedVersion
	if status == model.CaseStatusPublished && version < 1 {
		version = 1
	}
	item, _, err = repository.UpdateCaseStatus(id, status, strings.TrimSpace(note), version, now())
	return item, err
}

func validateCaseRuntime(value string) error {
	var runtime struct {
		Kind           string `json:"kind"`
		Model          string `json:"model"`
		PromptTemplate string `json:"promptTemplate"`
	}
	if err := json.Unmarshal([]byte(value), &runtime); err != nil {
		return safeMessageError{message: "案例运行配置格式无效"}
	}
	kind := strings.ToLower(strings.TrimSpace(runtime.Kind))
	if kind != "image" && kind != "video" && kind != "text" {
		return safeMessageError{message: "案例运行类型必须是 image、video 或 text"}
	}
	if strings.TrimSpace(runtime.Model) == "" || strings.TrimSpace(runtime.PromptTemplate) == "" {
		return safeMessageError{message: "案例必须配置模型和提示词模板"}
	}
	return nil
}

func SetCaseOfficial(id string, official bool) (model.CaseApp, error) {
	item, ok, err := repository.GetCaseByID(id)
	if err != nil {
		return item, err
	}
	if !ok {
		return item, safeMessageError{message: "案例不存在"}
	}
	item.IsOfficial = official
	item.UpdatedAt = now()
	return repository.SaveCase(item)
}

func ListCaseRuns(userID string, q model.Query, caseID ...string) ([]model.CaseRun, int64, error) {
	return repository.ListCaseRunsByUser(userID, q, caseID...)
}
