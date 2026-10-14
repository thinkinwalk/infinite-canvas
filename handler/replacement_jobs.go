package handler

// Durable orchestration reuses the existing authenticated model handlers and
// billing. It never stores API keys and never retries a paid create request.
import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
	"github.com/google/uuid"
)

type replacementPart struct {
	Start         float64          `json:"start"`
	End           float64          `json:"end"`
	InputStart    float64          `json:"inputStart"`
	InputEnd      float64          `json:"inputEnd"`
	TrimStart     float64          `json:"trimStart"`
	Seconds       float64          `json:"seconds"`
	Input         string           `json:"input,omitempty"`
	Prepared      string           `json:"prepared,omitempty"`
	Reference     string           `json:"reference,omitempty"`
	TaskID        string           `json:"taskId,omitempty"`
	Submitted     bool             `json:"submitted"`
	Generated     string           `json:"generated,omitempty"`
	Validated     bool             `json:"validated"`
	PreviousTasks []string         `json:"previousTasks,omitempty"`
	Captions      []map[string]any `json:"captions,omitempty"`
	Credits       int              `json:"credits"`
}
type replacementJob struct {
	ID            string            `json:"id"`
	UserID        string            `json:"userId"`
	Source        string            `json:"source"`
	Image         string            `json:"image"`
	Model         string            `json:"model"`
	ChannelID     int               `json:"channelId"`
	Resolution    string            `json:"resolution"`
	Seconds       string            `json:"seconds"`
	Prompt        string            `json:"prompt"`
	Subtitles     bool              `json:"subtitles"`
	SubtitleSize  float64           `json:"subtitleSize"`
	SubtitleColor string            `json:"subtitleColor"`
	Status        string            `json:"status"`
	Step          string            `json:"step"`
	Error         string            `json:"error,omitempty"`
	Credits       int               `json:"credits"`
	Parts         []replacementPart `json:"parts"`
	Planned       bool              `json:"planned"`
	AspectRatio   string            `json:"aspectRatio"`
	WorkerStep    string            `json:"workerStep,omitempty"`
	WorkerID      string            `json:"workerId,omitempty"`
	Assembled     string            `json:"assembled,omitempty"`
	Result        string            `json:"result,omitempty"`
	CreatedAt     string            `json:"createdAt"`
	UpdatedAt     string            `json:"updatedAt"`
}
type replacementControl struct {
	running atomic.Bool
	pause   atomic.Bool
	mu      sync.Mutex
}

var replacementControls sync.Map

