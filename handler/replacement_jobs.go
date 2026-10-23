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
	Result        string           `json:"result,omitempty"`
	PreviousTasks []string         `json:"previousTasks,omitempty"`
	Captions      []map[string]any `json:"captions,omitempty"`
	Credits       int              `json:"credits"`
}
type replacementCaption struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}
type replacementJob struct {
	PlatformModelID      string               `json:"platformModelId,omitempty"`
	ModelLabel           string               `json:"modelLabel,omitempty"`
	FeatureID            string               `json:"featureId,omitempty"`
	ConfigRevision       int                  `json:"configRevision,omitempty"`
	ModelAdapter         string               `json:"modelAdapter,omitempty"`
	ID                   string               `json:"id"`
	UserID               string               `json:"userId"`
	Source               string               `json:"source"`
	Image                string               `json:"image"`
	Model                string               `json:"model"`
	ChannelID            int                  `json:"channelId"`
	Resolution           string               `json:"resolution"`
	Seconds              string               `json:"seconds"`
	Prompt               string               `json:"prompt"`
	Subtitles            bool                 `json:"subtitles"`
	RegenerateSubtitles  bool                 `json:"regenerateSubtitles"`
	SubtitleSize         float64              `json:"subtitleSize"`
	SubtitleColor        string               `json:"subtitleColor"`
	SubtitleFont         string               `json:"subtitleFont"`
	SubtitleMethod       string               `json:"subtitleMethod,omitempty"`
	SubtitleOutput       string               `json:"subtitleOutput,omitempty"`
	CaptionSegments      []replacementCaption `json:"captionSegments,omitempty"`
	CaptionRevision      int                  `json:"captionRevision"`
	CaptionStatus        string               `json:"captionStatus,omitempty"`
	CaptionError         string               `json:"captionError,omitempty"`
	CaptionResult        string               `json:"captionResult,omitempty"`
	SubtitleBottom       float64              `json:"subtitleBottom"`
	PreparedSource       string               `json:"preparedSource,omitempty"`
	Status               string               `json:"status"`
	Step                 string               `json:"step"`
	Error                string               `json:"error,omitempty"`
	Credits              int                  `json:"credits"`
	Parts                []replacementPart    `json:"parts"`
	Planned              bool                 `json:"planned"`
	SelectionMode        bool                 `json:"selectionMode"`
	SelectedParts        []int                `json:"selectedParts,omitempty"`
	PreviewRequired      bool                 `json:"previewRequired"`
	PreviewReady         bool                 `json:"previewReady"`
	PreviewApproved      bool                 `json:"previewApproved"`
	PreviewResult        string               `json:"previewResult,omitempty"`
	AspectRatio          string               `json:"aspectRatio"`
	RequestedAspectRatio string               `json:"requestedAspectRatio,omitempty"`
	SourceSize           [2]int               `json:"sourceSize"`
	FittedSource         string               `json:"fittedSource,omitempty"`
	WorkerStep           string               `json:"workerStep,omitempty"`
	WorkerID             string               `json:"workerId,omitempty"`
	Assembled            string               `json:"assembled,omitempty"`
	Result               string               `json:"result,omitempty"`
	PreviousResults      []string             `json:"previousResults,omitempty"`
	Reviewed             bool                 `json:"reviewed"`
	Archived             bool                 `json:"archived"`
	CreatedAt            string               `json:"createdAt"`
	UpdatedAt            string               `json:"updatedAt"`
}
type replacementControl struct {
	running atomic.Bool
	pause   atomic.Bool
	mu      sync.Mutex
}

var replacementControls sync.Map

func publicReplacementJob(job replacementJob) replacementJob {
	if job.PlatformModelID != "" {
		real := job.Model
		job.Model, job.ChannelID = job.PlatformModelID, 0
		if job.Error != "" {
			job.Error = strings.ReplaceAll(job.Error, real, job.ModelLabel)
		}
	}
	return job
}

func replacementManagedContext(ctx context.Context, job *replacementJob) (context.Context, error) {
	enabled, err := service.ManagementEnabled()
	if err != nil || !enabled {
		return ctx, err
	}
	if job.PlatformModelID == "" {
		return ctx, fmt.Errorf("模型目录已升级，旧任务仍可查询已有片段；新增生成请重新选择功能模型")
	}
	user, _ := service.UserFromContext(ctx)
	selected, err := service.ResolveManagedModel(job.FeatureID, job.PlatformModelID, user.Group, job.ChannelID)
	if err != nil {
		return ctx, err
	}
	if selected.Revision != job.ConfigRevision || selected.Route.Model != job.Model {
		return ctx, fmt.Errorf("功能模型配置已变化，后续收费片段已暂停；已有结果和任务均已保留")
	}
	return service.WithManagedSelection(ctx, selected), nil
}

func replacementCloudOperation(name string) string {
	switch name {
	case "wan-video/wan-2.2-animate-replace":
		return "replace-person"
	case "wavespeed-ai/video-head-swap":
		return "head-swap"
	default:
		return ""
	}
}

func replacementSource(job *replacementJob) string {
	return firstReplacementText(job.FittedSource, job.Source)
}

func replacementAspectMatches(ratio string, width, height int) bool {
	var w, h int
	_, err := fmt.Sscanf(ratio, "%d:%d", &w, &h)
	return err == nil && width > 0 && height > 0 && w > 0 && h > 0 && width*h == height*w
}

func nearestReplacementAspect(resolution string, width, height int) string {
	best, distance := "", math.Inf(1)
	for _, ratio := range service.SparkCineH3AspectRatios(resolution) {
		var w, h float64
		_, _ = fmt.Sscanf(ratio, "%f:%f", &w, &h)
		current := math.Abs(math.Log(w / h / (float64(width) / float64(height))))
		if current < distance {
			best, distance = ratio, current
		}
	}
	return best
}

