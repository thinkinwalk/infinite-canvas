import axios from "axios";
import { videoProfile, videoInputMode, videoReferenceError } from "@/lib/video-capabilities";
import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { inferVideoRatio } from "@/lib/media-size";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelMatchesCapability, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { createReplicateTask, fetchReplicateResult, publicServiceText, quoteReplicate, readReplicateTask, REPLICATE_VIDEO_MODEL, HAILUO_VIDEO_MODEL, uploadReplicateReference, type ReplicateQuote } from "./replicate";

type VideoResponse = {
    id?: string;
    task_id?: string;
    status?: string;
    error?: { message?: string };
    url?: string;
    result_url?: string;
    video_url?: string;
    video?: { url?: string } | null;
    content?: { video_url?: string; url?: string } | string | null;
};
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id?: string;
    task_id?: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type ReferenceMediaUploadResponse = { id: string; url: string; mimeType: string; bytes: number };
type RequestOptions = { signal?: AbortSignal; expectedCredits?: number; onWaitState?: (state: VideoTaskWaitState) => void; confirmReplicate?: (quote: ReplicateQuote, signal?: AbortSignal) => Promise<void>; onTaskSubmitted?: (task: VideoGenerationTask) => Promise<void> };

export type VideoPrice = { credits: number; calculation: string };
export async function quoteVideoModel(config: AiConfig, model: string, signal?: AbortSignal): Promise<VideoPrice> {
    if (!model || !modelMatchesCapability(config, model, "video")) throw new Error("请选择可用的视频模型后重试");
    const response = await axios.post<ApiEnvelope<VideoPrice>>("/api/v1/models/quote", { model: modelOptionName(model), resolution: normalizeVideoResolution(config.vquality).replace(/p$/, ""), seconds: config.videoSeconds, interpolate: config.videoInterpolate === "true" }, { headers: aiHeaders({ ...config, channelMode: "remote" }, "application/json"), signal });
    return unwrapEnvelope(response.data, "视频报价读取失败");
}

function videoCreateHeaders(config: AiConfig, options?: RequestOptions, contentType?: string) {
    return { ...aiHeaders(config, contentType), ...(config.channelMode === "remote" && options?.expectedCredits !== undefined ? { "X-Expected-Credits": String(options.expectedCredits) } : {}) };
}

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "gemini" | "plugin" | "replicate"; model: string; createdAt?: number };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };
export type VideoTaskWaitState = "processing" | "background" | "query_interrupted";

