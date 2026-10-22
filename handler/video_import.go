package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/service"
)

func ImportVideoURL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	if _, ok := service.UserFromContext(r.Context()); !ok {
		w.WriteHeader(http.StatusUnauthorized)
		Fail(w, "请登录后提取视频")
		return
	}
	var input struct {
		URL string `json:"url"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, referenceMediaMaxBytes)
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		Fail(w, "请粘贴有效的视频分享链接")
		return
	}
	platform, shareURL, err := service.VideoImportLink(input.URL)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	// Bound both parsing and downloading by the existing AI request timeout.
	ctx, cancel := context.WithTimeout(r.Context(), aiHTTPClient.Timeout)
	defer cancel()
	var resolved service.ResolvedVideoImport
	if platform == "wxchannels" {
		resolved, err = service.ResolveWeChatVideo(ctx, aiHTTPClient, config.Cfg.VideoImportWXEndpoint, config.Cfg.VideoImportWXToken, shareURL, referenceMediaMaxBytes)
	} else {
		endpoint := config.Cfg.VideoImportEndpoint
		if endpoint == "" {
			endpoint = service.DefaultVideoImportEndpoint
		}
		resolved, err = service.ResolveHostedVideo(ctx, aiHTTPClient, endpoint, shareURL, referenceMediaMaxBytes)
	}
	if err != nil {
		Fail(w, err.Error())
		return
	}
	client := service.NewVideoImportDownloadClient(aiHTTPClient.Timeout)
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, resolved.VideoURL, nil)
	if err != nil {
		Fail(w, "视频下载地址无效")
		return
	}
	remote, err := client.Do(request)
	if err != nil {
		Fail(w, "视频下载失败，请重新提取分享链接")
		return
	}
	defer remote.Body.Close()
	serveImportedVideo(w, r, ctx, remote, resolved.Source)
}

func serveImportedVideo(w http.ResponseWriter, r *http.Request, ctx context.Context, remote *http.Response, source service.VideoImportSource) {
	if remote.StatusCode != http.StatusOK {
		Fail(w, "视频下载失败，链接可能已过期或不可访问，请重新提取")
		return
	}
	if remote.ContentLength > referenceVideoMaxBytes {
		Fail(w, referenceMediaSizeMessage("video/mp4"))
		return
	}
	file, err := os.CreateTemp("", "canvas-video-import-*.mp4")
	if err != nil {
		Fail(w, "视频临时文件创建失败，请联系管理员")
		return
	}
	defer os.Remove(file.Name())
	defer file.Close()
	n, err := io.Copy(file, io.LimitReader(remote.Body, referenceVideoMaxBytes+1))
	if err != nil || n == 0 || ctx.Err() != nil {
		Fail(w, "视频下载中断，请重试，原素材已保留")
		return
	}
	if n > referenceVideoMaxBytes {
		Fail(w, referenceMediaSizeMessage("video/mp4"))
		return
	}
	header := make([]byte, 512)
	read, _ := file.ReadAt(header, 0)
	if http.DetectContentType(header[:read]) != "video/mp4" || service.ProbeMediaDuration(ctx, file.Name()) <= 0 {
		Fail(w, "提取文件不是可识别的 MP4 视频，请检查链接或联系管理员检查 FFprobe")
		return
	}
	info, err := file.Stat()
	if err != nil {
		Fail(w, "视频文件读取失败")
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		Fail(w, "视频文件读取失败")
		return
	}
	metadata, _ := json.Marshal(source)
	w.Header().Set("X-Video-Import", base64.StdEncoding.EncodeToString(metadata))
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Content-Disposition", `attachment; filename="wechat-video.mp4"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "wechat-video.mp4", info.ModTime(), file)
}
