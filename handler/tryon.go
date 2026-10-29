package handler

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"strings"
)

// Keep multipart attachments and their prompt roles in the same order.
var tryonImageSources = []struct {
	key, role, description string
}{
	{"modelImageUrl", "模特", "人物身份来源，只采用此人的面容、发型、体型和肤色"},
	{"topImageUrl", "上装", "上装商品来源，保留版型、颜色、面料、领口、袖口、口袋、纽扣、图案与文字"},
	{"bottomImageUrl", "下装", "下装商品来源，保留版型、颜色、面料、腰线、裤长或裙长、图案与文字"},
	{"onePieceImageUrl", "连体装", "连衣裙或连体装商品来源，保留完整款式、长度、面料和细节"},
	{"poseImageUrl", "姿势", "仅参考身体朝向及四肢动作，不采用参考人物的脸、体型、服装或背景"},
	{"sceneImageUrl", "场景", "仅参考背景环境和光线，不采用其中的人物、服装或商品"},
}

func hasTryonImages(inputs map[string]any) bool {
	for _, source := range tryonImageSources {
		if stringInput(inputs, source.key) != "" {
			return true
		}
	}
	return false
}

func normalizeTryonInputs(inputs map[string]any) error {
	delete(inputs, "framing")
	for key, fallback := range map[string]string{
		"garmentMode": "separates",
		"poseMode": "preset", "sceneMode": "original",
	} {
		value, exists := inputs[key]
		if !exists || value == "" {
			inputs[key] = fallback
		}
	}
	for key, options := range map[string][]string{
		"garmentMode": {"separates", "one-piece"},
		"poseMode":    {"original", "preset", "library", "reference"},
		"sceneMode":   {"original", "studio", "library"},
	} {
		valid := false
		for _, option := range options {
			valid = valid || stringInput(inputs, key) == option
		}
		if !valid {
			return errors.New("试衣选项无效，请重新选择")
		}
	}
	for _, source := range tryonImageSources {
		if value, exists := inputs[source.key]; exists {
			if _, ok := value.(string); !ok {
				return fmt.Errorf("%s图片格式无效", source.role)
			}
			inputs[source.key] = strings.TrimSpace(stringInput(inputs, source.key))
		}
	}
	if stringInput(inputs, "garmentMode") == "one-piece" {
		if firstNonEmptyInput(inputs, "topImageUrl", "bottomImageUrl") != "" {
			return errors.New("连体装不能与上装、下装同时提交")
		}
		if stringInput(inputs, "onePieceImageUrl") == "" {
			return errors.New("请先上传连衣裙或连体装")
		}
	} else {
		if stringInput(inputs, "onePieceImageUrl") != "" {
			return errors.New("请切换至连衣裙 / 连体装")
		}
		if firstNonEmptyInput(inputs, "topImageUrl", "bottomImageUrl") == "" {
			return errors.New("请先上传上装或下装")
		}
	}
	if stringInput(inputs, "modelImageUrl") == "" {
		return errors.New("请选择或上传模特照片")
	}
	if stringInput(inputs, "poseMode") == "preset" {
		if _, exists := inputs["poseId"]; !exists {
			inputs["poseId"] = "front"
		}
		if tryonDisplayPosePrompt(stringInput(inputs, "poseId")) == "" {
			return errors.New("请选择展示姿势")
		}
		delete(inputs, "poseImageUrl")
	} else if stringInput(inputs, "poseMode") == "library" {
		pose, ok := findTryonPose(stringInput(inputs, "poseId"))
		if !ok || stringInput(inputs, "poseImageUrl") != pose.URL {
			return errors.New("请选择官方常用姿势")
		}
	} else if stringInput(inputs, "poseMode") == "reference" {
		delete(inputs, "poseId")
		if value, exists := inputs["posePrompt"]; exists {
			if _, ok := value.(string); !ok {
				return errors.New("自定义姿势描述格式无效")
			}
			inputs["posePrompt"] = strings.TrimSpace(stringInput(inputs, "posePrompt"))
		}
		if stringInput(inputs, "poseImageUrl") == "" && stringInput(inputs, "posePrompt") == "" {
			return errors.New("请描述自定义姿势或上传姿势参考照片")
		}
	} else {
		delete(inputs, "poseImageUrl")
		delete(inputs, "poseId")
	}
	if stringInput(inputs, "poseMode") != "reference" {
		delete(inputs, "posePrompt")
	}
	if stringInput(inputs, "sceneMode") == "library" {
		if stringInput(inputs, "sceneImageUrl") == "" {
			return errors.New("请选择场景")
		}
	} else {
		delete(inputs, "sceneImageUrl")
	}
	// This entry has role-specific inputs; generic references must not bypass validation.
	delete(inputs, "referenceImageUrls")
	for _, source := range tryonImageSources {
		value := stringInput(inputs, source.key)
		if value == "" {
			continue
		}
		if source.role == "姿势" && stringInput(inputs, "poseMode") == "library" {
			content, _, err := caseImageBytes(value)
			if err != nil {
				return err
			}
			if _, _, err := image.DecodeConfig(bytes.NewReader(content)); err != nil {
				return errors.New("常用姿势图片无法读取")
			}
			continue
		}
		if strings.HasPrefix(value, "https://") && validTryonLibraryURL(value, source.role) {
			continue
		}
		if source.role == "场景" {
			return errors.New("场景素材不在官方素材库中")
		}
		if !strings.HasPrefix(value, "data:"+"image/") {
			return fmt.Errorf("请上传本地%s图片，或选择官方模特", source.role)
		}
		content, _, err := caseImageBytes(value)
		if err != nil {
			return fmt.Errorf("%s图片无效：%w", source.role, err)
		}
		if _, _, err := image.DecodeConfig(bytes.NewReader(content)); err != nil {
			return fmt.Errorf("%s图片无法解码，请重新上传", source.role)
		}
	}
	return nil
}