func replacementControlFor(id string) *replacementControl {
	v, _ := replacementControls.LoadOrStore(id, &replacementControl{})
	return v.(*replacementControl)
}
func replacementJobPath(id string) (string, error) {
	if _, err := uuid.Parse(id); err != nil {
		return "", fmt.Errorf("任务编号不正确")
	}
	return filepath.Join(referenceDataDir(), "replacement-jobs", id+".json"), nil
}
func saveReplacement(job *replacementJob) error {
	path, err := replacementJobPath(job.ID)
	if err != nil {
		return err
	}
	c := replacementControlFor(job.ID)
	c.mu.Lock()
	defer c.mu.Unlock()
	job.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	data, err := json.Marshal(job)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func loadReplacement(id, userID string) (replacementJob, error) {
	var job replacementJob
	path, err := replacementJobPath(id)
	if err != nil {
		return job, err
	}
	c := replacementControlFor(id)
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil {
		return job, fmt.Errorf("任务不存在")
	}
	if json.Unmarshal(data, &job) != nil || job.UserID != userID {
		return job, fmt.Errorf("任务不存在或无权访问")
	}
	return job, nil
}

// Captures JSON responses only. Media always streams to files or to the worker.
type replacementResponse struct {
	bytes.Buffer
	header http.Header
	status int
}

func (w *replacementResponse) Header() http.Header    { return w.header }
func (w *replacementResponse) WriteHeader(status int) { w.status = status }
func replacementCall(ctx context.Context, handle http.HandlerFunc, method, path string, input any, credits *int) (json.RawMessage, error) {
	data, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	r, err := http.NewRequestWithContext(ctx, method, path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	if credits != nil {
		r.Header.Set("X-Expected-Credits", strconv.Itoa(*credits))
	}
	w := &replacementResponse{header: http.Header{}, status: 200}
	handle(w, r)
	var envelope struct {
		Code *int            `json:"code"`
		Data json.RawMessage `json:"data"`
		Msg  string          `json:"msg"`
	}
	if json.Unmarshal(w.Bytes(), &envelope) != nil {
		return nil, fmt.Errorf("服务未返回任务信息")
	}
	if w.status >= 400 || envelope.Code != nil && *envelope.Code != 0 {
		return nil, fmt.Errorf("%s", firstReplacementText(envelope.Msg, "处理请求失败，已暂停"))
	}
	if envelope.Code != nil {
		return envelope.Data, nil
	}
	return append(json.RawMessage(nil), w.Bytes()...), nil
}
func firstReplacementText(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
func replacementWorkerRequest(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	base := strings.TrimRight(os.Getenv("VIDEO_WORKER_URL"), "/")
	if base == "" {
		return nil, fmt.Errorf("平台尚未配置视频处理服务")
	}
	r, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, err
	}
	r.Header.Set("X-Canvas-Worker", "1")
	r.Header.Set("Authorization", "Bearer "+os.Getenv("VIDEO_WORKER_TOKEN"))
	r.Header.Set("Content-Type", contentType)
	resp, err := aiHTTPClient.Do(r)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		var v struct {
			Detail string `json:"detail"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&v)
		return nil, fmt.Errorf("%s", firstReplacementText(v.Detail, "处理服务请求失败"))
	}
	return resp, nil
}
func replacementWorkerJSON(ctx context.Context, method, path string, input any, output any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	resp, err := replacementWorkerRequest(ctx, method, path, bytes.NewReader(data), "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(output)
}

type replacementWorkerResult struct {
	File     string           `json:"file"`
	Segments []map[string]any `json:"segments"`
	Metadata struct {
		Parts []replacementPart `json:"parts"`
		Size  [2]int            `json:"size"`
	} `json:"metadata"`
}

func replacementWorkerStep(ctx context.Context, job *replacementJob, step, operation string, inputs map[string]any, options any) (replacementWorkerResult, error) {
	var result replacementWorkerResult
	if job.WorkerStep != step {
		job.WorkerStep, job.WorkerID = step, uuid.NewString()
		if err := saveReplacement(job); err != nil {
			return result, err
		}
	}
	var state struct {
		ID     string                  `json:"id"`
		Status string                  `json:"status"`
		Error  string                  `json:"error"`
		Result replacementWorkerResult `json:"result"`
	}
	// The worker persists this caller-supplied ID before starting a reversible step.
	err := replacementWorkerJSON(ctx, "POST", "/jobs", map[string]any{"id": job.WorkerID, "operation": operation, "inputs": inputs, "options": options}, &state)
	if err != nil {
		return result, err
	}
	for {
		if state.Status == "completed" {
			return state.Result, nil
		}
		if state.Status == "failed" || state.Status == "cancelled" {
			job.WorkerStep, job.WorkerID = "", ""
			if err := saveReplacement(job); err != nil {
				return result, err
			}
			return result, fmt.Errorf("%s", state.Error)
		}
		// Reuse the existing cloud processor polling interval; no paid retry.
		time.Sleep(2 * time.Second)
		if err := replacementWorkerJSON(ctx, "GET", "/jobs/"+url.PathEscape(job.WorkerID), nil, &state); err != nil {
			return result, err
		}
	}
}

func ReplacementJobs(w http.ResponseWriter, r *http.Request) {
	user, _ := service.UserFromContext(r.Context())
	if r.Method == "GET" {
		paths, err := filepath.Glob(filepath.Join(referenceDataDir(), "replacement-jobs", "*.json"))
		if err != nil {
			Fail(w, err.Error())
			return
		}
		jobs := []replacementJob{}
		for _, path := range paths {
			job, err := loadReplacement(strings.TrimSuffix(filepath.Base(path), ".json"), user.ID)
			if err == nil {
				markReplacementPaused(&job)
				jobs = append(jobs, job)
			}
		}
		OK(w, jobs)
		return
	}
	var request struct {
		ID            string  `json:"id"`
		Source        string  `json:"source"`
		Image         string  `json:"image"`
		Model         string  `json:"model"`
		Resolution    string  `json:"resolution"`
		Seconds       string  `json:"seconds"`
		Prompt        string  `json:"prompt"`
		Subtitles     bool    `json:"subtitles"`
		SubtitleSize  float64 `json:"subtitleSize"`
		SubtitleColor string  `json:"subtitleColor"`
	}
	if json.NewDecoder(r.Body).Decode(&request) != nil {
		Fail(w, "任务格式不正确")
		return
	}
	if _, err := replacementJobPath(request.ID); err != nil {
		Fail(w, err.Error())
		return
	}
	control := replacementControlFor(request.ID)
	if !control.running.CompareAndSwap(false, true) {
		Fail(w, "任务已在处理中，请刷新列表")
		return
	}
	if job, err := loadReplacement(request.ID, user.ID); err == nil {
		control.running.Store(false)
		markReplacementPaused(&job)
		OK(w, job)
		return
	}
	// An existing ID belonging to another user must never be overwritten.
	path, _ := replacementJobPath(request.ID)
	if _, err := os.Stat(path); err == nil {
		control.running.Store(false)
		Fail(w, "任务编号已使用")
		return
	}
	job := replacementJob{ID: request.ID, UserID: user.ID, Source: request.Source, Image: request.Image, Model: request.Model,
		Resolution: request.Resolution, Seconds: request.Seconds, Prompt: request.Prompt, Subtitles: request.Subtitles,
		SubtitleSize: request.SubtitleSize, SubtitleColor: request.SubtitleColor, Status: "planning", Step: "分析镜头与分段费用", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := validateReplacementRequest(r.Context(), &job); err != nil {
		control.running.Store(false)
		Fail(w, err.Error())
		return
	}
	if err := saveReplacement(&job); err != nil {
		control.running.Store(false)
		Fail(w, "保存任务失败")
		return
	}
	OK(w, job)
	go runReplacement(service.WithUser(context.Background(), user), job, true)
}
func markReplacementPaused(job *replacementJob) {
	if (job.Status == "running" || job.Status == "planning") && !replacementControlFor(job.ID).running.Load() {
		job.Status = "paused"
		job.Error = "服务已重启，可恢复查询已有任务；不会自动重发收费请求"
	}
}
func ReplacementJobAction(w http.ResponseWriter, r *http.Request, id, action string) {
	user, _ := service.UserFromContext(r.Context())
	job, err := loadReplacement(id, user.ID)
	if err != nil {
		http.Error(w, "任务不存在", 404)
		return
	}
	c := replacementControlFor(id)
	if action == "" {
		markReplacementPaused(&job)
		OK(w, job)
		return
	}
	if action == "pause" {
		c.pause.Store(true)
		OK(w, map[string]any{"message": "将在当前步骤结束并保存结果后暂停"})
		return
	}
	if action == "quote-part" {
		var input struct {
			Part int `json:"part"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.Part < 0 || input.Part >= len(job.Parts) {
			Fail(w, "片段编号不正确")
			return
		}
		price, err := quoteReplacementPart(r.Context(), &job, &job.Parts[input.Part])
		if err != nil {
			Fail(w, err.Error())
			return
		}
		OK(w, map[string]int{"credits": price})
		return
	}
	if action == "reprice" {
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "请先暂停任务")
			return
		}
		defer c.running.Store(false)
		job, err = loadReplacement(id, user.ID)
		if err != nil || !job.Planned || job.Status == "completed" {
			Fail(w, "该任务无需重新报价")
			return
		}
		for i := range job.Parts {
			part := &job.Parts[i]
			if part.Submitted || part.Validated {
				continue
			}
			price, err := quoteReplacementPart(r.Context(), &job, part)
			if err != nil {
				Fail(w, err.Error())
				return
			}
			job.Credits += price - part.Credits
			part.Credits = price
		}
		job.Status, job.Step, job.Error = "ready", "剩余片段已重新报价，等待确认", ""
		if err := saveReplacement(&job); err != nil {
			Fail(w, "保存报价失败")
			return
		}
		OK(w, job)
		return
	}
	if action == "retry" {
		var input struct {
			Part            int `json:"part"`
			ExpectedCredits int `json:"expectedCredits"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.Part < 0 || input.Part >= len(job.Parts) {
			Fail(w, "片段编号不正确")
			return
		}
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "请先暂停任务再重做片段")
			return
		}
		defer c.running.Store(false)
		job, err = loadReplacement(id, user.ID)
		if err != nil || input.Part >= len(job.Parts) {
			Fail(w, "任务已变化，请刷新")
			return
		}
		part := &job.Parts[input.Part]
		if part.TaskID == "" {
			Fail(w, "提交状态不明确，不能重新收费；请管理员先核对原任务")
			return
		}
		status := ""
		if job.Model == "wan-video/wan-2.2-animate-replace" {
			task, found, err := repository.GetReplicateTask(part.TaskID)
			if err == nil && found && task.UserID == user.ID {
				status = task.Status
			}
		} else {
			task, found, err := service.GetVideoTask(part.TaskID)
			if err == nil && found && task.UserID == user.ID {
				status = task.Status
			}
		}
		if status != "failed" && status != "cancelled" && status != "completed" && status != "expired" {
			Fail(w, "原任务尚未确认结束，请先恢复查询，避免重复收费")
			return
		}
		price, err := quoteReplacementPart(r.Context(), &job, part)
		if err != nil || price != input.ExpectedCredits {
			Fail(w, "该段报价已变化，请先刷新报价")
			return
		}
		part.PreviousTasks = append(part.PreviousTasks, part.TaskID)
		part.Credits, part.TaskID, part.Generated, part.Submitted, part.Validated = price, "", "", false, false
		job.Credits += price
		job.Assembled, job.Result, job.WorkerStep, job.WorkerID = "", "", "", ""
		job.Status, job.Error, job.Step = "ready", "", "已保留其他片段，请确认预算后处理重做片段"
		if err := saveReplacement(&job); err != nil {
			Fail(w, "保存重做计划失败")
			return
		}
		OK(w, job)
		return
	}
	if action != "start" {
		http.NotFound(w, r)
		return
	}
	var input struct {
		ExpectedCredits int `json:"expectedCredits"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.ExpectedCredits != job.Credits {
		Fail(w, "请核对整片报价后开始")
		return
	}
	if job.Status == "completed" {
		OK(w, job)
		return
	}
	if !c.running.CompareAndSwap(false, true) {
		Fail(w, "任务正在运行")
		return
	}
	job, err = loadReplacement(id, user.ID)
	if err != nil || input.ExpectedCredits != job.Credits {
		c.running.Store(false)
		Fail(w, "任务已变化，请重新确认费用")
		return
	}
	if job.Status == "completed" {
		c.running.Store(false)
		OK(w, job)
		return
	}
	c.pause.Store(false)
	job.Status, job.Error = "running", ""
	if err := saveReplacement(&job); err != nil {
		c.running.Store(false)
		Fail(w, "保存任务失败")
		return
	}
	OK(w, job)
	go runReplacement(service.WithUser(context.Background(), user), job, !job.Planned)
}

func validateReplacementRequest(ctx context.Context, job *replacementJob) error {
	if !strings.HasPrefix(config.Cfg.PublicBaseURL, "https://") {
		return fmt.Errorf("平台需要配置 HTTPS 素材地址")
	}
	owner, found, err := repository.GetReferenceMediaOwner("worker-media:" + job.Source)
	if err != nil || !found || owner.UserID != job.UserID {
		return fmt.Errorf("原视频不存在或无权访问")
	}
	image, err := url.Parse(job.Image)
	if err != nil {
		return fmt.Errorf("参考图片地址不正确")
	}
	base := strings.TrimRight(config.Cfg.PublicBaseURL, "/") + "/api/media/references/"
	if !strings.HasPrefix(job.Image, base) || image.RawQuery != "" {
		return fmt.Errorf("请使用平台上传的人物参考图")
	}
	owner, found, err = repository.GetReferenceMediaOwner(strings.TrimPrefix(job.Image, base))
	if err != nil || !found || owner.UserID != job.UserID || !strings.HasPrefix(owner.MimeType, "image/") {
		return fmt.Errorf("人物参考图不存在或无权访问")
	}
	seconds, err := strconv.ParseFloat(job.Seconds, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0.5 {
		return fmt.Errorf("请选择有效分段时长")
	}
	user, _ := service.UserFromContext(ctx)
	if job.Model == "wan-video/wan-2.2-animate-replace" {
		channel, err := service.SelectReplicateChannel(job.Model, user.Group)
		if err != nil {
			return err
		}
		job.ChannelID = channel.ID
		if job.Resolution != "480" && job.Resolution != "720" {
			return fmt.Errorf("Wan 2.2 支持 480 / 720")
		}
	} else {
		channel, err := service.SelectModelChannelForGroup(job.Model, user.Group)
		if err != nil {
			return err
		}
		job.ChannelID = channel.ID
		profile := service.VideoProfile(channel, job.Model)
		if profile.MaxVideos < 1 || profile.MaxImages < 1 || profile.Interface == "unavailable" {
			return fmt.Errorf("该渠道未配置图片加视频参考能力，不能用于人物替换评估")
		}
		allowed := false
		for _, s := range profile.Seconds {
			if s == job.Seconds {
				allowed = true
			}
		}
		if !allowed {
			return fmt.Errorf("请使用渠道明确支持的输出时长")
		}
		if strings.EqualFold(job.Model, "wan30-720p") && seconds > 15 {
			return fmt.Errorf("Wan30 当前参考视频接入支持 1–15 秒，请选择不超过 15 秒的分段")
		}
		if err := validateVideoProfileRequest(profile, mustReplacementJSON(map[string]any{"seconds": job.Seconds, "resolution": job.Resolution, "image_url": job.Image, "reference_videos": []string{"https://example.invalid/reference.mp4"}, "input_mode": "reference"}), "application/json"); err != nil {
			return err
		}
	}
	var health struct {
		Capabilities []struct {
			Name      string `json:"name"`
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"capabilities"`
	}
	if err := replacementWorkerJSON(ctx, "GET", "/health", nil, &health); err != nil {
		return err
	}
	needed := []string{"replacement-plan", "replacement-extract", "replacement-validate", "replacement-assemble", "replacement-finish"}
	if job.Subtitles {
		needed = append(needed, "replacement-prepare")
	}
	for _, name := range needed {
		available := false
		for _, cap := range health.Capabilities {
			if cap.Name == name {
				available = cap.Available
			}
		}
		if !available {
			return fmt.Errorf("平台处理能力 %s 尚未就绪；未提交收费生成", name)
		}
	}
	return nil
}
func mustReplacementJSON(value any) []byte { data, _ := json.Marshal(value); return data }

func runReplacement(ctx context.Context, job replacementJob, planning bool) {
	c := replacementControlFor(job.ID)
	defer c.running.Store(false)
	err := executeReplacement(ctx, &job, planning)
	if err != nil {
		job.Status, job.Error = "paused", err.Error()
		_ = saveReplacement(&job)
	}
}
func executeReplacement(ctx context.Context, job *replacementJob, planning bool) error {
	ctx = context.WithValue(ctx, replacementChannelKey{}, job.ChannelID)
	if planning {
		seconds, _ := strconv.ParseFloat(job.Seconds, 64)
		result, err := replacementWorkerStep(ctx, job, "plan", "replacement-plan", map[string]any{"video": job.Source}, map[string]any{"seconds": seconds})
		if err != nil {
			return err
		}
		job.Parts = result.Metadata.Parts
		width, height := result.Metadata.Size[0], result.Metadata.Size[1]
		if width <= 0 || height <= 0 {
			return fmt.Errorf("原视频画幅不正确")
		}
		divisor := gcd(width, height)
		job.AspectRatio = fmt.Sprintf("%d:%d", width/divisor, height/divisor)
		if len(job.Parts) == 0 {
			return fmt.Errorf("没有可处理的片段")
		}
		job.Credits = 0
		if job.Model != "wan-video/wan-2.2-animate-replace" {
			user, _ := service.UserFromContext(ctx)
			channel, err := replacementModelChannel(ctx, job.Model, user.Group, false)
			if err != nil {
				return err
			}
			choices := service.VideoProfile(channel, job.Model).Seconds
			for i := range job.Parts {
				part := &job.Parts[i]
				for _, choice := range choices {
					value, err := strconv.ParseFloat(choice, 64)
					if err == nil && value >= part.InputEnd-part.InputStart && value < part.Seconds {
						part.Seconds = value
					}
				}
			}
		}
		for i := range job.Parts {
			price, err := quoteReplacementPart(ctx, job, &job.Parts[i])
			if err != nil {
				return err
			}
			job.Parts[i].Credits = price
			job.Credits += price
		}
		job.Planned = true
		job.Status, job.Step = "ready", "分段完成，等待确认整片模型费用"
		return saveReplacement(job)
	}
	for index := range job.Parts {
		if replacementControlFor(job.ID).pause.Load() {
			return fmt.Errorf("已暂停，成功片段和当前任务编号已保留")
		}
		part := &job.Parts[index]
		if part.Validated {
			continue
		}
		job.Step = fmt.Sprintf("处理第 %d / %d 段", index+1, len(job.Parts))
		if err := saveReplacement(job); err != nil {
			return err
		}
		if err := executeReplacementPart(ctx, job, index); err != nil {
			return err
		}
	}
	if replacementControlFor(job.ID).pause.Load() {
		return fmt.Errorf("已暂停，全部片段已保留")
	}
	if job.Assembled == "" {
		files := []string{}
		for _, part := range job.Parts {
			files = append(files, part.Generated)
		}
		job.Step = "按原时间轴拼接画面"
		if err := saveReplacement(job); err != nil {
			return err
		}
		result, err := replacementWorkerStep(ctx, job, "assemble", "replacement-assemble", map[string]any{"video": job.Source, "parts": files}, map[string]any{"parts": job.Parts})
		if err != nil {
			return err
		}
		job.Assembled = result.File
		if err := saveReplacement(job); err != nil {
			return err
		}
	}
	captions := []map[string]any{}
	for _, part := range job.Parts {
		for _, caption := range part.Captions {
			start, ok1 := caption["start"].(float64)
			end, ok2 := caption["end"].(float64)
			if !ok1 || !ok2 {
				return fmt.Errorf("字幕时间轴格式不正确")
			}
			start = math.Max(start+part.InputStart, part.Start)
			end = math.Min(end+part.InputStart, part.End)
			if end > start {
				captions = append(captions, map[string]any{"start": start, "end": end, "text": caption["text"]})
			}
		}
	}
	job.Step = "恢复完整原音轨并合成字幕"
	if err := saveReplacement(job); err != nil {
		return err
	}
	result, err := replacementWorkerStep(ctx, job, "finish", "replacement-finish", map[string]any{"source": job.Source, "video": job.Assembled}, map[string]any{"subtitles": captions, "subtitleSize": job.SubtitleSize, "subtitleColor": job.SubtitleColor})
	if err != nil {
		return err
	}
	if err := saveWorkerOwner(job.UserID, "media", result.File); err != nil {
		return err
	}
	job.Result, job.Status, job.Step = result.File, "completed", "已合成，请验收人物、口型与接缝"
	return saveReplacement(job)
}
func quoteReplacementPart(ctx context.Context, job *replacementJob, part *replacementPart) (int, error) {
	ctx = context.WithValue(ctx, replacementChannelKey{}, job.ChannelID)
	if job.Model == "wan-video/wan-2.2-animate-replace" {
		user, _ := service.UserFromContext(ctx)
		if _, err := replacementModelChannel(ctx, job.Model, user.Group, true); err != nil {
			return 0, err
		}
		spec, err := service.FindReplicateModel("replace-person")
		if err != nil {
			return 0, err
		}
		quote, err := service.QuoteReplicate(user, spec, map[string]any{"resolution": job.Resolution, "duration": part.Seconds})
		if err != nil {
			return 0, err
		}
		if !quote.Available {
			return 0, fmt.Errorf("%s", quote.Reason)
		}
		return quote.Credits, nil
	}
	raw, err := replacementCall(ctx, ModelQuote, "POST", "/api/v1/models/quote", map[string]any{"model": job.Model, "protocol": "openai", "resolution": job.Resolution, "seconds": strconv.FormatFloat(part.Seconds, 'f', -1, 64)}, nil)
	if err != nil {
		return 0, err
	}
	var quote struct {
		Credits int `json:"credits"`
	}
	err = json.Unmarshal(raw, &quote)
	return quote.Credits, err
}

func executeReplacementPart(ctx context.Context, job *replacementJob, index int) error {
	part := &job.Parts[index]
	prefix := strconv.Itoa(index) + ":"
	if part.Input == "" {
		result, err := replacementWorkerStep(ctx, job, prefix+"extract", "replacement-extract", map[string]any{"video": job.Source}, part)
		if err != nil {
			return err
		}
		part.Input = result.File
		if err := saveReplacement(job); err != nil {
			return err
		}
	}
	if part.Prepared == "" {
		if job.Subtitles {
			result, err := replacementWorkerStep(ctx, job, prefix+"prepare", "replacement-prepare", map[string]any{"video": part.Input}, map[string]any{})
			if err != nil {
				part.Prepared = ""
				return err
			}
			part.Prepared, part.Captions = result.File, result.Segments
		} else {
			part.Prepared = part.Input
		}
		if err := saveReplacement(job); err != nil {
			return err
		}
	}
	if part.Generated == "" {
		if part.Reference == "" {
			address, err := publishReplacementReference(ctx, job, part.Prepared, part.Seconds)
			if err != nil {
				return err
			}
			part.Reference = address
			if err := saveReplacement(job); err != nil {
				return err
			}
		}
		if !part.Submitted {
			current, found, err := repository.GetUserByID(job.UserID)
			if err != nil || !found || current.Status == model.UserStatusBan {
				return fmt.Errorf("账户状态已变化，已暂停后续收费生成")
			}
			ctx = service.WithUser(ctx, model.PublicUser(current))
			price, err := quoteReplacementPart(ctx, job, part)
			if err != nil {
				return err
			}
			if price != part.Credits {
				return fmt.Errorf("分段模型价格已变化，已暂停且未提交该段")
			}
			if replacementControlFor(job.ID).pause.Load() {
				return fmt.Errorf("已暂停，尚未提交下一次收费生成")
			}
			part.Submitted = true
			if job.Model == "wan-video/wan-2.2-animate-replace" {
				part.TaskID = uuid.NewString()
			}
			// Persist before sending. An ambiguous relay response never causes a resend.
			if err := saveReplacement(job); err != nil {
				return err
			}
			if job.Model == "wan-video/wan-2.2-animate-replace" {
				_, err = replacementCall(ctx, CreateReplicateTask, "POST", "/api/v1/replicate/tasks", map[string]any{"id": part.TaskID, "operation": "replace-person", "expectedCredits": part.Credits, "input": map[string]any{"video": part.Reference, "character_image": job.Image, "resolution": job.Resolution, "merge_audio": false}}, nil)
			} else {
				var raw json.RawMessage
				resolution := job.Resolution
				if resolution != "2K" {
					resolution += "p"
				}
				raw, err = replacementCall(ctx, AIVideos, "POST", "/api/v1/videos", map[string]any{"model": job.Model, "prompt": job.Prompt, "seconds": strconv.FormatFloat(part.Seconds, 'f', -1, 64), "resolution": resolution, "input_mode": "reference", "aspect_ratio": job.AspectRatio, "image_url": job.Image, "reference_videos": []string{part.Reference}}, &part.Credits)
				if err == nil {
					part.TaskID = videoResponseString(raw, "id", "task_id")
					if part.TaskID == "" {
						err = fmt.Errorf("上游未返回任务编号，请核对后恢复；不会自动重新收费")
					}
				}
			}
			if saveErr := saveReplacement(job); saveErr != nil {
				return saveErr
			}
			if err != nil {
				return err
			}
		}
		if part.TaskID == "" {
			return fmt.Errorf("该段提交结果尚未确认，请管理员核对任务编号；不会重新创建收费任务")
		}
		if err := collectReplacementPart(ctx, job, part); err != nil {
			return err
		}
	}
	_, err := replacementWorkerStep(ctx, job, prefix+"validate", "replacement-validate", map[string]any{"source": part.Input, "video": part.Generated}, map[string]any{})
	if err != nil {
		return err
	}
	part.Validated = true
	return saveReplacement(job)
}
func publishReplacementReference(ctx context.Context, job *replacementJob, file string, seconds float64) (string, error) {
	resp, err := replacementWorkerRequest(ctx, "GET", "/media/"+url.PathEscape(file), nil, "")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := os.MkdirAll(referenceMediaDir(), 0755); err != nil {
		return "", err
	}
	id := uuid.NewString() + ".mp4"
	path := filepath.Join(referenceMediaDir(), id)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, referenceVideoMaxBytes+1))
	closeErr := f.Close()
	if err != nil || closeErr != nil || n == 0 || n > referenceVideoMaxBytes {
		_ = os.Remove(path)
		return "", fmt.Errorf("片段保存失败或超过现有素材大小限制")
	}
	if err := repository.SaveReferenceMediaOwner(model.ReferenceMediaOwner{ID: id, UserID: job.UserID, MimeType: "video/mp4", Bytes: n, DurationSeconds: seconds}); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return strings.TrimRight(config.Cfg.PublicBaseURL, "/") + "/api/media/references/" + id, nil
}

func collectReplacementPart(ctx context.Context, job *replacementJob, part *replacementPart) error {
	for {
		var done bool
		if job.Model == "wan-video/wan-2.2-animate-replace" {
			raw, err := replacementCall(ctx, func(w http.ResponseWriter, r *http.Request) { ReadReplicateTask(w, r, part.TaskID) }, "GET", "/api/v1/replicate/tasks/"+url.PathEscape(part.TaskID), nil, nil)
			if err != nil {
				return err
			}
			var state model.ReplicateTask
			if err := json.Unmarshal(raw, &state); err != nil {
				return err
			}
			if state.Status == "failed" || state.Status == "cancelled" || state.Status == "uncertain" {
				return fmt.Errorf("该段云任务未成功：%s；成功片段已保留，不会自动重试", state.Error)
			}
			done = state.Status == "completed"
		} else {
			raw, err := replacementCall(ctx, func(w http.ResponseWriter, r *http.Request) { AIVideo(w, r, part.TaskID) }, "GET", "/api/v1/videos/"+url.PathEscape(part.TaskID)+"?model="+url.QueryEscape(job.Model), nil, nil)
			if err != nil {
				return err
			}
			status := videoResponseString(raw, "status")
			if status == "failed" || status == "cancelled" || status == "canceled" || status == "expired" {
				return fmt.Errorf("该段云任务失败，已保留任务编号和成功片段；不会自动重试")
			}
			done = status == "completed" || status == "succeeded" || status == "success"
		}
		if done {
			break
		}
		if replacementControlFor(job.ID).pause.Load() {
			return fmt.Errorf("已暂停后续提交，当前云任务仍在运行；恢复时只查询已有任务")
		}
		time.Sleep(2 * time.Second)
	}
	// Download using the existing ownership-checked content handler into a file.
	temporary, err := os.CreateTemp(filepath.Join(referenceDataDir(), "replacement-jobs"), "result-*.mp4")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	w := &replacementFileResponse{file: temporary, header: http.Header{}, status: 200}
	r, _ := http.NewRequestWithContext(ctx, "GET", "/api/v1/videos/"+url.PathEscape(part.TaskID)+"/content?model="+url.QueryEscape(job.Model), nil)
	if job.Model == "wan-video/wan-2.2-animate-replace" {
		ReplicateTaskContent(w, r, part.TaskID)
	} else {
		AIVideoContent(w, r, part.TaskID)
	}
	closeErr := temporary.Close()
	if w.err != nil || closeErr != nil || w.status >= 400 || strings.Contains(w.header.Get("Content-Type"), "json") {
		return fmt.Errorf("成片下载未完成，请恢复查询；不会重复生成")
	}
	file, err := uploadReplacementResult(ctx, temporary.Name())
	if err != nil {
		return err
	}
	part.Generated = file
	return saveReplacement(job)
}

type replacementFileResponse struct {
	file   *os.File
	header http.Header
	status int
	err    error
}

func (w *replacementFileResponse) Header() http.Header { return w.header }
func (w *replacementFileResponse) WriteHeader(s int)   { w.status = s }
func (w *replacementFileResponse) Write(p []byte) (int, error) {
	n, err := w.file.Write(p)
	w.err = err
	return n, err
}
func uploadReplacementResult(ctx context.Context, path string) (string, error) {
	reader, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	go func() {
		file, err := os.Open(path)
		if err != nil {
			_ = writer.CloseWithError(err)
			return
		}
		defer file.Close()
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="file"; filename="generated.mp4"`)
		header.Set("Content-Type", "video/mp4")
		part, err := form.CreatePart(header)
		if err == nil {
			_, err = io.Copy(part, file)
		}
		if err == nil {
			err = form.Close()
		}
		_ = writer.CloseWithError(err)
	}()
	defer reader.Close()
	resp, err := replacementWorkerRequest(ctx, "POST", "/media", reader, form.FormDataContentType())
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.ID == "" {
		return "", fmt.Errorf("保存成片未返回编号")
	}
	return result.ID, nil
}
