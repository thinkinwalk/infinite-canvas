package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type VideoImportSource struct {
	Platform  string `json:"platform"`
	Title     string `json:"title"`
	Author    string `json:"author"`
	SourceURL string `json:"sourceUrl"`
	CoverURL  string `json:"coverUrl,omitempty"`
}

type ResolvedVideoImport struct {
	Source   VideoImportSource
	VideoURL string
}

var videoShareURLPattern = regexp.MustCompile(`https?://[^\s<>"'，。！？、；（）【】]+`)

// Only SPH share URLs use the upstream's server-only parser. Other Channels
// page URLs may silently fall back to a connected desktop WeChat session.
func VideoImportLink(text string) (string, string, error) {
	matches := videoShareURLPattern.FindAllString(strings.TrimSpace(text), -1)
	if len(matches) != 1 {
		return "", "", errors.New("请粘贴一条视频分享链接或包含单条链接的分享文案")
	}
	address, err := url.Parse(strings.TrimRight(matches[0], ".,;!?)】]」》"))
	if err != nil || address.Scheme != "https" || address.User != nil || address.Port() != "" || strings.HasSuffix(address.Host, ":") {
		return "", "", errors.New("请使用有效的 HTTPS 视频分享链接")
	}
	host := strings.ToLower(address.Hostname())
	switch {
	case host == "weixin.qq.com" && strings.HasPrefix(address.Path, "/sph/") && len(strings.TrimPrefix(address.Path, "/sph/")) > 0:
		address.Fragment = ""
		return "wxchannels", address.String(), nil
	case host == "channels.weixin.qq.com":
		return "", "", errors.New("请使用 https://weixin.qq.com/sph/ 开头的视频号分享链接")
	case host == "douyin.com" || strings.HasSuffix(host, ".douyin.com"):
		return "douyin", address.String(), nil
	case host == "xiaohongshu.com" || strings.HasSuffix(host, ".xiaohongshu.com") || host == "xhslink.com" || strings.HasSuffix(host, ".xhslink.com"):
		return "xiaohongshu", address.String(), nil
	default:
		return "", "", errors.New("暂不支持该链接，请粘贴视频号分享链接")
	}
}