export const VIDEO_ACTIVE_POLL_WINDOW_MS = 15 * 60 * 1000;
export const VIDEO_ACTIVE_POLL_INTERVAL_MS = 5000;
export const VIDEO_BACKGROUND_POLL_INTERVAL_MS = 30000;

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    if (config.channelMode === "remote") {
        const token = useUserStore.getState().token;
        return {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(contentType ? { "Content-Type": contentType } : {}),
        };
    }
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    return waitForVideoGenerationTask(config, task, options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const startedAt = task.createdAt || Date.now();
    let waitState: VideoTaskWaitState | undefined;
    const updateWaitState = (state: VideoTaskWaitState) => {
        if (waitState === state) return;
        waitState = state;
        options?.onWaitState?.(state);
    };
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
            const state = await pollVideoGenerationTask(config, task, options);
            if (state.status === "completed") return state.result;
            if (state.status === "failed") throw videoTaskFailed(state.error);
            updateWaitState(Date.now() - startedAt >= VIDEO_ACTIVE_POLL_WINDOW_MS ? "background" : "processing");
        } catch (error) {
            if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
            if (isAbortError(error) || isVideoTaskFailed(error)) throw error;
            updateWaitState("query_interrupted");
        }
        const interval = Date.now() - startedAt >= VIDEO_ACTIVE_POLL_WINDOW_MS ? VIDEO_BACKGROUND_POLL_INTERVAL_MS : VIDEO_ACTIVE_POLL_INTERVAL_MS;
        await waitForNextVideoPoll(interval, options?.signal);
    }
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    if (!selectedModel || !modelMatchesCapability(config, selectedModel, "video")) throw new Error("请选择可用的视频模型后重试");
    if (selectedModel === HAILUO_VIDEO_MODEL) {
        if (!options?.confirmReplicate) throw new Error("请确认平台视频服务费用");
        if (!prompt.trim()) throw new Error("请填写视频脚本");
        if (references.length > 1 || videoReferences.length || audioReferences.length) throw new Error("当前快速视频服务最多支持 1 张首帧图片，不支持视频或音频参考");
        const resolution = normalizeVideoResolution(config.vquality);
        const duration = Number(config.videoSeconds);
        if (!["768p", "1080p"].includes(resolution) || ![6, 10].includes(duration) || (resolution === "1080p" && duration !== 6)) throw new Error("当前快速视频服务的规格为 768p 6/10 秒，1080p 仅支持 6 秒");
        const input: Record<string, unknown> = { prompt, duration, resolution, prompt_optimizer: true };
        if (references[0]) {
            const reference = references[0];
            input.first_frame_image = await uploadReplicateReference({ url: reference.dataUrl, storageKey: reference.storageKey || "", bytes: 0, mimeType: reference.type, name: reference.name, kind: "image" }, options.signal);
        }
        const quote = await quoteReplicate("hailuo-video", input, options.signal);
        await options.confirmReplicate({ ...quote, inputSummary: `输入：${references.length ? "1张首帧图（图生视频）" : "纯文字（文生视频）"}；输出：${duration}秒 · ${resolution}` }, options.signal);
        options.signal?.throwIfAborted();
        const task: VideoGenerationTask = { id: nanoid(), provider: "replicate", model: selectedModel, createdAt: Date.now() };
        await options.onTaskSubmitted?.(task);
        await createReplicateTask(task.id, "hailuo-video", input, quote.credits, options.signal);
        return task;
    }
    if (selectedModel === REPLICATE_VIDEO_MODEL) {
        if (!options?.confirmReplicate) throw new Error("请确认平台视频服务费用");
        if (references.length < 1 || references.length > 2 || videoReferences.length || audioReferences.length) throw new Error("当前标准视频服务需要 1 张首帧图片，可加 1 张尾帧；不支持第 3 张图片、视频或音频参考");
        const resolution = normalizeVideoResolution(config.vquality);
        if (!["480p", "720p"].includes(resolution)) throw new Error("当前标准视频服务支持 480p 或 720p");
        if (!["5", "7.5"].includes(config.videoSeconds)) throw new Error("当前标准视频服务支持约 5 秒或 7.5 秒");
        const reference = references[0];
        const image = await uploadReplicateReference({ url: reference.dataUrl, storageKey: reference.storageKey || "", bytes: 0, mimeType: reference.type, name: reference.name, kind: "image" }, options.signal);
        const lastImage = references[1] ? await uploadReplicateReference({ url: references[1].dataUrl, storageKey: references[1].storageKey || "", bytes: 0, mimeType: references[1].type, name: references[1].name, kind: "image" }, options.signal) : undefined;
        const input = { image, ...(lastImage ? { last_image: lastImage } : {}), prompt, resolution, num_frames: config.videoSeconds === "7.5" ? 121 : 81, interpolate_output: config.videoInterpolate === "true" };
        const quote = await quoteReplicate("image-to-video", input, options.signal);
        await options.confirmReplicate({ ...quote, inputSummary: `输入：1张首帧图片${lastImage ? " + 1张尾帧图片" : "（不指定尾帧）"}；输出：约${config.videoSeconds}秒 · ${resolution}${config.videoInterpolate === "true" ? " · 插帧" : ""}` }, options.signal);
        options.signal?.throwIfAborted();
        const task: VideoGenerationTask = { id: nanoid(), provider: "replicate", model: selectedModel, createdAt: Date.now() };
        await options.onTaskSubmitted?.(task);
        await createReplicateTask(task.id, "image-to-video", input, quote.credits, options.signal);
        return task;
    }
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const profile = videoProfile(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, videoReferences, audioReferences, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (profile.interface === "unavailable") throw new Error(profile.description);
    const referenceError = videoReferenceError(config, selectedModel, references.length, videoReferences.length, audioReferences.length);
    if (referenceError) throw new Error(referenceError);
    if (profile.seconds.length && !profile.seconds.includes(config.videoSeconds)) throw new Error("当前模型不支持所选视频时长，请重新选择");
    if (profile.resolutions.length && !profile.resolutions.includes(normalizeVideoResolution(config.vquality).replace(/p$/, ""))) throw new Error("当前模型不支持所选分辨率，请重新选择");
    if (profile.interface === "relay") return createPidoiJsonVideoTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考资产");
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "replicate") {
        let job;
        try {
            job = await readReplicateTask(task.id, options?.signal);
        } catch (error) {
            if (error instanceof Error && error.name === "ReplicateTaskNotFound") return { status: "failed", error: "此账号下未找到已提交的任务，请检查登录账号、余额或重新确认制作" };
            throw error;
        }
        if (job.status === "failed" || job.status === "cancelled") return { status: "failed", error: publicServiceText(job.error || "任务未完成，算力点已返还") };
        if (job.status === "uncertain") throw new Error(publicServiceText(job.error || "提交状态待核对，请保留任务编号并联系管理员"));
        return job.status === "completed" ? { status: "completed", result: { blob: await fetchReplicateResult(task.id) } } : { status: "pending" };
    }
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    return task.provider === "seedance" ? pollSeedanceTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            videos: await Promise.all(videos.map(pluginMediaFile)),
            audios: await Promise.all(audios.map(pluginMediaFile)),
            params: {
                mode: videoInputMode(config, model) === "reference" ? "reference" : "frames",
                interpolate: config.videoInterpolate === "true",
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model, createdAt: Date.now() };
}

