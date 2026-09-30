package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/disintegration/imaging"
	"github.com/google/uuid"
)

func caseImageBytes(value any) ([]byte, string, error) {
	uri, _ := value.(string)
	if strings.HasPrefix(uri, "https://") {
		if !validTryonLibraryURL(uri, "模特") && !validTryonLibraryURL(uri, "场景") {
			return nil, "", errors.New("素材不在官方素材库中")
		}
		request, err := http.NewRequest(http.MethodGet, uri, nil)
		if err != nil {
			return nil, "", errors.New("图片地址无效")
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil || response == nil {
			return nil, "", errors.New("参考图片下载失败")
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, "", errors.New("参考图片下载失败")
		}
		content, err := io.ReadAll(io.LimitReader(response.Body, 20<<20+1))
		if err != nil || len(content) == 0 || len(content) > 20<<20 {
			return nil, "", errors.New("参考图片为空或超过 20MB")
		}
		return content, response.Header.Get("Content-Type"), nil
	}
	if !strings.HasPrefix(uri, "data:image/") {
		return nil, "", errors.New("请重新上传本地图片")
	}
	parts := strings.SplitN(uri, ",", 2)
	if len(parts) != 2 || !strings.HasSuffix(parts[0], ";base64") {
		return nil, "", errors.New("图片数据格式无效")
	}
	mime := strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
		return nil, "", errors.New("图片格式不支持")
	}
	data, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil || len(data) == 0 || len(data) > 20<<20 {
		return nil, "", errors.New("图片数据无效或超过 20MB")
	}
	return data, mime, nil
}

func firstNonEmptyInput(inputs map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(stringInput(inputs, key)); value != "" {
			return value
		}
	}
	return ""
}

func validTryonLibraryURL(value, role string) bool {
	models, scenes := tryonLibrary()
	if role == "模特" {
		for _, model := range models {
			if model.URL == value {
				return true
			}
		}
	}
	if role == "场景" {
		for _, scene := range scenes {
			if scene.URL == value {
				return true
			}
		}
	}
	return false
}

func saveCasePNG(data []byte) (string, error) {
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		return "", err
	}
	name := uuid.NewString() + ".png"
	if err := os.WriteFile(filepath.Join(referenceMediaDir(), name), data, 0o644); err != nil {
		return "", err
	}
	return "/api/media/references/" + name, nil
}

