package handler

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

func TestSaveReplicateMediaAcceptsSingleOutputURLArray(t *testing.T) {
	previousConfig, previousClient := config.Cfg, aiHTTPClient
	t.Cleanup(func() { config.Cfg, aiHTTPClient = previousConfig, previousClient })
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "app.db")
	config.Cfg.StorageDriver = "sqlite"
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"video/mp4"}},
			Body:       io.NopCloser(strings.NewReader("test-video")),
			Request:    request,
		}, nil
	})}
	task := &model.ReplicateTask{
		ID:         "sam-single-mask-video",
		Operation:  "track-mask",
		OutputURL:  "https://replicate.delivery/test-mask.mp4",
		OutputURLs: `["https://replicate.delivery/test-mask.mp4"]`,
	}
	if err := saveReplicateMedia(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	if task.MimeType != "video/mp4" || task.ResultFile == "" {
		t.Fatalf("unexpected saved media metadata: file=%q mime=%q", task.ResultFile, task.MimeType)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(config.Cfg.DatabaseDSN), "replicate-results", task.ResultFile)); err != nil {
		t.Fatalf("saved media does not exist: %v", err)
	}
}

func TestSaveReplicateMediaRejectsFrameSequence(t *testing.T) {
	task := &model.ReplicateTask{
		ID:         "sam-frame-sequence",
		Operation:  "track-mask",
		OutputURL:  "https://replicate.delivery/frame-1.png",
		OutputURLs: `["https://replicate.delivery/frame-1.png","https://replicate.delivery/frame-2.png"]`,
	}
	if err := saveReplicateMedia(context.Background(), task); err == nil || !strings.Contains(err.Error(), "多个掩膜文件") {
		t.Fatalf("expected frame sequence rejection, got %v", err)
	}
}