func canChangeReplacementAspect(job *replacementJob) bool {
	if job.Archived || job.Result != "" || job.Assembled != "" || job.PreviewResult != "" {
		return false
	}
	for _, part := range job.Parts {
		if part.Submitted || part.TaskID != "" || part.Generated != "" || part.Result != "" || part.Validated || len(part.PreviousTasks) > 0 {
			return false
		}
	}
	return true
}

func replacementCloudInput(job *replacementJob, part *replacementPart) map[string]any {
	if replacementCloudOperation(job.Model) == "head-swap" {
		return map[string]any{"video": part.Reference, "face_image": job.Image, "resolution": job.Resolution + "p"}
	}
	return map[string]any{"video": part.Reference, "character_image": job.Image, "resolution": job.Resolution, "merge_audio": false}
}

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
		Parts          []replacementPart `json:"parts"`
		Size           [2]int            `json:"size"`
		SubtitleMethod string            `json:"subtitleMethod"`
		SubtitleOutput string            `json:"subtitleOutput"`
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
				jobs = append(jobs, publicReplacementJob(job))
			}
		}
		OK(w, jobs)
		return
	}
	var request struct {
		ID                  string  `json:"id"`
		Source              string  `json:"source"`
		Image               string  `json:"image"`
		Model               string  `json:"model"`
		FeatureID           string  `json:"featureId"`
		Resolution          string  `json:"resolution"`
		Seconds             string  `json:"seconds"`
		AspectRatio         string  `json:"aspectRatio"`
		Prompt              string  `json:"prompt"`
		Subtitles           bool    `json:"subtitles"`
		RegenerateSubtitles bool    `json:"regenerateSubtitles"`
		SubtitleSize        float64 `json:"subtitleSize"`
		SubtitleColor       string  `json:"subtitleColor"`
		PreviewRequired     bool    `json:"previewRequired"`
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
		OK(w, publicReplacementJob(job))
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
		Resolution: request.Resolution, Seconds: request.Seconds, RequestedAspectRatio: request.AspectRatio, Prompt: request.Prompt, Subtitles: request.Subtitles, RegenerateSubtitles: request.Subtitles && request.RegenerateSubtitles,
		SubtitleSize: request.SubtitleSize, SubtitleColor: request.SubtitleColor, PreviewRequired: request.PreviewRequired, Status: "planning", Step: "分析镜头与分段费用", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if enabled, err := service.ManagementEnabled(); err != nil || enabled {
		if err == nil && request.FeatureID != "replace.person" && request.FeatureID != "replace.head" {
			err = fmt.Errorf("请选择人物替换或换脸功能模型")
		}
		var selected *service.ManagedSelection
		if err == nil {
			selected, err = service.ResolveManagedModel(request.FeatureID, request.Model, user.Group, 0)
		}
		if err != nil {
			control.running.Store(false)
			Fail(w, err.Error())
			return
		}
		job.PlatformModelID, job.FeatureID, job.ConfigRevision = selected.Model.ID, selected.Feature.ID, selected.Revision
		job.ModelAdapter = selected.Route.Adapter
		job.ModelLabel, job.Model, job.ChannelID = service.ManagedLabel(selected.Model, []model.ManagedRoute{selected.Route}), selected.Route.Model, selected.Channel.ID
		r = r.WithContext(service.WithManagedSelection(r.Context(), selected))
	}
	if job.Subtitles {
		job.SubtitleMethod = "cloud-joint"
		job.SubtitleOutput = "editable"
		job.SubtitleBottom = 0.08
		job.SubtitleFont = "Noto Sans CJK SC"
		job.Prompt += " 同时去除原片画面叠加的全部口播字幕，补全被遮挡的衣服和背景，不生成新字幕、标题、水印。保留招牌、商标、商品包装与真实环境文字，保留动作、镜头、时长和原音轨。"
	}
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
	OK(w, publicReplacementJob(job))
	go runReplacement(service.WithUser(context.Background(), user), job, true)
}
func markReplacementPaused(job *replacementJob) {
	if (job.Status == "running" || job.Status == "planning") && !replacementControlFor(job.ID).running.Load() {
		job.Status = "paused"
		job.Error = "服务已重启，可恢复查询已有任务；不会自动重发收费请求"
	}
	if (job.CaptionStatus == "recognizing" || job.CaptionStatus == "rendering") && !replacementControlFor(job.ID).running.Load() {
		job.CaptionStatus = "failed"
		job.CaptionError = "字幕处理服务已重启；无字幕原版和已保存字幕均已保留，可重新识别或合成。"
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
		OK(w, publicReplacementJob(job))
		return
	}
	if action == "archive" || action == "unarchive" {
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "任务或字幕仍在处理中，请等待完成或暂停后归档")
			return
		}
		defer c.running.Store(false)
		job, err = loadReplacement(id, user.ID)
		if err != nil {
			Fail(w, "读取任务失败")
			return
		}
		job.Archived = action == "archive"
		if err := saveReplacement(&job); err != nil {
			Fail(w, "保存归档状态失败")
			return
		}
		OK(w, publicReplacementJob(job))
		return
	}
	if job.Archived {
		Fail(w, "请先在历史任务中取消归档，再继续处理")
		return
	}
	if action == "pause" {
		c.pause.Store(true)
		OK(w, map[string]any{"message": "将在当前步骤结束并保存结果后暂停"})
		return
	}
	if action == "set-aspect-ratio" {
		var input struct {
			AspectRatio string `json:"aspectRatio"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.AspectRatio == "" {
			Fail(w, "请选择生成画幅")
			return
		}
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "任务正在运行，请等待分析完成或暂停")
			return
		}
		job, err = loadReplacement(id, user.ID)
		if err != nil || !canChangeReplacementAspect(&job) {
			c.running.Store(false)
			Fail(w, "已有片段提交生成，不能修改此任务画幅；请新建任务")
			return
		}
		channel, err := replacementModelChannel(context.WithValue(r.Context(), replacementChannelKey{}, job.ChannelID), job.Model, user.Group, false)
		if err != nil || !service.IsSparkCineH3(channel, job.Model) {
			c.running.Store(false)
			Fail(w, "当前任务不支持调整生成画幅")
			return
		}
		if err := service.SparkCineH3SpecError(job.Resolution, input.AspectRatio, 4); err != nil {
			c.running.Store(false)
			Fail(w, err.Error())
			return
		}
		job.RequestedAspectRatio, job.AspectRatio, job.FittedSource = input.AspectRatio, "", ""
		job.Parts, job.SelectedParts = nil, nil
		job.Planned, job.SelectionMode, job.Credits = false, false, 0
		job.WorkerStep, job.WorkerID, job.Error = "", "", ""
		job.Status, job.Step = "planning", "按新画幅重新分析与报价"
		c.pause.Store(false)
		if err := saveReplacement(&job); err != nil {
			c.running.Store(false)
			Fail(w, "保存画幅失败")
			return
		}
		OK(w, publicReplacementJob(job))
		go runReplacement(service.WithUser(context.Background(), user), job, true)
		return
	}
	if action == "review" {
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "请等待任务完成")
			return
		}
		defer c.running.Store(false)
		job, err = loadReplacement(id, user.ID)
		if err != nil || job.Archived || job.Status != "completed" || job.Result == "" {
			Fail(w, "任务尚未完成")
			return
		}
		job.Reviewed = true
		if err := saveReplacement(&job); err != nil {
			Fail(w, "保存验收状态失败")
			return
		}
		OK(w, publicReplacementJob(job))
		return
	}
	if action == "save-captions" {
		var input struct {
			Revision int                  `json:"revision"`
			Segments []replacementCaption `json:"segments"`
			Size     float64              `json:"size"`
			Color    string               `json:"color"`
			Bottom   float64              `json:"bottom"`
			Font     string               `json:"font"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			Fail(w, "字幕内容格式不正确")
			return
		}
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "字幕处理正在进行，请稍后")
			return
		}
		defer c.running.Store(false)
		job, err = loadReplacement(id, user.ID)
		if err != nil || job.Archived || job.Status != "completed" || job.Result == "" || job.SubtitleOutput != "editable" {
			Fail(w, "无字幕成片尚未完成")
			return
		}
		if input.Revision != job.CaptionRevision {
			Fail(w, "字幕已在其他页面更新，请刷新后再编辑")
			return
		}
		if err := validateReplacementCaptions(input.Segments, replacementDuration(&job)); len(input.Segments) > 0 && err != nil {
			Fail(w, err.Error())
			return
		}
		if math.IsNaN(input.Size) || math.IsInf(input.Size, 0) || input.Size <= 0 || math.IsNaN(input.Bottom) || math.IsInf(input.Bottom, 0) || input.Bottom < 0 || input.Bottom >= 1 || !validReplacementColor(input.Color) || !validReplacementFont(input.Font) {
			Fail(w, "字幕样式不正确")
			return
		}
		if job.CaptionResult != "" {
			job.PreviousResults = append(job.PreviousResults, job.CaptionResult)
		}
		job.CaptionResult = ""
		job.Reviewed = false
		job.CaptionSegments, job.SubtitleSize, job.SubtitleColor, job.SubtitleBottom, job.SubtitleFont = input.Segments, input.Size, input.Color, input.Bottom, input.Font
		job.CaptionRevision++
		job.CaptionStatus, job.CaptionError, job.WorkerStep, job.WorkerID = "draft", "", "", ""
		job.Step = "无字幕成片已保存，字幕草稿待校对"
		if err := saveReplacement(&job); err != nil {
			Fail(w, "保存字幕失败")
			return
		}
		OK(w, publicReplacementJob(job))
		return
	}
	if action == "recognize-captions" || action == "render-captions" {
		var input struct {
			Revision int `json:"revision"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			Fail(w, "字幕请求格式不正确")
			return
		}
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "字幕处理正在进行，请稍后")
			return
		}
		job, err = loadReplacement(id, user.ID)
		if err != nil || job.Archived || job.Status != "completed" || job.Result == "" || job.SubtitleOutput != "editable" {
			c.running.Store(false)
			Fail(w, "无字幕成片尚未完成")
			return
		}
		if input.Revision != job.CaptionRevision {
			c.running.Store(false)
			Fail(w, "字幕已在其他页面更新，请重新载入后操作")
			return
		}
		job.Reviewed = false
		if action == "render-captions" {
			if len(job.CaptionSegments) == 0 || validateReplacementCaptions(job.CaptionSegments, replacementDuration(&job)) != nil {
				c.running.Store(false)
				Fail(w, "请先保存有效字幕")
				return
			}
			job.CaptionStatus = "rendering"
			job.Step = "正在合成已校对的字幕"
		} else {
			if job.CaptionStatus != "recognizing" {
				if job.CaptionResult != "" {
					job.PreviousResults = append(job.PreviousResults, job.CaptionResult)
				}
				job.CaptionResult = ""
				if job.CaptionStatus != "failed" || job.WorkerStep != "caption-transcribe" || job.WorkerID == "" {
					job.WorkerStep, job.WorkerID = "", ""
				}
			}
			job.CaptionStatus = "recognizing"
			job.Step = "无字幕成片已保存，正在重新识别原音轨"
		}
		job.CaptionError = ""
		if err := saveReplacement(&job); err != nil {
			c.running.Store(false)
			Fail(w, "保存字幕任务失败")
			return
		}
		OK(w, publicReplacementJob(job))
		if action == "render-captions" {
			go runReplacementCaptionRender(context.Background(), job)
		} else {
			go runReplacementCaptionRecognition(context.Background(), job)
		}
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
		if err != nil || job.Archived || !job.Planned || job.Status == "completed" {
			Fail(w, "该任务无需重新报价")
			return
		}
		if job.PlatformModelID != "" {
			selected, err := service.ResolveManagedModel(job.FeatureID, job.PlatformModelID, user.Group, job.ChannelID)
			if err != nil {
				Fail(w, err.Error())
				return
			}
			if selected != nil {
				if selected.Route.Model != job.Model {
					Fail(w, "原任务模型身份已变化，请联系管理员")
					return
				}
				job.ConfigRevision = selected.Revision
			}
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
		OK(w, publicReplacementJob(job))
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
		if err != nil || job.Archived || input.Part >= len(job.Parts) {
			Fail(w, "任务已变化，请刷新")
			return
		}
		part := &job.Parts[input.Part]
		if part.TaskID == "" {
			Fail(w, "提交状态不明确，不能重新收费；请管理员先核对原任务")
			return
		}
		status := ""
		if replacementCloudOperation(job.Model) != "" {
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
		part.Result = ""
		if input.Part == 0 && job.PreviewRequired && !job.PreviewApproved {
			job.PreviewReady, job.PreviewResult = false, ""
		}
		job.Credits += price
		if job.Result != "" {
			job.PreviousResults = append(job.PreviousResults, job.Result)
		}
		if job.CaptionResult != "" {
			job.PreviousResults = append(job.PreviousResults, job.CaptionResult)
		}
		job.Reviewed = false
		job.CaptionResult, job.CaptionError = "", ""
		if job.SubtitleOutput == "editable" {
			job.CaptionStatus = "draft"
		}
		job.Assembled, job.Result, job.WorkerStep, job.WorkerID = "", "", "", ""
		job.Status, job.Error, job.Step = "ready", "", "已保留其他片段，请确认预算后处理重做片段"
		if err := saveReplacement(&job); err != nil {
			Fail(w, "保存重做计划失败")
			return
		}
		OK(w, publicReplacementJob(job))
		return
	}
	if action == "generate-parts" {
		var input struct {
			Parts           []int `json:"parts"`
			ExpectedCredits int   `json:"expectedCredits"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			Fail(w, "请选择需要生成的片段")
			return
		}
		if !c.running.CompareAndSwap(false, true) {
			Fail(w, "任务正在运行，请等待或先暂停")
			return
		}
		job, err = loadReplacement(id, user.ID)
		if err == nil {
			err = selectReplacementParts(&job, input.Parts, input.ExpectedCredits)
		}
		if err != nil {
			c.running.Store(false)
			Fail(w, err.Error())
			return
		}
		c.pause.Store(false)
		job.Status, job.Error = "running", ""
		if err := saveReplacement(&job); err != nil {
			c.running.Store(false)
			Fail(w, "保存所选片段失败")
			return
		}
		OK(w, publicReplacementJob(job))
		go runReplacement(service.WithUser(context.Background(), user), job, false)
		return
	}
	if action != "start" {
		http.NotFound(w, r)
		return
	}
	var input struct {
		ExpectedCredits int    `json:"expectedCredits"`
		ApprovePreview  bool   `json:"approvePreview"`
		PreviewResult   string `json:"previewResult"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.ExpectedCredits != job.Credits {
		Fail(w, "请核对整片报价后开始")
		return
	}
	if job.Status == "completed" {
		OK(w, publicReplacementJob(job))
		return
	}
	if !c.running.CompareAndSwap(false, true) {
		Fail(w, "任务正在运行")
		return
	}
	job, err = loadReplacement(id, user.ID)
	if err != nil || job.Archived || input.ExpectedCredits != job.Credits {
		c.running.Store(false)
		Fail(w, "任务已变化，请重新确认费用")
		return
	}
	if job.Status == "completed" {
		c.running.Store(false)
		OK(w, publicReplacementJob(job))
		return
	}
	if job.PreviewRequired && job.PreviewReady && !job.PreviewApproved {
		if !input.ApprovePreview || job.PreviewResult == "" || input.PreviewResult != job.PreviewResult || len(job.Parts) == 0 || !job.Parts[0].Validated {
			c.running.Store(false)
			Fail(w, "请先确认预览效果，再继续处理剩余片段")
			return
		}
		job.PreviewApproved = true
	} else if input.ApprovePreview {
		c.running.Store(false)
		Fail(w, "预览片段尚未完成，暂时不能继续")
		return
	}
	c.pause.Store(false)
	job.Status, job.Error = "running", ""
	if err := saveReplacement(&job); err != nil {
		c.running.Store(false)
		Fail(w, "保存任务失败")
		return
	}
	OK(w, publicReplacementJob(job))
	go runReplacement(service.WithUser(context.Background(), user), job, !job.Planned)
}

// A selection is an explicit spending boundary, persisted before any paid call.
func selectReplacementParts(job *replacementJob, indices []int, expected int) error {
	if job.Archived || !job.Planned || job.Status == "completed" {
		return fmt.Errorf("任务状态已变化，请刷新")
	}
	// Older preview jobs already have an independently finished first clip;
	// expose it to the new selection flow without charging or regenerating it.
	if len(job.Parts) > 0 && job.Parts[0].Result == "" && job.Parts[0].Validated && job.PreviewResult != "" {
		job.Parts[0].Result = job.PreviewResult
	}
	seen := make(map[int]bool)
	credits := 0
	for _, index := range indices {
		if index < 0 || index >= len(job.Parts) || seen[index] {
			return fmt.Errorf("片段选择无效，请刷新后重新选择")
		}
		seen[index] = true
		part := job.Parts[index]
		if part.Validated && part.Result != "" {
			continue
		}
		if !part.Submitted && !part.Validated {
			credits += part.Credits
		}
	}
	allComplete := true
	for index, part := range job.Parts {
		allComplete = allComplete && part.Validated
		// Keep the in-flight reversible step and any paid submission recoverable.
		started := part.Submitted || strings.HasPrefix(job.WorkerStep, strconv.Itoa(index)+":")
		if started && (!part.Validated || job.SelectionMode && part.Result == "") && !seen[index] {
			return fmt.Errorf("请保留第 %d 段以恢复已有处理，不会重新提交已收费任务", index+1)
		}
	}
	if len(indices) == 0 && !allComplete || credits != expected {
		return fmt.Errorf("所选片段或报价已变化，请重新核对")
	}
	// Resume the saved worker step before switching to another segment.
	ordered := append([]int{}, indices...)
	for i, index := range ordered {
		if strings.HasPrefix(job.WorkerStep, strconv.Itoa(index)+":") {
			ordered[0], ordered[i] = ordered[i], ordered[0]
			break
		}
	}
	job.SelectionMode, job.SelectedParts = true, ordered
	return nil
}

func validateReplacementRequest(ctx context.Context, job *replacementJob) error {
	var err error
	ctx, err = replacementManagedContext(ctx, job)
	if err != nil {
		return err
	}
	if err := validateReplacementSubtitles(job); err != nil {
		return err
	}
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
	if replacementCloudOperation(job.Model) != "" {
		channel, err := replacementModelChannel(ctx, job.Model, user.Group, true)
		if err != nil {
			return err
		}
		job.ChannelID = channel.ID
		if job.Resolution != "480" && job.Resolution != "720" {
			return fmt.Errorf("当前替换模型支持 480 / 720")
		}
	} else {
		channel, err := replacementModelChannel(ctx, job.Model, user.Group, false)
		if err != nil {
			return err
		}
		job.ChannelID = channel.ID
		profile := service.VideoProfile(channel, job.Model)
		if (job.PlatformModelID == "" && (profile.ContentReplacement == nil || !*profile.ContentReplacement)) || profile.MaxVideos < 1 || profile.MaxImages < 1 || profile.Interface == "unavailable" {
			return fmt.Errorf("该渠道未开启内容替换或未配置图片加视频参考能力")
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
		if profile.ReferenceVideoMaxSeconds > 0 && seconds > profile.ReferenceVideoMaxSeconds {
			return fmt.Errorf("当前渠道参考视频最多 %g 秒，请缩短分段", profile.ReferenceVideoMaxSeconds)
		}
		if service.IsSparkCineH3(channel, job.Model) {
			if job.RequestedAspectRatio != "" {
				if err := service.SparkCineH3SpecError(job.Resolution, job.RequestedAspectRatio, 4); err != nil {
					return err
				}
			}
			if err := validateSparkCineReference("image", job.Image, job.UserID); err != nil {
				return err
			}
		}
		if (job.ModelAdapter == "video.wan30" || job.ModelAdapter == "" && strings.EqualFold(job.Model, "wan30-720p")) && seconds > 30 {
			return fmt.Errorf("Wan30 当前参考视频接入支持 1–30 秒，请选择不超过 30 秒的分段")
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
	needed := []string{"replacement-plan", "replacement-extract", "replacement-validate", "replacement-assemble", "replacement-segment", "replacement-finish"}
	if replacementCloudOperation(job.Model) == "" {
		channel, err := replacementModelChannel(ctx, job.Model, user.Group, false)
		if err != nil {
			return err
		}
		if service.IsSparkCineH3(channel, job.Model) {
			needed = append(needed, "replacement-fit")
		}
	}
	if job.Subtitles {
		if job.RegenerateSubtitles {
			needed = append(needed, "replacement-transcribe", "replacement-render-captions")
		}
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
	if err := validateReplacementSubtitles(job); err != nil {
		return err
	}
	ctx = context.WithValue(ctx, replacementChannelKey{}, job.ChannelID)
	if planning {
		var err error
		ctx, err = replacementManagedContext(ctx, job)
		if err != nil {
			return err
		}
		seconds, _ := strconv.ParseFloat(job.Seconds, 64)
		seconds = math.Min(seconds, 15)
		result, err := replacementWorkerStep(ctx, job, "plan", "replacement-plan", map[string]any{"video": job.Source}, map[string]any{"seconds": seconds, "preserveScenes": false})
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
		job.SourceSize = result.Metadata.Size
		if len(job.Parts) == 0 {
			return fmt.Errorf("没有可处理的片段")
		}
		job.PreviewRequired = job.PreviewRequired || len(job.Parts) > 1 || replacementDuration(job) > 15
		job.Credits = 0
		if replacementCloudOperation(job.Model) == "" {
			user, _ := service.UserFromContext(ctx)
			channel, err := replacementModelChannel(ctx, job.Model, user.Group, false)
			if err != nil {
				return err
			}
			profile := service.VideoProfile(channel, job.Model)
			if service.IsSparkCineH3(channel, job.Model) {
				job.AspectRatio = firstReplacementText(job.RequestedAspectRatio, nearestReplacementAspect(job.Resolution, width, height))
				if err := service.SparkCineH3SpecError(job.Resolution, job.AspectRatio, 4); err != nil {
					return err
				}
			}
			choices := profile.Seconds
			for i := range job.Parts {
				part := &job.Parts[i]
				part.Seconds = math.Inf(1)
				for _, choice := range choices {
					value, err := strconv.ParseFloat(choice, 64)
					if err == nil && value >= part.InputEnd-part.InputStart && value < part.Seconds &&
						(profile.ReferenceVideoMaxSeconds == 0 || value <= profile.ReferenceVideoMaxSeconds) &&
						value >= profile.ReferenceVideoMinSeconds {
						part.Seconds = value
					}
				}
				if math.IsInf(part.Seconds, 1) {
					return fmt.Errorf("当前模型没有能够容纳此片段的时长档位")
				}
				if service.IsSparkCineH3(channel, job.Model) {
					if err := service.SparkCineH3SpecError(job.Resolution, job.AspectRatio, part.Seconds); err != nil {
						return err
					}
				}
			}
			if service.IsSparkCineH3(channel, job.Model) && !replacementAspectMatches(job.AspectRatio, width, height) && job.FittedSource == "" {
				fitted, err := replacementWorkerStep(ctx, job, "fit:"+job.AspectRatio, "replacement-fit", map[string]any{"video": job.Source}, map[string]any{"aspectRatio": job.AspectRatio})
				if err != nil {
					return err
				}
				fw, fh := fitted.Metadata.Size[0], fitted.Metadata.Size[1]
				if fitted.File == "" || !replacementAspectMatches(job.AspectRatio, fw, fh) {
					return fmt.Errorf("处理服务未返回所选画幅的视频，请更新视频处理服务后重新分析")
				}
				if err := saveWorkerOwner(job.UserID, "media", fitted.File); err != nil {
					return err
				}
				job.FittedSource = fitted.File
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
		job.Status, job.Step = "ready", "分段计划已就绪，等待确认生成费用"
		return saveReplacement(job)
	}
	// A saved first part must never allow a restart to bypass preview approval.
	if !job.SelectionMode && job.PreviewRequired && !job.PreviewApproved && len(job.Parts) > 0 && job.Parts[0].Validated {
		return finishReplacementPreview(ctx, job)
	}
	indices := job.SelectedParts
	if !job.SelectionMode {
		indices = make([]int, len(job.Parts))
		for i := range indices {
			indices[i] = i
		}
	}
	for _, index := range indices {
		if replacementControlFor(job.ID).pause.Load() {
			return fmt.Errorf("已暂停，成功片段和当前任务编号已保留")
		}
		part := &job.Parts[index]
		if part.Validated && (!job.SelectionMode || part.Result != "") {
			continue
		}
		job.Step = fmt.Sprintf("处理第 %d / %d 段", index+1, len(job.Parts))
		if err := saveReplacement(job); err != nil {
			return err
		}
		if !part.Validated {
			if err := executeReplacementPart(ctx, job, index); err != nil {
				return err
			}
		}
		if job.SelectionMode && part.Result == "" {
			result, err := replacementWorkerStep(ctx, job, strconv.Itoa(index)+":export", "replacement-segment", map[string]any{"source": replacementSource(job), "video": part.Generated, "input": part.Input}, map[string]any{"start": part.Start, "end": part.End, "trimStart": part.TrimStart})
			if err != nil {
				return err
			}
			if err := saveWorkerOwner(job.UserID, "media", result.File); err != nil {
				return err
			}
			part.Result = result.File
			if err := saveReplacement(job); err != nil {
				return err
			}
		}
		if !job.SelectionMode && job.PreviewRequired && !job.PreviewApproved {
			return finishReplacementPreview(ctx, job)
		}
	}
	for _, part := range job.Parts {
		if !part.Validated {
			job.Status, job.Step, job.Error = "ready", "所选片段已完成，可查看效果或继续勾选其他片段", ""
			return saveReplacement(job)
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
		result, err := replacementWorkerStep(ctx, job, "assemble", "replacement-assemble", map[string]any{"video": replacementSource(job), "parts": files}, map[string]any{"parts": job.Parts})
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
	job.Step = "恢复原音轨并完成视频后处理"
	if err := saveReplacement(job); err != nil {
		return err
	}
	options := map[string]any{"subtitles": captions, "subtitleSize": job.SubtitleSize, "subtitleColor": job.SubtitleColor}
	if job.Subtitles {
		options["subtitleOutput"] = "editable"
		options["subtitleBottom"] = job.SubtitleBottom
	}
	result, err := replacementWorkerStep(ctx, job, "finish", "replacement-finish", map[string]any{"source": replacementSource(job), "video": job.Assembled}, options)
	if err != nil {
		return err
	}
	if job.SubtitleOutput == "editable" && result.Metadata.SubtitleOutput != "editable" {
		job.WorkerStep, job.WorkerID = "", ""
		if err := saveReplacement(job); err != nil {
			return err
		}
		return fmt.Errorf("处理服务未返回独立的无字幕成片，请更新视频处理服务")
	}
	if err := saveWorkerOwner(job.UserID, "media", result.File); err != nil {
		return err
	}
	job.Result, job.Status, job.Step = result.File, "completed", "已合成，请验收人物、口型与接缝"
	if job.SubtitleOutput == "editable" {
		if len(job.CaptionSegments) > 0 {
			job.CaptionStatus, job.Step = "draft", "无字幕成片已保存，原字幕草稿待校对"
		} else if job.RegenerateSubtitles {
			job.CaptionStatus, job.Step = "recognizing", "无字幕成片已保存，正在识别原音轨"
		} else {
			job.CaptionStatus, job.CaptionError = "", ""
			job.Step = "无字幕成片已保存，请验收人物、口型与接缝"
		}
	}
	if err := saveReplacement(job); err != nil {
		return err
	}
	if job.SubtitleOutput == "editable" && job.CaptionStatus == "recognizing" {
		captionResult, err := replacementWorkerStep(ctx, job, "caption-transcribe", "replacement-transcribe", map[string]any{"video": job.Source}, map[string]any{})
		if err != nil {
			job.CaptionStatus, job.CaptionError = "failed", "字幕识别失败；无字幕成片已保留。可重试识别，不会重新生成视频。"
			job.WorkerStep, job.WorkerID = "", ""
			return saveReplacement(job)
		}
		encoded, _ := json.Marshal(captionResult.Segments)
		var segments []replacementCaption
		if err := json.Unmarshal(encoded, &segments); err != nil || validateReplacementCaptions(segments, replacementDuration(job)) != nil {
			job.CaptionStatus, job.CaptionError = "failed", "识别字幕格式不完整或没有识别到口播；无字幕成片已保留，可重新识别或手动添加字幕。"
			job.WorkerStep, job.WorkerID = "", ""
			return saveReplacement(job)
		}
		job.CaptionSegments = segments
		job.CaptionRevision++
		job.CaptionStatus, job.CaptionError = "draft", ""
		job.Step = "无字幕成片已保存，字幕草稿待校对"
		return saveReplacement(job)
	}
	return nil
}

func finishReplacementPreview(ctx context.Context, job *replacementJob) error {
	if job.PreviewResult == "" {
		part := &job.Parts[0]
		result, err := replacementWorkerStep(ctx, job, "preview-finish", "replacement-finish", map[string]any{"source": part.Input, "video": part.Generated}, map[string]any{})
		if err != nil {
			return err
		}
		job.PreviewResult = result.File
	}
	if err := saveWorkerOwner(job.UserID, "media", job.PreviewResult); err != nil {
		return err
	}
	job.Parts[0].Result = job.PreviewResult
	job.PreviewReady, job.Status, job.Step = true, "preview", "预览片段已完成，请确认效果后继续"
	return saveReplacement(job)
}

func replacementDuration(job *replacementJob) float64 {
	var duration float64
	for _, part := range job.Parts {
		if part.End > duration {
			duration = part.End
		}
	}
	return duration
}

func validReplacementColor(color string) bool {
	if len(color) != 7 || color[0] != '#' {
		return false
	}
	for _, char := range color[1:] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", char) {
			return false
		}
	}
	return true
}

func validReplacementFont(font string) bool {
	return font == "Noto Sans CJK SC" || font == "Noto Serif CJK SC"
}

func validateReplacementCaptions(captions []replacementCaption, duration float64) error {
	if len(captions) == 0 {
		return fmt.Errorf("请先添加字幕")
	}
	previousEnd := 0.0
	for _, caption := range captions {
		if math.IsNaN(caption.Start) || math.IsNaN(caption.End) || math.IsInf(caption.Start, 0) || math.IsInf(caption.End, 0) || caption.Start < 0 || caption.End <= caption.Start || caption.Start < previousEnd || (duration > 0 && caption.End > duration) || strings.TrimSpace(caption.Text) == "" {
			return fmt.Errorf("字幕时间轴或文案不正确；检查起止时间、顺序、视频长度和空字幕")
		}
		previousEnd = caption.End
	}
	return nil
}

func runReplacementCaptionRecognition(ctx context.Context, job replacementJob) {
	defer replacementControlFor(job.ID).running.Store(false)
	if err := resetFailedReplacementCaptionWorker(ctx, &job, "caption-transcribe"); err != nil {
		job.CaptionStatus, job.CaptionError = "failed", fmt.Sprintf("无法检查上次字幕识别任务：%v；无字幕成片已保留。", err)
		_ = saveReplacement(&job)
		return
	}
	result, err := replacementWorkerStep(ctx, &job, "caption-transcribe", "replacement-transcribe", map[string]any{"video": job.Source}, map[string]any{})
	if err != nil {
		job.CaptionStatus, job.CaptionError = "failed", fmt.Sprintf("字幕识别失败：%v；无字幕成片已保留。可重试识别，不会重新生成视频。", err)
		_ = saveReplacement(&job)
		return
	}
	encoded, _ := json.Marshal(result.Segments)
	var segments []replacementCaption
	if err := json.Unmarshal(encoded, &segments); err != nil || validateReplacementCaptions(segments, replacementDuration(&job)) != nil {
		job.CaptionStatus, job.CaptionError = "failed", "识别字幕格式不完整或没有识别到口播；无字幕成片已保留，可重新识别或手动添加字幕。"
		job.WorkerStep, job.WorkerID = "", ""
		_ = saveReplacement(&job)
		return
	}
	job.CaptionSegments = segments
	job.CaptionRevision++
	job.CaptionStatus, job.CaptionError = "draft", ""
	job.Step = "无字幕成片已保存，字幕草稿待校对"
	_ = saveReplacement(&job)
}

func runReplacementCaptionRender(ctx context.Context, job replacementJob) {
	defer replacementControlFor(job.ID).running.Store(false)
	if err := resetFailedReplacementCaptionWorker(ctx, &job, "caption-render"); err != nil {
		job.CaptionStatus, job.CaptionError = "failed", fmt.Sprintf("无法检查上次字幕合成任务：%v；无字幕成片和字幕稿均已保留。", err)
		_ = saveReplacement(&job)
		return
	}
	options := map[string]any{"subtitles": job.CaptionSegments, "subtitleSize": job.SubtitleSize, "subtitleColor": job.SubtitleColor, "subtitleBottom": job.SubtitleBottom, "subtitleFont": job.SubtitleFont}
	result, err := replacementWorkerStep(ctx, &job, "caption-render", "replacement-render-captions", map[string]any{"video": job.Result, "source": replacementSource(&job)}, options)
	if err == nil && result.Metadata.SubtitleOutput != "burned-in" {
		job.WorkerStep, job.WorkerID = "", ""
		err = fmt.Errorf("字幕处理服务未返回带字幕成片")
	}
	if err == nil {
		err = saveWorkerOwner(job.UserID, "media", result.File)
	}
	if err != nil {
		job.CaptionStatus, job.CaptionError = "failed", fmt.Sprintf("字幕合成失败：%v；无字幕成片和已校对字幕都已保留。可修改后重试。", err)
		_ = saveReplacement(&job)
		return
	}
	job.CaptionResult, job.CaptionStatus, job.CaptionError = result.File, "completed", ""
	job.Step = "无字幕版和带字幕版均已保存"
	_ = saveReplacement(&job)
}

func resetFailedReplacementCaptionWorker(ctx context.Context, job *replacementJob, step string) error {
	if job.WorkerStep != step || job.WorkerID == "" {
		return nil
	}
	var state struct {
		Status string `json:"status"`
	}
	if err := replacementWorkerJSON(ctx, "GET", "/jobs/"+url.PathEscape(job.WorkerID), nil, &state); err != nil {
		return err
	}
	if state.Status == "failed" || state.Status == "cancelled" {
		job.WorkerStep, job.WorkerID = "", ""
		return saveReplacement(job)
	}
	return nil
}
func quoteReplacementPart(ctx context.Context, job *replacementJob, part *replacementPart) (int, error) {
	var err error
	ctx, err = replacementManagedContext(ctx, job)
	if err != nil {
		return 0, err
	}
	ctx = context.WithValue(ctx, replacementChannelKey{}, job.ChannelID)
	if replacementCloudOperation(job.Model) != "" {
		user, _ := service.UserFromContext(ctx)
		if _, err := replacementModelChannel(ctx, job.Model, user.Group, true); err != nil {
			return 0, err
		}
		spec, err := service.FindReplicateModel(replacementCloudOperation(job.Model))
		if err != nil {
			return 0, err
		}
		resolution := job.Resolution
		if replacementCloudOperation(job.Model) == "head-swap" {
			resolution += "p"
		}
		quote, err := service.QuoteManagedReplicate(user, spec, map[string]any{"resolution": resolution, "duration": part.Seconds}, service.ManagedSelectionFromContext(ctx))
		if err != nil {
			return 0, err
		}
		if !quote.Available {
			return 0, fmt.Errorf("%s", quote.Reason)
		}
		return quote.Credits, nil
	}
	raw, err := replacementCall(ctx, ModelQuote, "POST", "/api/v1/models/quote", map[string]any{"model": job.Model, "protocol": "openai", "resolution": job.Resolution, "seconds": strconv.FormatFloat(part.Seconds, 'f', -1, 64), "aspect_ratio": job.AspectRatio}, nil)
	if err != nil {
		return 0, err
	}
	var quote struct {
		Credits int `json:"credits"`
	}
	err = json.Unmarshal(raw, &quote)
	return quote.Credits, err
}

func validateReplacementSubtitles(job *replacementJob) error {
	if !job.Subtitles {
		return nil
	}
	if job.SubtitleMethod != "cloud-joint" {
		return fmt.Errorf("旧字幕清理流程已下线，已有结果保留；请重新创建云端联合处理任务")
	}
	if job.ModelAdapter != "video.wan30" && (job.ModelAdapter != "" || !strings.EqualFold(job.Model, "wan30-720p")) {
		return fmt.Errorf("当前模型不支持联合去字幕，请关闭此项或先使用云端硬字幕去除工具处理原片")
	}
	return nil
}

func executeReplacementPart(ctx context.Context, job *replacementJob, index int) error {
	if err := validateReplacementSubtitles(job); err != nil {
		return err
	}
	part := &job.Parts[index]
	prefix := strconv.Itoa(index) + ":"
	if part.Input == "" {
		result, err := replacementWorkerStep(ctx, job, prefix+"extract", "replacement-extract", map[string]any{"video": replacementSource(job)}, part)
		if err != nil {
			return err
		}
		part.Input = result.File
		if err := saveReplacement(job); err != nil {
			return err
		}
	}
	if part.Prepared == "" {
		part.Prepared = part.Input
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
			ctx, err = replacementManagedContext(ctx, job)
			if err != nil {
				return err
			}
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
			if replacementCloudOperation(job.Model) != "" {
				part.TaskID = uuid.NewString()
			}
			// Persist before sending. An ambiguous relay response never causes a resend.
			if err := saveReplacement(job); err != nil {
				return err
			}
			if replacementCloudOperation(job.Model) != "" {
				_, err = replacementCall(ctx, CreateReplicateTask, "POST", "/api/v1/replicate/tasks", map[string]any{"id": part.TaskID, "operation": replacementCloudOperation(job.Model), "expectedCredits": part.Credits, "input": replacementCloudInput(job, part)}, nil)
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
		if replacementCloudOperation(job.Model) != "" {
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
	if replacementCloudOperation(job.Model) != "" {
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