// ResolveWeChatVideo uses an operator-configured HTTP service. No upstream
// implementation or Yuanbao cookies are bundled into the application.
func ResolveWeChatVideo(ctx context.Context, client *http.Client, endpoint, token, shareURL string, maxBytes int64) (ResolvedVideoImport, error) {
	var result ResolvedVideoImport
	address, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || address == nil || address.Host == "" || address.User != nil || address.RawQuery != "" || address.Fragment != "" || strings.HasSuffix(address.Host, ":") {
		return result, errors.New("视频号链接提取服务未配置，请联系管理员")
	}
	loopback := strings.EqualFold(address.Hostname(), "localhost")
	if ip := net.ParseIP(address.Hostname()); ip != nil && ip.IsLoopback() {
		loopback = true
	}
	if (address.Scheme != "http" && address.Scheme != "https") || (address.Scheme != "https" && !loopback) {
		return result, errors.New("视频号链接提取服务未配置，请联系管理员")
	}
	var request *http.Request
	switch address.Path {
	case "/api/channels/parse_sph":
		query := url.Values{"url": {shareURL}}
		address.RawQuery = query.Encode()
		request, err = http.NewRequestWithContext(ctx, http.MethodGet, address.String(), nil)
	case "/api/fetch_video_profile":
		payload, _ := json.Marshal(map[string]string{"url": shareURL})
		request, err = http.NewRequestWithContext(ctx, http.MethodPost, address.String(), bytes.NewReader(payload))
	default:
		return result, errors.New("视频号解析服务接口地址无效，请联系管理员")
	}
	if err != nil {
		return result, errors.New("视频号解析服务接口地址无效，请联系管理员")
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	parserClient := *client
	// Never redirect a request containing the parser's credential or share URL.
	parserClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := parserClient.Do(request)
	if err != nil {
		return result, errors.New("视频号解析服务连接失败，请稍后重试")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		return result, errors.New("视频号解析服务凭证失效，请联系管理员")
	}
	if response.StatusCode != http.StatusOK {
		return result, errors.New("视频号解析失败，请确认分享链接可访问，或稍后重试")
	}
	// Reuse the caller's existing reference-media bound for parser responses too.
	if response.ContentLength > maxBytes {
		return result, errors.New("视频号解析服务返回异常，请联系管理员")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil || int64(len(payload)) > maxBytes {
		return result, errors.New("视频号解析服务返回异常，请联系管理员")
	}
	return decodeWeChatVideo(bytes.NewReader(payload), shareURL)
}

func decodeWeChatVideo(reader io.Reader, shareURL string) (ResolvedVideoImport, error) {
	type videoInfo struct {
		VideoURL string `json:"videoUrl"`
	}
	type feedInfo struct {
		Description string    `json:"description"`
		CoverURL    string    `json:"coverUrl"`
		VideoURL    string    `json:"videoUrl"`
		H264        videoInfo `json:"h264VideoInfo"`
		H265        videoInfo `json:"h265VideoInfo"`
	}
	type envelope struct {
		Code       int             `json:"code"`
		ErrCode    int             `json:"errCode"`
		Error      string          `json:"error"`
		Data       json.RawMessage `json:"data"`
		Feed       *feedInfo       `json:"feedInfo"`
		AuthorInfo struct {
			Nickname string `json:"nickname"`
		} `json:"authorInfo"`
	}
	var raw json.RawMessage
	if err := json.NewDecoder(reader).Decode(&raw); err != nil {
		return ResolvedVideoImport{}, errors.New("视频号解析服务返回异常，请联系管理员")
	}
	for len(raw) > 0 {
		var payload envelope
		if json.Unmarshal(raw, &payload) != nil || payload.Code != 0 || payload.ErrCode != 0 || payload.Error != "" {
			break
		}
		if feed := payload.Feed; feed != nil {
			videoURL := feed.H264.VideoURL
			if videoURL == "" {
				videoURL = feed.VideoURL
			}
			if videoURL == "" {
				videoURL = feed.H265.VideoURL
			}
			if videoURL == "" {
				return ResolvedVideoImport{}, errors.New("该链接未返回视频，可能是图文、已失效或不可访问的内容")
			}
			if !VideoImportMediaURLAllowed(videoURL) {
				return ResolvedVideoImport{}, errors.New("视频号返回的视频地址无法验证，请联系管理员")
			}
			cover := feed.CoverURL
			if !VideoImportMediaURLAllowed(cover) {
				cover = ""
			}
			return ResolvedVideoImport{
				Source:   VideoImportSource{Platform: "wxchannels", Title: feed.Description, Author: payload.AuthorInfo.Nickname, SourceURL: shareURL, CoverURL: cover},
				VideoURL: videoURL,
			}, nil
		}
		raw = payload.Data
	}
	return ResolvedVideoImport{}, errors.New("视频号解析失败，请检查分享链接及解析服务的登录凭证")
}

func VideoImportMediaURLAllowed(raw string) bool {
	address, err := url.Parse(raw)
	if err != nil || address.Host == "" || address.User != nil || address.Port() != "" || address.Fragment != "" || strings.HasSuffix(address.Host, ":") || (address.Scheme != "http" && address.Scheme != "https") {
		return false
	}
	host := strings.ToLower(address.Hostname())
	return strings.HasSuffix(host, ".qq.com") || strings.HasSuffix(host, ".qpic.cn")
}

func videoImportPublicIP(ip net.IP) bool {
	sharedNetwork := &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() &&
		!ip.IsLinkLocalUnicast() && !sharedNetwork.Contains(ip)
}

// Resolve once, reject private addresses, and dial that exact IP so redirects
// and DNS changes cannot turn media downloads into internal-network requests.
func NewVideoImportDownloadClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("视频地址解析失败")
		}
		for _, ip := range ips {
			if !videoImportPublicIP(ip.IP) {
				return nil, errors.New("视频地址不允许访问")
			}
		}
		return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if !VideoImportMediaURLAllowed(request.URL.String()) {
				return errors.New("视频重定向地址不允许访问")
			}
			// Keep the standard net/http redirect policy.
			if len(via) >= 10 {
				return errors.New("视频重定向次数过多")
			}
			return nil
		},
	}
}
