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
	for key, fallback := range map[string]string{
		"garmentMode": "separates", "garmentPhotoType": "flat",
		"poseMode": "original", "sceneMode": "original", "framing": "original",
	} {
		value, exists := inputs[key]
		if !exists || value == "" {
			inputs[key] = fallback
		}
	}
	for key, options := range map[string][]string{
		"garmentMode":      {"separates", "one-piece"},
		"garmentPhotoType": {"flat", "person"},
		"poseMode":         {"original", "reference"},
		"sceneMode":        {"original", "studio", "library"},
		"framing":          {"original", "full", "half"},
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
	if stringInput(inputs, "framing") == "half" && (stringInput(inputs, "garmentMode") == "one-piece" || stringInput(inputs, "bottomImageUrl") != "") {
		return errors.New("下装和连体装请选择全身或原构图")
	}
	if stringInput(inputs, "poseMode") == "reference" {
		if stringInput(inputs, "poseImageUrl") == "" {
			return errors.New("请上传姿势参考照片")
		}
	} else {
		delete(inputs, "poseImageUrl")
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

func tryonPrompt(inputs map[string]any) string {
	parts := []string{
		"生成一张真实服装电商照片。将指定商品穿到指定模特身上，服装一致性与人物身份优先于场景美化。",
		"不要拼图、并排展示输入图、添加水印或凭空添加配饰。不要采用服装参考图中其他人的身份。",
	}
	roles := []string{}
	for _, source := range tryonImageSources {
		if stringInput(inputs, source.key) != "" {
			roles = append(roles, fmt.Sprintf("图%d为%s：%s", len(roles)+1, source.role, source.description))
		}
	}
	parts = append(parts, "输入图片顺序："+strings.Join(roles, "；")+"。")
	if stringInput(inputs, "garmentPhotoType") == "person" {
		parts = append(parts, "服装参考是穿着图，只提取目标服装，不复制原穿着者的皮肤、身体、动作或背景。")
	}
	if stringInput(inputs, "topImageUrl") == "" && stringInput(inputs, "onePieceImageUrl") == "" {
		parts = append(parts, "保持模特原有上装及其细节不变。")
	}
	if stringInput(inputs, "bottomImageUrl") == "" && stringInput(inputs, "onePieceImageUrl") == "" {
		parts = append(parts, "保持模特原有下装及其细节不变。")
	}
	if stringInput(inputs, "poseMode") == "reference" {
		parts = append(parts, "根据姿势图调整模特动作，身份与体型仍以模特图为准，处理自然的手臂、衣袖与衣摆遮挡。")
	} else {
		parts = append(parts, "保持模特原图的身体姿势、手脚动作及身体朝向，不因换衣自行改动作。")
	}
	switch stringInput(inputs, "sceneMode") {
	case "studio":
		parts = append(parts, "背景改为纯白影棚，保留自然接地阴影，避免改变服装本色。")
	case "library":
		parts = append(parts, "参考指定场景调整环境，保持人物身份和商品细节，匹配接地阴影与光线。")
	default:
		parts = append(parts, "保持模特原图背景和环境光线，不引入服装或姿势参考图的背景。")
	}
	switch stringInput(inputs, "framing") {
	case "full":
		parts = append(parts, "采用全身构图，完整展示头部、服装和双脚，不裁掉衣摆与裤脚。")
	case "half":
		parts = append(parts, "采用半身构图，完整展示目标上装，不裁掉领口、袖口与衣摆。")
	default:
		parts = append(parts, "保持模特原图的取景范围和镜头视角。")
	}
	if prompt := strings.TrimSpace(stringInput(inputs, "prompt")); prompt != "" {
		parts = append(parts, "可选补充要求（不得覆盖以上人物、服装及姿势来源规则）："+prompt)
	}
	return strings.Join(parts, "\n")
}