func tryonDisplayPosePrompt(id string) string {
	switch id {
	case "front":
		return "模特正对镜头自然站立，双脚平稳落地，肩膀放松，双臂自然垂在身体两侧，手部放松，清楚呈现衣服正面和整体版型。"
	case "side":
		return "模特身体轻轻转向一侧，头部与身体朝向一致，肩膀放松，双脚自然站稳，双臂放松垂于身体两侧，清楚呈现衣服正面与侧面的版型轮廓。"
	case "back":
		return "模特背向镜头自然站立，头部与身体朝向一致，肩膀放松，双臂自然垂在身体两侧，清楚呈现衣服背面的版型。背部款式依据上传的背面服装参考图呈现；没有背面参考时不凭空添加背部图案、文字或设计细节。"
	case "walking":
		return "模特朝镜头自然迈出一小步，双臂随着步伐轻轻摆动，身体姿态舒展，呈现衣服行走时的整体穿着状态和自然垂感。"
	}
	return ""
}

func tryonPrompt(inputs map[string]any) string {
	parts := []string{
		"生成一张真实服装电商照片。将指定商品穿到指定模特身上，服装一致性与人物身份优先于场景美化。",
		"不要拼图、并排展示输入图、添加水印或凭空添加配饰。不要采用服装参考图中其他人的身份。",
		"服装参考可为平铺图、挂拍图或穿着图，各张图片只提取其指定的目标服装，不复制参考图中人物的面容、发型、肤色、体型、动作或背景。",
	}
	roles := []string{}
	for _, source := range tryonImageSources {
		if stringInput(inputs, source.key) != "" {
			roles = append(roles, fmt.Sprintf("图%d为%s：%s", len(roles)+1, source.role, source.description))
		}
	}
	parts = append(parts, "输入图片顺序："+strings.Join(roles, "；")+"。")
	if stringInput(inputs, "topImageUrl") == "" && stringInput(inputs, "onePieceImageUrl") == "" {
		parts = append(parts, "保持模特原有上装及其细节不变。")
	}
	if stringInput(inputs, "bottomImageUrl") == "" && stringInput(inputs, "onePieceImageUrl") == "" {
		parts = append(parts, "保持模特原有下装及其细节不变。")
	}
	if stringInput(inputs, "poseMode") == "preset" {
		parts = append(parts, "展示姿势："+tryonDisplayPosePrompt(stringInput(inputs, "poseId"))+"人物身份与体型仍以模特图为准，不沿用模特照片中与所选展示姿势冲突的动作。")
	} else if stringInput(inputs, "poseImageUrl") != "" && (stringInput(inputs, "poseMode") == "reference" || stringInput(inputs, "poseMode") == "library") {
		parts = append(parts, "根据姿势图调整模特动作，身份与体型仍以模特图为准，处理自然的手臂、衣袖与衣摆遮挡。")
	} else if stringInput(inputs, "poseMode") == "original" {
		parts = append(parts, "保持模特原图的身体姿势、手脚动作及身体朝向，不因换衣自行改动作。")
	}
	if stringInput(inputs, "poseMode") == "reference" && stringInput(inputs, "posePrompt") != "" {
		parts = append(parts, "自定义姿势要求（仅调整身体朝向与动作，人物身份、体型与服装来源保持不变；与姿势参考图动作冲突时以此描述为准）："+stringInput(inputs, "posePrompt"))
	}
	switch stringInput(inputs, "sceneMode") {
	case "studio":
		parts = append(parts, "背景改为纯白影棚，保留自然接地阴影，避免改变服装本色。")
	case "library":
		parts = append(parts, "参考指定场景调整环境，保持人物身份和商品细节，匹配接地阴影与光线。")
	default:
		parts = append(parts, "保持模特原图背景和环境光线，不引入服装或姿势参考图的背景。")
	}
	parts = append(parts, "构图优先遵循用户补充要求；未指定时，根据模特参考图的取景与目标服装的展示需要自然安排构图，清晰展示目标服装的关键细节。")
	if prompt := strings.TrimSpace(stringInput(inputs, "prompt")); prompt != "" {
		parts = append(parts, "可选补充要求（不得覆盖以上人物、服装及姿势来源规则）："+prompt)
	}
	return strings.Join(parts, "\n")
}
