package service

import (
	"fmt"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func ModelFeatures() ([]model.ModelFeature, error) {
	items := []model.ModelFeature{}
	add := func(id, module, label, capability string, operations ...string) {
		items = append(items, model.ModelFeature{ID: id, Module: module, Label: label, Capability: capability, Operations: operations})
	}
	add("image.generate", "图片创作", "图片生成", "image", "image")
	add("image.edit", "图片创作", "图片编辑", "image", "image")
	add("video.generate", "视频创作", "视频生成", "video", "video", "text-to-video", "image-to-video", "hailuo-video")
	add("video.script", "视频创作", "脚本与分析", "text", "text")
	add("replace.person", "内容替换", "整个人物替换", "video", "video", "replace-person")
	add("replace.head", "内容替换", "人物换脸", "video", "head-swap")
	add("replace.product", "内容替换", "商品替换", "video", "video", "video-edit")
	add("replace.background", "内容替换", "背景替换", "video", "video", "video-edit")
	add("replace.masked", "内容替换", "局部编辑", "video", "masked-edit")
	add("replace.transcribe", "内容替换", "字幕识别", "audio", "transcribe")
	add("replace.track", "内容替换", "人物跟踪", "video", "track-mask")
	add("video.upscale", "视频处理", "视频高清与补帧", "video", "upscale")
	add("video.subtitle-remove", "视频处理", "硬字幕去除", "video", "subtitle-remove")
	for _, entry := range []struct{ id, label string }{{"store-explore", "探店视频"}, {"viral-recreate", "爆款复刻"}} {
		add(entry.id+".script", entry.label, "脚本", "text", "text")
		add(entry.id+".analyze", entry.label, "素材分析", "text", "text")
		add(entry.id+".transcribe", entry.label, "素材语音识别", "audio", "transcribe")
		add(entry.id+".image", entry.label, "图片生成", "image", "image")
		add(entry.id+".video", entry.label, "视频生成", "video", "video", "text-to-video", "image-to-video", "hailuo-video")
		add(entry.id+".audio", entry.label, "配音", "audio", "audio", "speech")
	}
	for _, entry := range []struct{ id, label string }{{"digital-human", "数字人"}, {"photo-talk", "照片说话"}, {"lipsync", "视频对口型"}} {
		add(entry.id+".script", entry.label, "口播脚本", "text", "text")
		add(entry.id+".cover", entry.label, "封面生成", "image", "image")
		add(entry.id+".speech", entry.label, "配音", "audio", "speech", "audio")
		add(entry.id+".clone", entry.label, "声音克隆", "audio", "speech")
		add(entry.id+".transcribe", entry.label, "语音识别", "audio", "transcribe")
		add(entry.id+".photo", entry.label, "照片人物生成", "video", "digital-human")
		add(entry.id+".lipsync", entry.label, "视频口型生成", "video", "lipsync")
	}
	for _, entry := range []struct{ id, label string }{{"image", "图片节点"}, {"video", "视频节点"}, {"text", "文本与助手"}, {"audio", "音频节点"}} {
		operation := entry.id
		operations := []string{operation}
		if operation == "video" {
			operations = append(operations, "text-to-video", "image-to-video", "hailuo-video")
		}
		if operation == "audio" {
			operations = append(operations, "speech")
		}
		add("canvas."+entry.id, "无限画布", entry.label, entry.id, operations...)
	}
	add("prompt.enhance", "公共能力", "提示词增强", "text", "text")
	add("api.speech", "外部语音 API", "声音克隆与合成", "audio", "speech")
	db, err := repository.DB()
	if err != nil {
		return nil, err
	}
	var cases []model.CaseApp
	if err := db.Select("id", "title").Order("id").Find(&cases).Error; err != nil {
		return nil, err
	}
	for _, item := range cases {
		for _, capability := range []string{"text", "image", "video", "audio"} {
			add(CaseModelFeature(item.ID, capability), "案例 · "+item.Title, map[string]string{"text": "分析、规划与文案", "image": "图片生成与编辑", "video": "视频生成", "audio": "音频生成"}[capability], capability, capability)
		}
		add(CaseModelFeature(item.ID, "process"), "案例 · "+item.Title, "专用图像处理", "image", "cutout-replicate", "upscale-replicate")
	}
	return items, nil
}

func CaseModelFeature(id, step string) string { return "case:" + id + ":" + step }

func FindModelFeature(id string) (model.ModelFeature, error) {
	items, err := ModelFeatures()
	if err != nil {
		return model.ModelFeature{}, err
	}
	for _, item := range items {
		if item.ID == id {
			return item, nil
		}
	}
	return model.ModelFeature{}, fmt.Errorf("未登记的模型功能，请刷新配置")
}

func ManagedAdapterOperations(adapter, name string) ([]string, string, error) {
	switch adapter {
	case "text.openai":
		return []string{"text"}, "text", nil
	case "image.openai", "image.responses":
		return []string{"image"}, "image", nil
	case "audio.openai":
		return []string{"audio"}, "audio", nil
	case "video.openai", "video.relay", "video.ark", "video.sparkcine_h3", "video.wan30", "video.h3-2k", "video.minimax-h3", "video.minimax-h3-frames":
		return []string{"video"}, "video", nil
	}
	if strings.HasPrefix(adapter, "cloud:") {
		operation := strings.TrimPrefix(adapter, "cloud:")
		for _, item := range SupportedReplicateModels() {
			if item.Model == name && containsString(item.Operations, operation) {
				capability := "video"
				if operation == "speech" || operation == "transcribe" {
					capability = "audio"
				}
				if strings.HasSuffix(operation, "-replicate") {
					capability = "image"
				}
				return item.Operations, capability, nil
			}
		}
	}
	return nil, "", fmt.Errorf("模型未适配所选调用方式")
}

func sharedStrings(a, b []string) []string {
	items := []string{}
	for _, item := range a {
		if containsString(b, item) {
			items = append(items, item)
		}
	}
	return items
}
