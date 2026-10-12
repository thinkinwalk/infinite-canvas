package handler

import (
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/url"
	"os"
	"path/filepath"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
)

// Call after ownership/URL validation and before quotes, charges or predictions.
func validateWanVideoFrames(input map[string]any) error {
	var first image.Point
	for _, key := range []string{"image", "last_image"} {
		address, _ := input[key].(string)
		if address == "" {
			continue
		}
		parsed, err := url.Parse(address)
		if err != nil {
			return fmt.Errorf("首尾帧地址无效，请重新上传")
		}
		file, err := os.Open(filepath.Join(referenceMediaDir(), filepath.Base(parsed.Path)))
		if err != nil {
			return fmt.Errorf("无法读取首尾帧，请重新上传图片")
		}
		decoded, _, decodeErr := image.Decode(file)
		file.Close()
		if decodeErr != nil {
			return fmt.Errorf("无法解码首尾帧，请在视频创作台重新确认构图")
		}
		size := decoded.Bounds().Size()
		if size.X <= 0 || size.Y <= 0 || (int64(size.X)*9 != int64(size.Y)*16 && int64(size.X)*16 != int64(size.Y)*9) {
			return fmt.Errorf("Wan 首尾帧需要统一为16:9或9:16，请在视频创作台确认裁剪构图")
		}
		if key == "image" {
			first = size
		} else if size != first {
			return fmt.Errorf("首尾帧画幅或尺寸不一致，请在视频创作台重新确认构图")
		}
	}
	return nil
}