async function pluginMediaFile(media: ReferenceVideo | ReferenceAudio): Promise<File> {
    const stored = media.storageKey ? await getMediaBlob(media.storageKey) : null;
    const blob = stored || (await (await fetch(media.url)).blob());
    return new File([blob], media.name, { type: media.type || blob.type });
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error("视频接口没有返回可播放的视频");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (isPidoiJsonVideoModel(modelOptionName(model))) {
        return createPidoiJsonVideoTask(config, model, prompt, references, [], [], options);
    }
    const body = new FormData();
    const modelName = modelOptionName(model);
    const pidoiGrok = isPidoiGrokVideoModel(modelName);
    const seconds = normalizeVideoSeconds(config.videoSeconds);
    if (pidoiGrok && seconds !== "6" && seconds !== "10") throw new Error("Pidoi GROK 视频模型仅支持 6 秒或 10 秒");
    body.append("model", modelName);
    body.append("prompt", prompt);
    body.append("seconds", seconds);
    const size = normalizeVideoSize(config.size);
    if (size) body.append("size", size);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    if (pidoiGrok) {
        body.append("quality", normalizeVideoResolution(config.vquality) === "480p" ? "standard" : "high");
        const imageReferences = await resolvePidoiReferenceUrls(references, options);
        imageReferences.forEach((reference) => body.append("image_reference", reference));
    } else {
        body.append("preset", "normal");
        const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        const profile = videoProfile(config, model);
        const mode = videoInputMode(config, model);
        if (mode === "reference") files.forEach((file) => body.append("input_reference[]", file));
        else {
            body.append("mode", mode);
            if (files[0]) body.append(profile.firstFrameField!, files[0]);
            if (files[1]) body.append(profile.lastFrameField!, files[1]);
        }
    }
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: videoCreateHeaders(config, options), signal: options?.signal })).data);
        const taskID = videoTaskId(created);
        if (!taskID) throw new Error("视频接口没有返回任务 ID");
        return { id: taskID, provider: "openai", model, createdAt: Date.now() };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

