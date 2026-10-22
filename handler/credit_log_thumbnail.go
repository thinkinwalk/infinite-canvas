package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/service"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const creditLogThumbnailWidth = 480

func copyNativeAIImageResponse(w http.ResponseWriter, upstreamURL string, response *http.Response, creditLogID string, onFailure func()) {
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest || strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") {
		copyNativeAIResponses(w, upstreamURL, response, onFailure)
		return
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		log.Printf("AI image response body read failed: url=%s err=%v", upstreamURL, err)
		if onFailure != nil {
			onFailure()
		}
		return
	}
	if creditLogID != "" && response.StatusCode < http.StatusBadRequest {
		if err := saveCreditLogThumbnail(creditLogID, body); err != nil {
			log.Printf("AI image thumbnail save failed: log=%s err=%v", creditLogID, err)
		}
	}
	for key, values := range response.Header {
		if key == "Content-Length" {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(body)
}

func saveCreditLogThumbnail(id string, responseBody []byte) error {
	var payload struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
		} `json:"data"`
		Output []struct {
			Type   string `json:"type"`
			Result string `json:"result"`
		} `json:"output"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return err
	}
	encoded := ""
	if len(payload.Data) > 0 {
		encoded = payload.Data[0].B64JSON
	}
	if encoded == "" {
		for _, item := range payload.Output {
			if item.Type == "image_generation_call" && item.Result != "" {
				encoded = item.Result
				break
			}
		}
	}
	if encoded == "" {
		return nil
	}
	imageBytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return err
	}
	source, _, err := image.Decode(bytes.NewReader(imageBytes))
	if err != nil {
		return err
	}
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if width <= 0 || height <= 0 {
		return nil
	}
	dir := creditLogImageDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	name := creditLogThumbnailName(id)
	if err := os.WriteFile(filepath.Join(dir, name+".original"), imageBytes, 0644); err != nil {
		log.Printf("AI image original save failed: log=%s err=%v", id, err)
	}
	scale := float64(creditLogThumbnailWidth) / float64(max(width, height))
	target := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(width)*scale)), max(1, int(float64(height)*scale))))
	draw.CatmullRom.Scale(target, target.Bounds(), source, bounds, draw.Over, nil)
	var encodedThumbnail bytes.Buffer
	if err := jpeg.Encode(&encodedThumbnail, target, &jpeg.Options{Quality: 78}); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name), encodedThumbnail.Bytes(), 0644)
}

func creditLogImageDir() string {
	if config.Cfg.CreditLogThumbnailDir != "" {
		return config.Cfg.CreditLogThumbnailDir
	}
	return "data/credit-log-thumbnails"
}

func creditLogThumbnailName(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:]) + ".jpg"
}

func AdminCreditLogThumbnail(w http.ResponseWriter, r *http.Request, id string) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.Role != "admin" {
		Fail(w, "未登录或权限不足")
		return
	}
	name := creditLogThumbnailName(id)
	if r.URL.Query().Get("original") == "1" {
		name += ".original"
	}
	file, err := os.Open(filepath.Join(creditLogImageDir(), name))
	if err != nil {
		if os.IsNotExist(err) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		FailError(w, err)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		FailError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, info.ModTime(), file)
}
