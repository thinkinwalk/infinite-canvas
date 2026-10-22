package service

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVideoImportLink(t *testing.T) {
	for _, test := range []struct {
		text, platform, address string
	}{
		{"分享 https://weixin.qq.com/sph/abc?key=xyz。", "wxchannels", "https://weixin.qq.com/sph/abc?key=xyz"},
		{"https://weixin.qq.com/sph/abc#fragment", "wxchannels", "https://weixin.qq.com/sph/abc"},
		{"https://v.douyin.com/abc/", "douyin", "https://v.douyin.com/abc/"},
		{"https://xhslink.com/a/abc", "xiaohongshu", "https://xhslink.com/a/abc"},
		{"https://www.xiaohongshu.com/explore/abc", "xiaohongshu", "https://www.xiaohongshu.com/explore/abc"},
		{"https://v.kuaishou.com/abc", "other", "https://v.kuaishou.com/abc"},
		{"https://b23.tv/abc", "other", "https://b23.tv/abc"},
		{"https://www.youtube.com/watch?v=abc", "other", "https://www.youtube.com/watch?v=abc"},
		{"https://example-video.test/watch/abc", "other", "https://example-video.test/watch/abc"},
	} {
		platform, address, err := VideoImportLink(test.text)
		if err != nil || platform != test.platform || address != test.address {
			t.Errorf("%q: got %q %q %v", test.text, platform, address, err)
		}
	}
	for _, text := range []string{
		"", "https://weixin.qq.com/sph/", "http://weixin.qq.com/sph/abc",
		"https://weixin.qq.com.evil.test/sph/abc", "https://evil.test@weixin.qq.com/sph/abc",
		"https://weixin.qq.com:8443/sph/abc", "https://channels.weixin.qq.com/platform/abc",
		"https://127.0.0.1/video.mp4", "https://weixin.qq.com/sph/a https://weixin.qq.com/sph/b",
		"https://media.localhost/video", "https://metadata.internal/video", "https://nas.home.arpa/video",
	} {
		if _, _, err := VideoImportLink(text); err == nil {
			t.Errorf("accepted %q", text)
		}
	}
}

func TestResolveHostedVideoContract(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Query().Get("url") != "https://v.douyin.com/abc/" {
			t.Errorf("unexpected parser request: %s %s", r.Method, r.URL.String())
		}
		_, _ = io.WriteString(w, `{"code":200,"msg":"解析成功","data":{"video_url":"https://cdn.example/video.mp4","cover_url":"https://cdn.example/cover.jpg","title":"标题","author":{"name":"作者"},"source":"douyin"}}`)
	}))
	defer server.Close()
	client := server.Client()
	result, err := ResolveHostedVideo(context.Background(), client, server.URL+"/api/parse", "https://v.douyin.com/abc/", 1<<20)
	if err != nil || result.VideoURL != "https://cdn.example/video.mp4" || result.Source.Platform != "douyin" ||
		result.Source.Title != "标题" || result.Source.Author != "作者" || result.Source.CoverURL != "https://cdn.example/cover.jpg" {
		t.Fatalf("unexpected parse result: %+v %v", result, err)
	}
}

func TestDecodeHostedVideoUsesFormatsAndRejectsUnsafeURLs(t *testing.T) {
	result, err := decodeHostedVideo(strings.NewReader(`{"code":200,"data":{"formats":[{"url":"https://cdn.example/video.mp4"}],"images":[{"url":"https://cdn.example/cover.jpg"}]}}`), "https://www.youtube.com/watch?v=abc")
	if err != nil || result.VideoURL != "https://cdn.example/video.mp4" || result.Source.Platform != "youtube" || result.Source.CoverURL != "https://cdn.example/cover.jpg" {
		t.Fatalf("unexpected format fallback: %+v %v", result, err)
	}
	for _, body := range []string{
		`{"code":500,"msg":"deleted"}`,
		`{"code":200,"data":{"video_url":"http://127.0.0.1/private.mp4"}}`,
	} {
		if _, err := decodeHostedVideo(strings.NewReader(body), "https://example.test/video/abc"); err == nil {
			t.Errorf("accepted unsafe or failed response: %s", body)
		}
	}
}

func TestPlatformFromHost(t *testing.T) {
	for _, test := range []struct{ host, want string }{
		{"v.kuaishou.com", "kuaishou"},
		{"b23.tv", "bilibili"},
		{"www.youtube.com", "youtube"},
		{"x.com", "x"},
		{"m.weibo.cn", "weibo"},
		{"www.ixigua.com", "ixigua"},
		{"www.pipix.com", "pipixia"},
		{"www.acfun.cn", "acfun"},
		{"www.tiktok.com", "tiktok"},
		{"www.instagram.com", "instagram"},
		{"video.example", "other"},
	} {
		if got := platformFromHost("https://" + test.host + "/video"); got != test.want {
			t.Errorf("%s: got %q, want %q", test.host, got, test.want)
		}
	}
}

