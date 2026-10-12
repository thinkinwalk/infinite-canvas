package handler

import (
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
)

func TestWanFramesRejectUnusableOrInconsistentImages(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "test.db")}
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, width, height int) string {
		file, err := os.Create(filepath.Join(referenceMediaDir(), name))
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(file, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
			t.Fatal(err)
		}
		file.Close()
		return "https://example.com/api/media/references/" + name
	}
	landscape := write("landscape.png", 160, 90)
	portrait := write("portrait.png", 90, 160)
	extreme := write("extreme.png", 2000, 100)
	smallLandscape := write("small.png", 80, 45)
	if err := os.WriteFile(filepath.Join(referenceMediaDir(), "broken.png"), []byte("not a picture"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		name, first, last string
		accepted          bool
	}{
		{"single landscape", landscape, "", true},
		{"single portrait", portrait, "", true},
		{"matching frames", landscape, landscape, true},
		{"different orientation", landscape, portrait, false},
		{"different dimensions", landscape, smallLandscape, false},
		{"extreme ratio", extreme, "", false},
		{"corrupt image", "https://example.com/api/media/references/broken.png", "", false},
		{"missing file", "https://example.com/api/media/references/missing.png", "", false},
	} {
		t.Run(item.name, func(t *testing.T) {
			input := map[string]any{"image": item.first}
			if item.last != "" {
				input["last_image"] = item.last
			}
			err := validateWanVideoFrames(input)
			if (err == nil) != item.accepted {
				t.Fatalf("accepted=%v, error=%v", item.accepted, err)
			}
		})
	}
}
