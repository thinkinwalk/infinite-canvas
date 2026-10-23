package handler

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

type creditLogVideo struct {
	TaskID    string `json:"taskId"`
	Status    string `json:"status"`
	Available bool   `json:"available"`
	UpdatedAt string `json:"updatedAt"`
}

var creditLogVideoClient = newCreditLogVideoClient()

func newCreditLogVideoClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	// Pin validated DNS results so media URLs cannot reach internal services.
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil || len(addresses) == 0 {
			return nil, errors.New("视频地址解析失败")
		}
		for _, address := range addresses {
			ip := address.IP
			shared := &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
			if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || shared.Contains(ip) {
				return nil, errors.New("视频地址不允许访问")
			}
		}
		return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(addresses[0].IP.String(), port))
	}
	return &http.Client{Timeout: aiHTTPClient.Timeout, Transport: transport}
}

// Resolve through the ledger, then check ownership again before reading media.
func creditLogVideoTask(w http.ResponseWriter, r *http.Request, id string) (*model.VideoTask, *model.ReplicateTask, bool) {
	user, ok := service.UserFromContext(r.Context())
	if !ok || user.Role != model.UserRoleAdmin {
		w.WriteHeader(http.StatusForbidden)
		Fail(w, "未登录或权限不足")
		return nil, nil, false
	}
	entry, found, err := repository.GetCreditLog(id)
	if err != nil {
		FailError(w, err)
		return nil, nil, false
	}
	if !found {
		http.NotFound(w, r)
		return nil, nil, false
	}
	if entry.RelatedID == "" || (entry.Type != model.CreditLogTypeAIConsume && entry.Type != model.CreditLogTypeAIRefund) {
		return nil, nil, true
	}
	task, found, err := repository.GetVideoTask(entry.RelatedID)
	if err != nil {
		FailError(w, err)
		return nil, nil, false
	}
	if found {
		if task.UserID == entry.UserID {
			return &task, nil, true
		}
		return nil, nil, true
	}
	cloud, found, err := repository.GetReplicateTask(entry.RelatedID)
	if err != nil {
		FailError(w, err)
		return nil, nil, false
	}
	if found && cloud.UserID == entry.UserID && cloud.Operation != "speech" && cloud.Operation != "transcribe" {
		return nil, &cloud, true
	}
	return nil, nil, true
}

func AdminCreditLogVideo(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "private, no-store")
	task, cloud, ok := creditLogVideoTask(w, r, id)
	if !ok {
		return
	}
	var video *creditLogVideo
	if task != nil {
		video = &creditLogVideo{TaskID: task.ID, Status: task.Status, Available: task.Status == "completed", UpdatedAt: task.UpdatedAt}
	} else if cloud != nil {
		video = &creditLogVideo{TaskID: cloud.ID, Status: cloud.Status, Available: cloud.Status == "completed" && cloud.ResultFile != "" && strings.HasPrefix(cloud.MimeType, "video/"), UpdatedAt: cloud.UpdatedAt}
	}
	OK(w, video)
}

func AdminCreditLogVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	task, cloud, ok := creditLogVideoTask(w, r, id)
	if !ok {
		return
	}
	if cloud != nil {
		if cloud.Status != "completed" || cloud.ResultFile == "" || !strings.HasPrefix(cloud.MimeType, "video/") {
			http.Error(w, "视频尚未生成或保存", http.StatusConflict)
			return
		}
		file, err := os.Open(filepath.Join(referenceDataDir(), "replicate-results", filepath.Base(cloud.ResultFile)))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", cloud.MimeType)
		http.ServeContent(w, r, cloud.ResultFile, info.ModTime(), file)
		return
	}
	if task == nil {
		http.NotFound(w, r)
		return
	}
	if task.Status != "completed" {
		http.Error(w, "视频尚未生成", http.StatusConflict)
		return
	}
	request, client, err := creditLogVideoRequest(r, *task)
	if err != nil {
		Fail(w, "视频地址不可用，请检查原任务或渠道配置")
		return
	}
	response, err := client.Do(request)
	if err != nil {
		Fail(w, "视频读取失败，请稍后重试")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		http.Error(w, "视频暂时无法读取，源文件可能已过期", http.StatusBadGateway)
		return
	}
	reader := bufio.NewReader(response.Body)
	head, _ := reader.Peek(512)
	contentType := http.DetectContentType(head)
	if !strings.HasPrefix(contentType, "video/") {
		http.Error(w, "上游未返回有效视频文件", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", contentType)
	if value := response.Header.Get("Content-Length"); value != "" {
		w.Header().Set("Content-Length", value)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, reader)
}

func creditLogVideoRequest(r *http.Request, task model.VideoTask) (*http.Request, *http.Client, error) {
	channel, channelErr := service.ResolveModelChannelForTask(task.ChannelName, task.ChannelBaseURL)
	if channelErr == nil && service.IsSparkCineH3(channel, task.Model) {
		body, err := querySparkCineH3(r.Context(), channel, task.ID)
		if err != nil {
			return nil, nil, err
		}
		request, err := sparkCineDownloadRequest(r.Context(), videoResponseOutputURL(body))
		return request, creditLogVideoClient, err
	}
	address, client, token := task.OutputURL, creditLogVideoClient, ""
	switch strings.ToLower(strings.TrimSpace(task.Model)) {
	case "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5-fast", "grok-imagine-1.0-video":
		// Match the creator's authenticated content route for these models.
		address = ""
	}
	if address == "" {
		channel, err := service.ResolveModelChannelForTask(task.ChannelName, task.ChannelBaseURL)
		if err != nil {
			return nil, nil, err
		}
		address = service.BuildModelChannelURL(channel, "/videos/"+url.PathEscape(task.ID)+"/content")
		queryURL, err := url.Parse(address)
		if err != nil {
			return nil, nil, err
		}
		query := queryURL.Query()
		query.Set("model", task.Model)
		queryURL.RawQuery = query.Encode()
		address, client, token = queryURL.String(), aiHTTPClient, channel.APIKey
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil, nil, errors.New("视频地址无效")
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, address, nil)
	if err != nil {
		return nil, nil, err
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request, client, nil
}