func TestResolveWeChatVideoContracts(t *testing.T) {
	for _, path := range []string{"/api/channels/parse_sph", "/api/fetch_video_profile", "/api/v1/parse"} {
		t.Run(path, func(t *testing.T) {
			share := "https://weixin.qq.com/sph/test?key=a&b=c"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != path || r.Header.Get("Authorization") != "Bearer private-parser-token" {
					t.Errorf("wrong parser request")
				}
				if path == "/api/channels/parse_sph" {
					if r.Method != http.MethodGet || r.URL.Query().Get("url") != share {
						t.Errorf("wrong GET contract")
					}
				} else if path == "/api/v1/parse" {
					var body map[string]string
					if json.NewDecoder(r.Body).Decode(&body) != nil || r.Method != http.MethodPost || body["url"] != share {
						t.Errorf("wrong POST contract")
					}
					_, _ = io.WriteString(w, `{"retcode":200,"retdesc":"成功","succ":true,"data":{"platform":"视频号","title":"标准接口标题","video_url":"https://finder.video.qq.com/video.mp4","cover_url":"https://finder.video.qq.com/cover.jpg","author":{"nickname":"标准接口作者"}}}`)
					return
				} else {
					var body map[string]string
					if json.NewDecoder(r.Body).Decode(&body) != nil || r.Method != http.MethodPost || body["url"] != share {
						t.Errorf("wrong POST contract")
					}
				}
				_, _ = io.WriteString(w, `{"code":0,"data":{"errCode":0,"data":{"feedInfo":{"description":"中文标题","videoUrl":"https://video.qq.com/default.mp4","h264VideoInfo":{"videoUrl":"https://video.qq.com/h264.mp4"},"coverUrl":"http://127.0.0.1/private"},"authorInfo":{"nickname":"作者"}}}}`)
			}))
			defer server.Close()
			result, err := ResolveWeChatVideo(context.Background(), server.Client(), server.URL+path, "private-parser-token", share, 1<<20)
			if path == "/api/v1/parse" {
				if err != nil || result.VideoURL != "https://finder.video.qq.com/video.mp4" || result.Source.Title != "标准接口标题" || result.Source.Author != "标准接口作者" || result.Source.CoverURL != "https://finder.video.qq.com/cover.jpg" {
					t.Fatalf("unexpected standard API result: %+v %v", result, err)
				}
				return
			}
			if err != nil || result.VideoURL != "https://video.qq.com/h264.mp4" || result.Source.Title != "中文标题" || result.Source.Author != "作者" || result.Source.SourceURL != share || result.Source.CoverURL != "" {
				t.Fatalf("unexpected result: %+v %v", result, err)
			}
		})
	}
}

func TestResolveWeChatVideoRejectsFailures(t *testing.T) {
	for _, test := range []struct {
		name, body string
		status     int
		limit      int64
	}{
		{"credential", `private-parser-token`, http.StatusUnauthorized, 1024},
		{"redirect", "", http.StatusFound, 1024},
		{"malformed", `{`, http.StatusOK, 1024},
		{"upstream-error", `{"errCode":1,"error":"private-parser-token"}`, http.StatusOK, 1024},
		{"no-video", `{"data":{"feedInfo":{"description":"photo"}}}`, http.StatusOK, 1024},
		{"unsafe-video", `{"data":{"feedInfo":{"videoUrl":"https://video.qq.com.evil.test/a"}}}`, http.StatusOK, 1024},
		{"oversized", strings.Repeat("x", 1025), http.StatusOK, 1024},
	} {
		t.Run(test.name, func(t *testing.T) {
			hits := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits++
				w.Header().Set("Location", "/leak")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			_, err := ResolveWeChatVideo(context.Background(), server.Client(), server.URL+"/api/fetch_video_profile", "private-parser-token", "https://weixin.qq.com/sph/abc", test.limit)
			if err == nil || strings.Contains(err.Error(), "private-parser-token") || hits != 1 {
				t.Fatalf("unsafe failure: %v, requests=%d", err, hits)
			}
		})
	}
}