func executeCaseEdit(r *http.Request, user model.AuthUser, runtime caseRuntimeConfig, prompt string, inputs map[string]any) (map[string]any, error) {
	tryonSources := []struct {
		key  string
		role string
	}{
		{"topImageUrl", "上装"},
		{"bottomImageUrl", "下装"},
		{"modelImageUrl", "模特"},
		{"sceneImageUrl", "场景"},
	}
	var original []byte
	var err error
	if strings.TrimSpace(stringInput(inputs, "topImageUrl")) != "" || strings.TrimSpace(stringInput(inputs, "bottomImageUrl")) != "" || strings.TrimSpace(stringInput(inputs, "modelImageUrl")) != "" || strings.TrimSpace(stringInput(inputs, "sceneImageUrl")) != "" {
		first := firstNonEmptyInput(inputs, "topImageUrl", "bottomImageUrl")
		if strings.HasPrefix(first, "http") {
			return nil, errors.New("请上传本地服装图片")
		}
		original, _, err = caseImageBytes(first)
	} else {
		original, _, err = caseImageBytes(inputs["imageUrl"])
	}
	if err != nil {
		return nil, err
	}
	var mask []byte
	if runtime.Operation == "inpaint" {
		mask, _, err = caseImageBytes(inputs["maskUrl"])
		if err != nil {
			return nil, errors.New("请先涂抹需要修改的区域")
		}
	}
	imageSize, _, err := image.DecodeConfig(bytes.NewReader(original))
	if err != nil {
		return nil, errors.New("原图无法解码")
	}
	decoded, err := imaging.Decode(bytes.NewReader(original))
	if err != nil {
		return nil, errors.New("原图无法解码")
	}
	var normalized bytes.Buffer
	if err := png.Encode(&normalized, decoded); err != nil {
		return nil, errors.New("原图转换失败")
	}
	original = normalized.Bytes()
	if len(mask) > 0 {
		maskImage, maskErr := imaging.Decode(bytes.NewReader(mask))
		if maskErr == nil {
			var normalizedMask bytes.Buffer
			_ = png.Encode(&normalizedMask, maskImage)
			mask = normalizedMask.Bytes()
		}
		maskSize, _, maskErr := image.DecodeConfig(bytes.NewReader(mask))
		if maskErr != nil || maskSize.Width != imageSize.Width || maskSize.Height != imageSize.Height {
			return nil, errors.New("蒙版尺寸必须与原图一致")
		}
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range map[string]string{"model": runtime.Model, "prompt": prompt, "size": runtime.Size, "quality": runtime.Quality} {
		if value != "" {
			_ = writer.WriteField(key, value)
		}
	}
	if inputs["background"] == "透明" {
		_ = writer.WriteField("background", "transparent")
		_ = writer.WriteField("output_format", "png")
	}
	imageField := "image"
	if len(tryonSources) > 0 && (strings.TrimSpace(stringInput(inputs, "topImageUrl")) != "" || strings.TrimSpace(stringInput(inputs, "bottomImageUrl")) != "" || strings.TrimSpace(stringInput(inputs, "modelImageUrl")) != "" || strings.TrimSpace(stringInput(inputs, "sceneImageUrl")) != "") {
		imageField = "image[]"
		for _, source := range tryonSources {
			value := strings.TrimSpace(stringInput(inputs, source.key))
			if value == "" {
				continue
			}
			if strings.HasPrefix(value, "http") && !validTryonLibraryURL(value, source.role) {
				return nil, fmt.Errorf("%s素材不在官方素材库中", source.role)
			}
			content, _, sourceErr := caseImageBytes(value)
			if sourceErr != nil {
				return nil, fmt.Errorf("%s图片无效：%w", source.role, sourceErr)
			}
			decoded, decodeErr := imaging.Decode(bytes.NewReader(content))
			if decodeErr != nil {
				return nil, fmt.Errorf("%s图片无法解码", source.role)
			}
			var normalized bytes.Buffer
			if encodeErr := png.Encode(&normalized, decoded); encodeErr != nil {
				return nil, fmt.Errorf("%s图片转换失败", source.role)
			}
			imagePart, _ := writer.CreateFormFile(imageField, source.key+".png")
			_, _ = imagePart.Write(normalized.Bytes())
		}
	} else {
		imagePart, _ := writer.CreateFormFile(imageField, "source.png")
		_, _ = imagePart.Write(original)
	}
	if references, ok := inputs["referenceImageUrls"].([]any); ok {
		for index, reference := range references {
			refBytes, _, refErr := caseImageBytes(reference)
			if refErr != nil {
				return nil, fmt.Errorf("第 %d 张参考图无效：%w", index+1, refErr)
			}
			refImage, decodeErr := imaging.Decode(bytes.NewReader(refBytes))
			if decodeErr != nil {
				return nil, fmt.Errorf("第 %d 张参考图无法解码", index+1)
			}
			var refPNG bytes.Buffer
			if encodeErr := png.Encode(&refPNG, refImage); encodeErr != nil {
				return nil, errors.New("参考图转换失败")
			}
			part, _ := writer.CreateFormFile(imageField, fmt.Sprintf("reference-%d.png", index+1))
			_, _ = part.Write(refPNG.Bytes())
		}
	}
	if len(mask) > 0 {
		maskPart, _ := writer.CreateFormFile("mask", "mask.png")
		_, _ = maskPart.Write(mask)
	}
	_ = writer.Close()
	request := httptest.NewRequest(http.MethodPost, "/images/edits", &body).WithContext(service.WithUser(r.Context(), user))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()
	proxyAIRequest(recorder, request, "/images/edits")
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil || recorder.Code >= http.StatusBadRequest || payload["error"] != nil || payload["code"] == float64(1) {
		if message, ok := payload["msg"].(string); ok && message != "" {
			return nil, errors.New(message)
		}
		return nil, errors.New("局部改图失败，请检查图片编辑模型配置")
	}
	if data, ok := payload["data"].(map[string]any); ok {
		return data, nil
	}
	return payload, nil
}

func runPrintFile(inputs map[string]any) (map[string]any, error) {
	content, _, err := caseImageBytes(inputs["imageUrl"])
	if err != nil {
		return nil, err
	}
	source, err := imaging.Decode(bytes.NewReader(content))
	if err != nil {
		return nil, errors.New("原图无法解码")
	}
	wmm, err := casePositiveNumber(inputs["widthMm"], 210)
	if err != nil {
		return nil, errors.New("成品宽度无效")
	}
	hmm, err := casePositiveNumber(inputs["heightMm"], 297)
	if err != nil {
		return nil, errors.New("成品高度无效")
	}
	dpi, err := casePositiveNumber(inputs["dpi"], 300)
	if err != nil {
		return nil, errors.New("DPI 无效")
	}
	width := int(wmm/25.4*dpi + 0.5)
	height := int(hmm/25.4*dpi + 0.5)
	if width < 1 || height < 1 || width > 8000 || height > 8000 {
		return nil, errors.New("成品像素尺寸超出支持范围（单边最大 8000px）")
	}
	fit, _ := inputs["fit"].(string)
	var output image.Image
	if fit == "填满裁切" {
		output = imaging.Fill(source, width, height, imaging.Center, imaging.Lanczos)
	} else {
		output = imaging.Fit(source, width, height, imaging.Lanczos)
		output = imaging.PasteCenter(imaging.New(width, height, color.White), output)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, output); err != nil {
		return nil, err
	}
	physical := withPNGResolution(encoded.Bytes(), int(dpi))
	url, err := saveCasePNG(physical)
	if err != nil {
		return nil, errors.New("印刷文件保存失败")
	}
	return map[string]any{"data": []any{map[string]any{"url": url}}, "width": width, "height": height, "dpi": int(dpi), "widthMm": wmm, "heightMm": hmm}, nil
}

func runUpscaleLocal(inputs map[string]any) (map[string]any, error) {
	content, _, err := caseImageBytes(inputs["imageUrl"])
	if err != nil {
		return nil, err
	}
	source, err := imaging.Decode(bytes.NewReader(content))
	if err != nil {
		return nil, errors.New("原图无法解码")
	}
	scale := 2
	if value := fmt.Sprint(inputs["scale"]); value == "4" || value == "4x" {
		scale = 4
	}
	width := source.Bounds().Dx() * scale
	height := source.Bounds().Dy() * scale
	if width > 8000 || height > 8000 {
		return nil, errors.New("放大后的像素尺寸超出支持范围（单边最大 8000px）")
	}
	output := imaging.Resize(source, width, height, imaging.Lanczos)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, output); err != nil {
		return nil, err
	}
	url, err := saveCasePNG(encoded.Bytes())
	if err != nil {
		return nil, errors.New("高清图片保存失败")
	}
	return map[string]any{"data": []any{map[string]any{"url": url}}, "scale": scale, "width": width, "height": height}, nil
}

