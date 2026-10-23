package service

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPrepareModelReferenceVideo(t *testing.T) {
	ffmpeg := os.Getenv("FFMPEG_PATH")
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	ffprobe := os.Getenv("FFPROBE_PATH")
	if ffprobe == "" {
		ffprobe = "ffprobe"
	}
	if _, err := exec.LookPath(ffmpeg); err != nil {
		t.Skip("FFmpeg required for actual model-reference compression")
	}
	if _, err := exec.LookPath(ffprobe); err != nil {
		t.Skip("FFprobe required for actual model-reference compression")
	}
	source, target := filepath.Join(t.TempDir(), "source.mp4"), filepath.Join(t.TempDir(), "model.mp4")
	if output, err := exec.Command(ffmpeg, "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=15:duration=2",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-crf", "18", "-c:a", "aac", source).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	before, _ := os.Stat(source)
	if err := PrepareModelReferenceVideo(context.Background(), source, target, 300<<10); err != nil {
		t.Fatal(err)
	}
	prepared, err := os.Stat(target)
	if err != nil || prepared.Size() <= 0 || prepared.Size() > 300<<10 {
		t.Fatalf("invalid prepared video: %v %v", prepared, err)
	}
	after, _ := os.Stat(source)
	if before.Size() != after.Size() {
		t.Fatal("original changed during model input preparation")
	}
	duration := ProbeMediaDuration(context.Background(), target)
	if duration < 1.9 || duration > 2.1 {
		t.Fatalf("timeline changed: %v", duration)
	}
}