func TestResolveWeChatVideoParserEndpointSecurity(t *testing.T) {
	for _, endpoint := range []string{
		"://malformed", "http://parser.example/api/fetch_video_profile",
		"http://127.0.0.1/api/fetch_video_profile?token=secret",
		"https://parser.example/api/fetch_video_profile?token=secret",
		"https://parser.example:8443/api/fetch_video_profile",
		"https://parser.example:/api/fetch_video_profile",
	} {
		if _, err := ResolveWeChatVideo(context.Background(), http.DefaultClient, endpoint, "token", "https://weixin.qq.com/sph/a", 1024); err == nil {
			t.Errorf("accepted parser endpoint %q", endpoint)
		}
	}
	for _, endpoint := range []string{
		"http://localhost:8765/api/fetch_video_profile",
		"http://127.0.0.1:8765/api/fetch_video_profile",
		"https://parser.example/api/fetch_video_profile",
		"https://parser.example/api/v1/parse",
	} {
		if _, err := ResolveWeChatVideo(context.Background(), http.DefaultClient, endpoint, "token", "https://weixin.qq.com/sph/a", 1024); err == nil {
			t.Errorf("unexpectedly reached unconfigured parser %q", endpoint)
		} else if !strings.Contains(err.Error(), "解析服务连接失败") {
			t.Errorf("endpoint %q was rejected before network connection: %v", endpoint, err)
		}
	}
}

func TestDecodeWeChatVideoFallbacks(t *testing.T) {
	for _, feed := range []string{
		`{"videoUrl":"https://video.qq.com/a.mp4"}`,
		`{"h265VideoInfo":{"videoUrl":"https://video.qq.com/a.mp4"}}`,
	} {
		value, err := decodeWeChatVideo(strings.NewReader(`{"data":{"feedInfo":`+feed+`}}`), "https://weixin.qq.com/sph/test")
		if err != nil || value.VideoURL != "https://video.qq.com/a.mp4" {
			t.Fatalf("failed fallback: %+v %v", value, err)
		}
	}
}

func TestDecodeMediaParserRejectsFailureAndUnsafeMedia(t *testing.T) {
	for _, body := range []string{
		`{"retcode":401,"succ":false,"retdesc":"登录已失效"}`,
		`{"retcode":200,"succ":true,"data":{"video_url":"https://video.qq.com.evil.test/a.mp4"}}`,
	} {
		if _, err := decodeWeChatVideo(strings.NewReader(body), "https://weixin.qq.com/sph/test"); err == nil {
			t.Errorf("accepted parser response %s", body)
		}
	}
}

func TestVideoImportMediaURLAllowed(t *testing.T) {
	for _, address := range []string{"https://video.qq.com/a?key=1", "http://finder.video.qq.com/a", "https://wx.qpic.cn/a", "https://cdn.example/a"} {
		if !VideoImportMediaURLAllowed(address) {
			t.Errorf("rejected %q", address)
		}
	}
	if !VideoImportWeChatMediaURLAllowed("https://finder.video.qq.com/a") || VideoImportWeChatMediaURLAllowed("https://cdn.example/a") {
		t.Fatal("video account host allowlist changed")
	}
	for _, address := range []string{
		"https://user:secret@video.qq.com/a", "https://video.qq.com:8443/a", "https://video.qq.com:/a",
		"file:///video.qq.com/a", "http://127.0.0.1/a", "https://[::1]/a", "https://video.qq.com/a#fragment",
		"https://video.qq.com%2fevil.test/a", "//video.qq.com/a",
	} {
		if VideoImportMediaURLAllowed(address) {
			t.Errorf("accepted %q", address)
		}
	}
	for _, address := range []string{"https://video.qq.com.evil.test/a", "https://evilqq.com/a", "https://cdn.example/a"} {
		if VideoImportWeChatMediaURLAllowed(address) {
			t.Errorf("accepted non-Tencent video account host %q", address)
		}
	}
}

func TestVideoImportDownloadNetworkPolicy(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "::1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::ffff:127.0.0.1", "fc00::1", "0.0.0.0"} {
		if videoImportPublicIP(net.ParseIP(address)) {
			t.Errorf("accepted %q", address)
		}
	}
	if !videoImportPublicIP(net.ParseIP("1.1.1.1")) {
		t.Fatal("rejected public IP")
	}
	client := NewVideoImportDownloadClient(time.Second)
	defer client.CloseIdleConnections()
	for _, address := range []string{"http://127.0.0.1/", "http://localhost/", "http://[::1]/"} {
		if response, err := client.Get(address); err == nil {
			response.Body.Close()
			t.Fatalf("allowed private connection %q", address)
		}
	}
	bad, _ := http.NewRequest(http.MethodGet, "http://127.0.0.1/a", nil)
	if client.CheckRedirect(bad, nil) == nil {
		t.Fatal("allowed private redirect")
	}
	good, _ := http.NewRequest(http.MethodGet, "https://cdn.example/a", nil)
	if client.CheckRedirect(good, nil) != nil || client.CheckRedirect(good, make([]*http.Request, 10)) == nil {
		t.Fatal("incorrect standard redirect policy")
	}
}