type replicatePrediction struct {
	Status string `json:"status"`
	Output any    `json:"output"`
	Error  string `json:"error"`
	URLs   struct {
		Get string `json:"get"`
	} `json:"urls"`
}

func runReplicateTool(r *http.Request, operation string, inputs map[string]any) (map[string]any, error) {
	token, err := service.ReplicateAPIKey()
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, errors.New("专用图像处理服务未配置，请联系管理员在私有配置中设置 Replicate API Token")
	}
	sourceBytes, sourceMime, err := caseImageBytes(inputs["imageUrl"])
	if err != nil {
		return nil, err
	}
	if operation == "cutout-replicate" {
		if _, _, err := cutoutPreferences(inputs); err != nil {
			return nil, err
		}
	}
	modelID := "men1scus/birefnet"
	arguments := map[string]any{"image": "data:" + sourceMime + ";base64," + base64.StdEncoding.EncodeToString(sourceBytes)}
	if operation == "upscale-replicate" {
		modelID = "nightmareai/real-esrgan"
		scale := 2
		if inputs["scale"] == "4x" {
			scale = 4
		}
		arguments["scale"] = scale
		arguments["face_enhance"] = inputs["direction"] == "人像"
	}
	modelRequest, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://api.replicate.com/v1/models/"+modelID, nil)
	modelRequest.Header.Set("Authorization", "Bearer "+token)
	modelResponse, err := aiHTTPClient.Do(modelRequest)
	if err != nil {
		return nil, errors.New("专用模型连接失败")
	}
	var modelInfo struct {
		LatestVersion struct {
			ID string `json:"id"`
		} `json:"latest_version"`
	}
	decodeErr := json.NewDecoder(modelResponse.Body).Decode(&modelInfo)
	_ = modelResponse.Body.Close()
	if modelResponse.StatusCode >= 400 || decodeErr != nil || modelInfo.LatestVersion.ID == "" {
		return nil, errors.New("专用模型版本读取失败，请检查服务凭据")
	}
	body, _ := json.Marshal(map[string]any{"version": modelInfo.LatestVersion.ID, "input": arguments})
	create, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, "https://api.replicate.com/v1/predictions", bytes.NewReader(body))
	create.Header.Set("Authorization", "Bearer "+token)
	create.Header.Set("Content-Type", "application/json")
	create.Header.Set("Prefer", "wait")
	response, err := aiHTTPClient.Do(create)
	if err != nil {
		return nil, errors.New("专用模型请求失败")
	}
	var prediction replicatePrediction
	decodeErr = json.NewDecoder(response.Body).Decode(&prediction)
	_ = response.Body.Close()
	if response.StatusCode >= 400 || decodeErr != nil {
		return nil, errors.New("专用模型请求被拒绝，请检查服务配置")
	}
	for prediction.Status != "succeeded" && prediction.Status != "failed" && prediction.Status != "canceled" {
		if prediction.URLs.Get == "" {
			return nil, errors.New("专用模型未返回任务地址")
		}
		select {
		case <-r.Context().Done():
			return nil, r.Context().Err()
		case <-time.After(2 * time.Second):
		}
		query, err := http.NewRequestWithContext(r.Context(), http.MethodGet, prediction.URLs.Get, nil)
		if err != nil || !strings.HasPrefix(prediction.URLs.Get, "https://api.replicate.com/v1/predictions/") {
			return nil, errors.New("专用模型任务地址无效")
		}
		query.Header.Set("Authorization", "Bearer "+token)
		poll, err := aiHTTPClient.Do(query)
		if err != nil {
			return nil, errors.New("专用模型任务查询失败")
		}
		decodeErr = json.NewDecoder(poll.Body).Decode(&prediction)
		_ = poll.Body.Close()
		if poll.StatusCode >= 400 || decodeErr != nil {
			return nil, errors.New("专用模型任务查询失败")
		}
	}
	if prediction.Status != "succeeded" {
		return nil, fmt.Errorf("专用模型处理失败：%s", prediction.Error)
	}
	return saveReplicateOutput(r, operation, sourceBytes, inputs, prediction.Output)
}