/** Pidoi and compatible video relay endpoints use JSON, unlike stock OpenAI video multipart requests. */
async function createPidoiJsonVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const resolution = normalizeVideoResolution(config.vquality);
    const seconds = videoProfile(config, model).seconds.length ? config.videoSeconds : normalizePidoiVideoSeconds(modelName, config.videoSeconds, resolution);
    const imageUrls = await resolvePidoiReferenceUrls(references, options);
    const payload: Record<string, unknown> = {
        model: modelName,
        prompt: buildSeedancePromptText(prompt, references, videoReferences, audioReferences),
        seconds,
        aspect_ratio: inferVideoRatio(config.size) === "auto" ? "16:9" : inferVideoRatio(config.size),
        resolution,
    };
    const mode = videoInputMode(config, model);
    const profile = videoProfile(config, model);
    if (config.channelMode === "remote") payload.input_mode = mode;
    if (mode === "reference") {
        if (imageUrls[0]) payload.image_url = imageUrls[0];
        if (imageUrls.length > 1) payload.reference_image_urls = imageUrls.slice(1, 7);
    } else {
        payload.prompt = prompt.trim();
        if (imageUrls[0]) payload[profile.firstFrameField!] = imageUrls[0];
        if (imageUrls[1]) payload[profile.lastFrameField!] = imageUrls[1];
    }
    if (videoReferences.length) payload.reference_videos = await Promise.all(videoReferences.map((item) => resolveSeedanceVideoUrl(config, item, options)));
    if (audioReferences.length) payload.audio_urls = await Promise.all(audioReferences.map((item) => resolveSeedanceAudioUrl(config, item, options)));
    if (videoProfile(config, model).generateAudio) payload.generate_audio = boolConfig(config.videoGenerateAudio, true);
    for (const url of [...imageUrls, ...(payload.reference_videos as string[] || []), ...(payload.audio_urls as string[] || [])]) {
        if (!url.startsWith("https://")) throw new Error("视频中转接口需要公网 HTTPS 素材地址；请配置服务端 PUBLIC_BASE_URL 后重试。本次未创建任务、未扣费。");
    }
    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, {
                    headers: videoCreateHeaders(config, options, "application/json"),
                    signal: options?.signal,
                })
            ).data,
        );
        const taskID = videoTaskId(created);
        if (!taskID) throw new Error("视频接口没有返回任务 ID");
        return { id: taskID, provider: "openai", model, createdAt: Date.now() };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const query = config.channelMode === "remote" ? { model: modelOptionName(task.model) } : undefined;
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), params: query, signal: options?.signal })).data);
        if (isCompletedVideoStatus(video.status)) {
            if (isPidoiGrokVideoModel(modelOptionName(task.model))) {
                const result = await videoResultFromContent(config, task.id, query, options);
                if (result) {
                    refreshRemoteUser(config);
                    return { status: "completed", result };
                }
            }
            const url = videoResultUrl(video);
            if (url) {
                const result = await videoResultFromUrl(url, options);
                if (result) {
                    refreshRemoteUser(config);
                    return { status: "completed", result };
                }
            }
            const result = await videoResultFromContent(config, task.id, query, options);
            if (result) {
                refreshRemoteUser(config);
                return { status: "completed", result };
            }
            return { status: "pending" };
        }
        if (isFailedVideoStatus(video.status)) {
            refreshRemoteUser(config);
            return { status: "failed", error: readApiErrorMessage(video.error?.message) || "视频生成失败" };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        ...(config.channelMode === "remote" ? { input_mode: videoInputMode(config, model) } : {}),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: videoProfile(config, model).seconds.length ? Number(config.videoSeconds) : normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: videoCreateHeaders(config, options, "application/json"), signal: options?.signal })).data);
        const taskID = videoTaskId(created);
        if (!taskID) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: taskID, provider: "seedance", model, createdAt: Date.now() };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask(
            (await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: modelOptionName(task.model) } : undefined, signal: options?.signal })).data,
        );
        if (isCompletedVideoStatus(state.status)) {
            const url = videoResultUrl(state);
            if (url) {
                const result = await videoResultFromUrl(url, options);
                if (result) {
                    refreshRemoteUser(config);
                    return { status: "completed", result };
                }
            }
            return { status: "pending" };
        }
        if (isFailedVideoStatus(state.status)) {
            refreshRemoteUser(config);
            return { status: "failed", error: readApiErrorMessage(state.error?.message) || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        }
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    if (config.channelMode === "remote") return taskId ? `/api/v1/videos/${encodeURIComponent(taskId)}` : "/api/v1/videos";
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const mode = videoInputMode(config, config.model || config.videoModel);
    const text = mode === "reference" ? buildSeedancePromptText(prompt, references, videoReferences, audioReferences) : prompt.trim();
    if (text) content.push({ type: "text", text });
    for (const [index, image] of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images).entries()) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: mode === "reference" ? "reference_image" : index === 0 ? "first_frame" : "last_frame" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(config, video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(config, audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    if (config.channelMode === "remote") return uploadReferenceMedia(dataUrlToFile({ ...image, dataUrl }));
    return dataUrl;
}

async function resolveSeedanceVideoUrl(config: AiConfig, video: ReferenceVideo, options?: RequestOptions) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、资产 ID，或本地已保存的视频");
    if (config.channelMode === "remote") return uploadReferenceMedia(new File([blob], video.name || "reference-video.mp4", { type: video.type || blob.type || "video/mp4" }), options);
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(config: AiConfig, audio: ReferenceAudio, options?: RequestOptions) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、资产 ID，或本地已保存的音频");
    if (config.channelMode === "remote") return uploadReferenceMedia(new File([blob], audio.name || "reference-audio.mp3", { type: audio.type || blob.type || "audio/mpeg" }), options);
    return blobToDataUrl(blob);
}

