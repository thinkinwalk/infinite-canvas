package handler

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

func buildMiniMaxH3VideoBody(payload map[string]any) ([]byte, bool) {
	if payload["content"] != nil {
		return nil, false
	}
	sizes := map[string][]string{
		"16:9": {"864x480", "1376x768", "1920x1088"},
		"9:16": {"480x864", "768x1376", "1088x1920"},
		"1:1":  {"640x640", "1024x1024", "1440x1440"},
		"2:3":  {"544x800", "832x1248", "1184x1760"},
		"3:2":  {"800x544", "1248x832", "1760x1184"},
		"3:4":  {"576x736", "896x1184", "1248x1664"},
		"4:3":  {"736x576", "1184x896", "1664x1248"},
		"21:9": {"992x416", "1568x672", "2208x960"},
	}
	ratio := jsonStringValue(payload["aspect_ratio"])
	options, ok := sizes[ratio]
	if !ok {
		return nil, false
	}
	resolution := strings.TrimSuffix(jsonStringValue(payload["resolution"]), "p")
	size := resolution
	if resolution != "2K" && resolution != "4K" {
		index, ok := map[string]int{"480": 0, "768": 1, "1080": 2}[resolution]
		if !ok {
			return nil, false
		}
		size = options[index]
	}
	seconds, err := strconv.Atoi(fmt.Sprint(payload["seconds"]))
	if err != nil || seconds < 4 || seconds > 15 || strings.TrimSpace(jsonStringValue(payload["prompt"])) == "" {
		return nil, false
	}
	// Upstream rejects size combined with aspect_ratio, megapixels or pixels.
	converted := map[string]any{"model": payload["model"], "prompt": payload["prompt"], "seconds": seconds, "size": size}
	images := []string{}
	if first := jsonURLValue(payload["image_url"]); first != "" {
		images = append(images, first)
	}
	images = append(images, jsonURLValues(payload["reference_image_urls"])...)
	if last := jsonURLValue(payload["last_frame"]); last != "" {
		images = append(images, last)
	}
	if len(images) > 0 {
		converted["images"] = images
	}
	videos := jsonURLValues(payload["reference_videos"])
	if video := jsonURLValue(payload["reference_video"]); video != "" {
		videos = append(videos, video)
	}
	if len(videos) > 0 {
		converted["reference_videos"] = videos
	}
	audios := jsonURLValues(payload["audio_urls"])
	if audio := jsonURLValue(payload["audio_url"]); audio != "" {
		audios = append(audios, audio)
	}
	if len(audios) > 0 {
		converted["reference_audios"] = audios
	}
	body, err := json.Marshal(converted)
	return body, err == nil
}