func saveReplicateOutput(r *http.Request, operation string, sourceBytes []byte, inputs map[string]any, predictionOutput any) (map[string]any, error) {
	outputURL := ""
	switch output := predictionOutput.(type) {
	case string:
		outputURL = output
	case []any:
		if len(output) > 0 {
			outputURL, _ = output[0].(string)
		}
	}
	parsed, err := url.Parse(outputURL)
	if err != nil || parsed.Scheme != "https" || (parsed.Hostname() != "replicate.delivery" && !strings.HasSuffix(parsed.Hostname(), ".replicate.delivery")) {
		return nil, errors.New("专用模型未返回可下载的图片")
	}
	download, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, outputURL, nil)
	resultResponse, err := aiHTTPClient.Do(download)
	if err != nil {
		return nil, errors.New("专用模型图片下载失败")
	}
	resultBytes, readErr := io.ReadAll(io.LimitReader(resultResponse.Body, 30<<20))
	_ = resultResponse.Body.Close()
	if resultResponse.StatusCode >= 400 || readErr != nil || len(resultBytes) == 0 {
		return nil, errors.New("专用模型图片下载失败")
	}
	resultImage, err := imaging.Decode(bytes.NewReader(resultBytes))
	if err != nil {
		return nil, errors.New("专用模型结果不是有效图片")
	}
	if operation == "cutout-replicate" {
		resultImage, err = finishCutout(sourceBytes, resultImage, inputs)
		if err != nil {
			return nil, err
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, resultImage); err != nil {
		return nil, errors.New("处理结果保存失败")
	}
	storedURL, err := saveCasePNG(encoded.Bytes())
	if err != nil {
		return nil, errors.New("处理结果保存失败")
	}
	return map[string]any{"data": []any{map[string]any{"url": storedURL}}, "width": resultImage.Bounds().Dx(), "height": resultImage.Bounds().Dy()}, nil
}

