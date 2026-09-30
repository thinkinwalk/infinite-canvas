package handler

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type caseProcessorTransport func(*http.Request) (*http.Response, error)

func (fn caseProcessorTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestReplicateOutputDeliveryHosts(t *testing.T) {
	originalClient := aiHTTPClient
	defer func() { aiHTTPClient = originalClient }()
	downloads := 0
	aiHTTPClient = &http.Client{Transport: caseProcessorTransport(func(request *http.Request) (*http.Response, error) {
		downloads++
		return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	for _, output := range []string{"https://replicate.delivery/example.png", "https://pbxt.replicate.delivery/example.png"} {
		_, err := saveReplicateOutput(httptest.NewRequest("POST", "/", nil), "cutout-replicate", nil, nil, output)
		if err == nil || err.Error() != "专用模型图片下载失败" {
			t.Fatalf("valid delivery host rejected: %v", err)
		}
	}
	if downloads != 2 {
		t.Fatalf("downloads = %d", downloads)
	}
	for _, output := range []string{"http://replicate.delivery/example.png", "https://replicate.delivery.evil.test/example.png", "https://evilreplicate.delivery/example.png", "http://127.0.0.1/example.png"} {
		if _, err := saveReplicateOutput(httptest.NewRequest("POST", "/", nil), "cutout-replicate", nil, nil, output); err == nil {
			t.Fatal("untrusted result address accepted")
		}
	}
	if downloads != 2 {
		t.Fatal("untrusted host reached downloader")
	}
}

func TestFinishCutoutPreservesPixelsAndSourceAlpha(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	source.SetNRGBA(0, 0, color.NRGBA{R: 123, G: 67, B: 34, A: 128})
	source.SetNRGBA(1, 0, color.NRGBA{R: 80, G: 90, B: 100, A: 255})
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, source)
	for _, alphaPNG := range []bool{false, true} {
		mask := image.NewNRGBA(source.Bounds())
		if alphaPNG {
			mask.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 128})
		} else {
			mask.SetNRGBA(0, 0, color.NRGBA{R: 128, G: 128, B: 128, A: 255})
			mask.SetNRGBA(1, 0, color.NRGBA{A: 255})
		}
		result, err := finishCutout(encoded.Bytes(), mask, map[string]any{"background": "透明", "feather": "关"})
		if err != nil {
			t.Fatal(err)
		}
		pixel := color.NRGBAModel.Convert(result.At(0, 0)).(color.NRGBA)
		if pixel != (color.NRGBA{R: 123, G: 67, B: 34, A: 64}) {
			t.Fatalf("source pixels or alpha changed: %#v", pixel)
		}
		if _, _, _, alpha := result.At(1, 0).RGBA(); alpha != 0 {
			t.Fatal("background must be transparent")
		}
	}
}

func TestFinishCutoutFeatherAndBackground(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 9, 9))
	mask := image.NewNRGBA(source.Bounds())
	for y := 0; y < 9; y++ {
		for x := 0; x < 9; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 20, G: 60, B: 90, A: 255})
			if x >= 4 {
				mask.SetNRGBA(x, y, color.NRGBA{A: 255})
			}
		}
	}
	var encoded bytes.Buffer
	_ = png.Encode(&encoded, source)
	previous := uint32(0)
	for _, feather := range []string{"关", "弱", "强"} {
		result, err := finishCutout(encoded.Bytes(), mask, map[string]any{"background": "透明", "feather": feather})
		if err != nil {
			t.Fatal(err)
		}
		_, _, _, alpha := result.At(2, 4).RGBA()
		if feather != "关" && alpha <= previous {
			t.Fatalf("%s feather did not soften edge", feather)
		}
		previous = alpha
	}
	for _, background := range []string{"白底", "纯色"} {
		result, err := finishCutout(encoded.Bytes(), mask, map[string]any{"background": background, "backgroundColor": "#12ab34"})
		if err != nil {
			t.Fatal(err)
		}
		want := color.NRGBA{R: 255, G: 255, B: 255, A: 255}
		if background == "纯色" {
			want = color.NRGBA{R: 18, G: 171, B: 52, A: 255}
		}
		if got := color.NRGBAModel.Convert(result.At(0, 0)).(color.NRGBA); got != want {
			t.Fatalf("background = %#v, want %#v", got, want)
		}
	}
}

func TestCutoutRejectsInvalidPreferences(t *testing.T) {
	for _, inputs := range []map[string]any{{"feather": "invalid"}, {"background": "invalid"}, {"background": "纯色", "backgroundColor": "#GGGGGG"}, {"background": "纯色", "backgroundColor": "red"}} {
		if _, _, err := cutoutPreferences(inputs); err == nil {
			t.Fatal("invalid preferences accepted")
		}
	}
}

func testCaseDataURL(t *testing.T, width, height int) string {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())
}

func TestRunUpscaleLocalUsesSelectedScale(t *testing.T) {
	result, err := runUpscaleLocal(map[string]any{"imageUrl": testCaseDataURL(t, 3, 2), "scale": "4x"})
	if err != nil {
		t.Fatal(err)
	}
	if result["width"] != 12 || result["height"] != 8 {
		t.Fatalf("unexpected dimensions: %#v", result)
	}
}

func TestPrintFileMetadataChunk(t *testing.T) {
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 10, 10))); err != nil {
		t.Fatal(err)
	}
	data := withPNGResolution(buffer.Bytes(), 300)
	found := false
	for index := 8; index+12 <= len(data); {
		length := int(data[index])<<24 | int(data[index+1])<<16 | int(data[index+2])<<8 | int(data[index+3])
		if index+12+length > len(data) {
			break
		}
		if string(data[index+4:index+8]) == "pHYs" {
			found = true
			break
		}
		index += 12 + length
	}
	if !found {
		t.Fatal("expected PNG pHYs resolution metadata")
	}
}
