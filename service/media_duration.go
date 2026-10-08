package service

import (
	"context"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// Probe uploaded local files only; browser-supplied durations are never used for billing.
func ProbeMediaDuration(ctx context.Context, path string) float64 {
	binary := os.Getenv("FFPROBE_PATH")
	if binary == "" {
		binary = "ffprobe"
	}
	output, err := exec.CommandContext(ctx, binary, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path).Output()
	if err != nil {
		return 0
	}
	duration, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil || duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return 0
	}
	return duration
}