async function resolvePidoiReferenceUrls(references: ReferenceImage[], options?: RequestOptions) {
    const result: string[] = [];
    for (const image of references.slice(0, 7)) {
        const directUrl = image.url || image.dataUrl;
        if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) {
            result.push(directUrl);
            continue;
        }
        const dataUrl = await imageToDataUrl(image);
        if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
        result.push(await uploadReferenceMedia(dataUrlToFile({ ...image, dataUrl }), options));
    }
    return result;
}

async function uploadReferenceMedia(file: File, options?: RequestOptions) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("使用本地参考素材需要先登录，并在服务端配置 PUBLIC_BASE_URL");
    const body = new FormData();
    body.append("file", file, file.name);
    let response: { data: ApiEnvelope<ReferenceMediaUploadResponse> };
    try {
        response = await axios.post<ApiEnvelope<ReferenceMediaUploadResponse>>("/api/v1/media/references", body, { headers: { Authorization: `Bearer ${token}` }, signal: options?.signal });
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        const message = axios.isAxiosError(error) ? readApiErrorMessage(error.response?.data) : "";
        throw new Error(message || (error instanceof Error ? error.message : "参考素材上传失败"));
    }
    const payload = unwrapEnvelope(response.data, "参考素材上传失败");
    if (!payload.url) throw new Error("参考素材上传后没有返回公网 URL");
    return payload.url;
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult | null> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        return videoResultFromBlob(response.data, String(response.headers["content-type"] || ""));
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return null;
    }
}

