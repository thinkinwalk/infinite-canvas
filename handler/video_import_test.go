package handler

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func TestImportVideoURLValidMP4(t *testing.T) {
	path := os.Getenv("VIDEO_IMPORT_TEST_MP4")
	if path == "" {
		t.Skip("set VIDEO_IMPORT_TEST_MP4 to a local H.264 MP4 fixture")
	}
	binary := os.Getenv("FFPROBE_PATH")
	if binary == "" {
		binary = "ffprobe"
	}
	if _, err := exec.LookPath(binary); err != nil {
		t.Fatal(err)
	}
	temp := t.TempDir()
	t.Setenv("TMP", temp)
	t.Setenv("TMPDIR", temp)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	source := service.VideoImportSource{Platform: "wxchannels", Title: "测试视频", Author: "作者", SourceURL: "https://weixin.qq.com/sph/test"}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/video/import-url", nil)
	recorder := httptest.NewRecorder()
	remote := &http.Response{StatusCode: http.StatusOK, ContentLength: int64(len(data)), Body: io.NopCloser(strings.NewReader(string(data)))}
	serveImportedVideo(recorder, request, request.Context(), remote, source)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "video/mp4" || recorder.Body.String() != string(data) {
		t.Fatalf("invalid video response: status=%d headers=%v bytes=%d", recorder.Code, recorder.Header(), recorder.Body.Len())
	}
	encoded, err := base64.StdEncoding.DecodeString(recorder.Header().Get("X-Video-Import"))
	var actual service.VideoImportSource
	if err != nil || json.Unmarshal(encoded, &actual) != nil || actual != source {
		t.Fatal("missing video provenance")
	}
	files, err := filepath.Glob(filepath.Join(temp, "canvas-video-import-*.mp4"))
	if err != nil || len(files) != 0 {
		t.Fatalf("temporary files not cleaned up: %v %v", files, err)
	}
}

type failedVideoImportReader struct{}

func (failedVideoImportReader) Read([]byte) (int, error) {
	return 0, errors.New("download interrupted")
}

func TestImportVideoURLDownloadFailuresCleanUp(t *testing.T) {
	temp := t.TempDir()
	t.Setenv("TMP", temp)
	t.Setenv("TMPDIR", temp)
	for _, test := range []struct {
		name, message string
		body          io.Reader
		length        int64
		status        int
	}{
		{"upstream-status", "下载失败", strings.NewReader(""), 0, http.StatusForbidden},
		{"declared-oversize", "50", strings.NewReader(""), referenceVideoMaxBytes + 1, http.StatusOK},
		{"stream-oversize", "50", io.LimitReader(repeatingVideoImportReader{}, referenceVideoMaxBytes+1), -1, http.StatusOK},
		{"broken-stream", "下载中断", failedVideoImportReader{}, -1, http.StatusOK},
		{"empty", "下载中断", strings.NewReader(""), 0, http.StatusOK},
		{"not-video", "MP4", strings.NewReader("<html>not a video</html>"), -1, http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/video/import-url", nil)
			recorder := httptest.NewRecorder()
			remote := &http.Response{StatusCode: test.status, ContentLength: test.length, Body: io.NopCloser(test.body)}
			serveImportedVideo(recorder, request, request.Context(), remote, service.VideoImportSource{Platform: "wxchannels"})
			var payload response
			if json.Unmarshal(recorder.Body.Bytes(), &payload) != nil || payload.Code != 1 || !strings.Contains(payload.Msg, test.message) {
				t.Fatalf("unexpected failure: %s", recorder.Body.String())
			}
			if recorder.Header().Get("Content-Type") != "application/json" || recorder.Header().Get("X-Video-Import") != "" {
				t.Fatal("failure was presented as a successful video")
			}
			files, err := filepath.Glob(filepath.Join(os.TempDir(), "canvas-video-import-*.mp4"))
			if err != nil || len(files) != 0 {
				t.Fatalf("temporary files not cleaned up: %v %v", files, err)
			}
		})
	}
}

type repeatingVideoImportReader struct{}

func (repeatingVideoImportReader) Read(buffer []byte) (int, error) {
	for i := range buffer {
		buffer[i] = 'x'
	}
	return len(buffer), nil
}

func TestImportVideoURLValidation(t *testing.T) {
	original := config.Cfg
	t.Cleanup(func() { config.Cfg = original })
	config.Cfg.VideoImportWXEndpoint = ""
	for _, test := range []struct {
		name, body, message string
		authenticated       bool
	}{
		{"anonymous", `{"url":"https://weixin.qq.com/sph/a"}`, "请登录", false},
		{"invalid-json", `{`, "有效", true},
		{"invalid-url", `{"url":"https://localhost/a"}`, "暂不支持", true},
		{"douyin", `{"url":"https://v.douyin.com/a"}`, "尚未接入", true},
		{"xiaohongshu", `{"url":"https://xhslink.com/a"}`, "尚未接入", true},
		{"missing-config", `{"url":"https://weixin.qq.com/sph/a"}`, "未配置", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/video/import-url", strings.NewReader(test.body))
			if test.authenticated {
				request = request.WithContext(service.WithUser(context.Background(), model.AuthUser{ID: "video-import-test"}))
			}
			recorder := httptest.NewRecorder()
			ImportVideoURL(recorder, request)
			var payload response
			if json.Unmarshal(recorder.Body.Bytes(), &payload) != nil || payload.Code != 1 || !strings.Contains(payload.Msg, test.message) {
				t.Fatalf("unexpected response: %s", recorder.Body.String())
			}
			if recorder.Header().Get("Cache-Control") != "private, no-store" || recorder.Header().Get("X-Video-Import") != "" {
				t.Fatal("unsafe response headers")
			}
			if !test.authenticated && recorder.Code != http.StatusUnauthorized {
				t.Fatal("anonymous request was not rejected")
			}
		})
	}
}