func finishCutout(sourceBytes []byte, result image.Image, inputs map[string]any) (image.Image, error) {
	sigma, background, err := cutoutPreferences(inputs)
	if err != nil {
		return nil, err
	}
	source, err := imaging.Decode(bytes.NewReader(sourceBytes))
	if err != nil {
		return nil, errors.New("原图无法解码")
	}
	width, height := source.Bounds().Dx(), source.Bounds().Dy()
	result = imaging.Resize(result, width, height, imaging.Lanczos)
	transparent := image.NewNRGBA(image.Rect(0, 0, width, height))
	mask := imaging.New(width, height, color.White)
	// BiRefNet may return an alpha PNG or a grayscale mask; preserve original pixels in either case.
	hasAlpha := false
	for y := 0; y < height && !hasAlpha; y++ {
		for x := 0; x < width; x++ {
			if color.NRGBAModel.Convert(result.At(x, y)).(color.NRGBA).A < 255 {
				hasAlpha = true
				break
			}
		}
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			pixel := color.NRGBAModel.Convert(result.At(x, y)).(color.NRGBA)
			alpha := pixel.A
			if !hasAlpha {
				alpha = color.GrayModel.Convert(result.At(x, y)).(color.Gray).Y
			}
			mask.SetNRGBA(x, y, color.NRGBA{R: alpha, G: alpha, B: alpha, A: 255})
		}
	}
	if sigma > 0 {
		mask = imaging.Blur(mask, sigma)
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			original := color.NRGBAModel.Convert(source.At(x, y)).(color.NRGBA)
			original.A = uint8(uint16(original.A) * uint16(mask.NRGBAAt(x, y).R) / 255)
			transparent.SetNRGBA(x, y, original)
		}
	}
	if background == nil {
		return transparent, nil
	}
	output := imaging.New(width, height, background)
	draw.Draw(output, output.Bounds(), transparent, image.Point{}, draw.Over)
	return output, nil
}

func cutoutPreferences(inputs map[string]any) (float64, color.Color, error) {
	sigma := 0.0
	switch inputs["feather"] {
	case nil, "", "关":
	case "弱":
		sigma = 1
	case "强":
		sigma = 2
	default:
		return 0, nil, errors.New("请选择有效的边缘羽化选项")
	}
	switch inputs["background"] {
	case nil, "", "透明":
		return sigma, nil, nil
	case "白底":
		return sigma, color.White, nil
	case "纯色":
		hex, _ := inputs["backgroundColor"].(string)
		if len(hex) != 7 || hex[0] != '#' {
			return 0, nil, errors.New("请选择有效的背景颜色")
		}
		value, err := strconv.ParseUint(hex[1:], 16, 24)
		if err != nil {
			return 0, nil, errors.New("请选择有效的背景颜色")
		}
		return sigma, color.NRGBA{R: uint8(value >> 16), G: uint8(value >> 8), B: uint8(value), A: 255}, nil
	default:
		return 0, nil, errors.New("请选择有效的输出背景")
	}
}

func casePositiveNumber(value any, fallback float64) (float64, error) {
	if value == nil || value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseFloat(fmt.Sprint(value), 64)
	if err != nil || parsed <= 0 || parsed > 2000 {
		return 0, errors.New("无效数值")
	}
	return parsed, nil
}

func withPNGResolution(data []byte, dpi int) []byte {
	const signatureLength = 8
	if len(data) < signatureLength+12 || string(data[12:16]) != "IHDR" {
		return data
	}
	chunkLength := int(binary.BigEndian.Uint32(data[8:12]))
	insertAt := signatureLength + 12 + chunkLength
	if insertAt > len(data) {
		return data
	}
	chunk := make([]byte, 21)
	binary.BigEndian.PutUint32(chunk[:4], 9)
	copy(chunk[4:8], "pHYs")
	ppm := uint32(float64(dpi)/0.0254 + 0.5)
	binary.BigEndian.PutUint32(chunk[8:12], ppm)
	binary.BigEndian.PutUint32(chunk[12:16], ppm)
	chunk[16] = 1
	binary.BigEndian.PutUint32(chunk[17:21], crc32.ChecksumIEEE(chunk[4:17]))
	return append(append(append([]byte{}, data[:insertAt]...), chunk...), data[insertAt:]...)
}