async function videoResultFromContent(config: AiConfig, taskId: string, query: { model: string } | undefined, options?: RequestOptions): Promise<VideoGenerationResult | null> {
    try {
        const response = await axios.get<Blob>(aiApiUrl(config, `/videos/${taskId}/content`), {
            headers: aiHeaders(config),
            params: query,
            responseType: "blob",
            signal: options?.signal,
        });
        return videoResultFromBlob(response.data, String(response.headers["content-type"] || ""));
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return null;
    }
}

async function videoResultFromBlob(blob: Blob, contentType?: string): Promise<VideoGenerationResult | null> {
    const normalized = String(contentType || blob.type || "").toLowerCase();
    if (normalized.includes("json")) {
        await assertVideoBlob(blob);
        return null;
    }
    if (!normalized.startsWith("video/") && normalized !== "application/octet-stream") return null;
    if (blob.size < 1024 || !(await hasVideoFileSignature(blob))) return null;
    return { blob };
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (config.channelMode === "remote" && model) return;
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    if (payload && typeof payload === "object" && "data" in payload && payload.data && typeof payload.data === "object" && !("code" in payload)) {
        return payload.data;
    }
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function videoTaskId(task: { id?: string; task_id?: string }) {
    return String(task.task_id || task.id || "").trim();
}

function isPidoiGrokVideoModel(model: string) {
    const name = model.toLowerCase().trim();
    return name === "grok-imagine-video-1.5-preview" || name === "grok-imagine-video-1.5-fast" || name === "grok-imagine-1.0-video";
}

function isPidoiJsonVideoModel(model: string) {
    const name = model.toLowerCase().trim();
    return name === "grok-imagine-video-1.5-preview" || name.startsWith("tejiasd-") || name.includes("seedance") || name.includes("seedace");
}

function normalizePidoiVideoSeconds(model: string, value: string, resolution: string) {
    const seconds = Number(normalizeVideoSeconds(value));
    const name = model.toLowerCase().trim();
    if (name.includes("seedance") || name.includes("seedace")) return String(Math.max(4, Math.min(seconds, 15)));
    if (!name.startsWith("tejiasd-")) return String(seconds);
    return String(Math.min(seconds, resolution === "480p" ? 15 : 12));
}

function isCompletedVideoStatus(status?: string) {
    const value = String(status || "").toLowerCase();
    return value === "completed" || value === "succeeded" || value === "success";
}

function isFailedVideoStatus(status?: string) {
    const value = String(status || "").toLowerCase();
    return value === "failed" || value === "cancelled" || value === "canceled" || value === "expired";
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask) {
    const content = typeof payload.content === "object" && payload.content ? payload.content : undefined;
    const nestedVideoUrl = "video" in payload ? payload.video?.url : undefined;
    return [payload.video_url, payload.url, nestedVideoUrl, payload.result_url, content?.video_url, content?.url, typeof payload.content === "string" ? payload.content : undefined].find(
        (url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)),
    );
}

async function hasVideoFileSignature(blob: Blob) {
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") return true;
    return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            return readApiErrorMessage(JSON.parse(value)) || value;
        } catch {
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: { message?: unknown } };
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(payload.error?.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || "视频下载失败");
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === "AbortError";
}

function waitForNextVideoPoll(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            window.removeEventListener("focus", wake);
            window.removeEventListener("online", wake);
            document.removeEventListener("visibilitychange", visible);
            resolve();
        };
        const abort = () => {
            clearTimeout(timer);
            window.removeEventListener("focus", wake);
            window.removeEventListener("online", wake);
            document.removeEventListener("visibilitychange", visible);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const wake = () => finish();
        const visible = () => {
            if (document.visibilityState === "visible") finish();
        };
        const timer = window.setTimeout(finish, ms);
        signal?.addEventListener("abort", abort, { once: true });
        window.addEventListener("focus", wake, { once: true });
        window.addEventListener("online", wake, { once: true });
        document.addEventListener("visibilitychange", visible);
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地资产失败"));
        reader.readAsDataURL(blob);
    });
}
