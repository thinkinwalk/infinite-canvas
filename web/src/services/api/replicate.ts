import { apiPost } from "./request";
import { fetchCurrentUser } from "./auth";
import { useUserStore } from "@/stores/use-user-store";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { workbenchMediaBlob } from "./video-worker";
import { VIDEO_ACTIVE_POLL_INTERVAL_MS } from "./video";

export type ReplicateOperation = "transcribe" | "speech" | "digital-human" | "lipsync" | "replace-person" | "upscale" | "image-to-video" | "hailuo-video" | "video-edit" | "masked-edit" | "subtitle-remove";
export const REPLICATE_VIDEO_MODEL = "replicate::wan-video/wan-2.2-i2v-fast";
export const HAILUO_VIDEO_MODEL = "replicate::minimax/hailuo-2.3";
export function isReplicateVideoModel(model: string) { return model === REPLICATE_VIDEO_MODEL || model === HAILUO_VIDEO_MODEL; }
export const REPLICATE_MODEL_NAMES: Record<ReplicateOperation, string> = {
    transcribe: "云端语音识别",
    speech: "系统音色与声音克隆",
    "digital-human": "照片口播",
    lipsync: "视频口型同步",
    "replace-person": "视频人物替换",
    upscale: "视频增强",
    "image-to-video": "图像生成视频",
    "hailuo-video": "快速视频生成",
    "video-edit": "视频内容编辑",
    "masked-edit": "局部视频编辑",
    "subtitle-remove": "视频智能去字幕",
};
export function replicateFeatureUrl(operation: ReplicateOperation) {
    if (operation === "transcribe") return "/digital-human?focus=speech";
    if (operation === "image-to-video") return "/video?model=wan";
    if (operation === "hailuo-video") return "/video?model=hailuo";
    if (operation === "upscale") return "/video/upscale";
    if (operation === "subtitle-remove") return "/video/subtitle-remove";
    if (["speech", "digital-human", "lipsync"].includes(operation)) return `/digital-human?mode=${operation === "lipsync" ? "video" : "photo"}&focus=${operation === "speech" ? "speech" : "avatar"}`;
    return `/video/content-replace?replacement=${operation === "replace-person" ? "person" : "background"}${operation === "masked-edit" ? "&masked=1" : ""}`;
}
export const REPLICATE_FEATURES: { operation: ReplicateOperation; label: string; model: string; description: string; billingMode: string; tierKeys?: string[] }[] = [
    { operation: "transcribe", label: "视频学习 · 云端语音识别", model: "vaibhavs10/incredibly-fast-whisper", description: "提取视频人声并在云端识别原文与时间戳。本站按输入音频秒数报价，上游按运行时间计费；请配置价格并启用后使用。", billingMode: "input_seconds" },
    { operation: "hailuo-video", label: "Hailuo 2.3 · 文生视频 / 图生视频", model: "minimax/hailuo-2.3", description: "输入文字直接生成视频，也可加1张首帧图。768p支持6/10秒；1080p仅支持6秒。按规格收取每条成片费用。", billingMode: "output_count", tierKeys: ["768p:6", "768p:10", "1080p:6"] },
    { operation: "speech", label: "中文配音与声音克隆", model: "qwen/qwen3-tts", description: "文字转语音，支持预设音色、声音克隆和声音设计。", billingMode: "input_characters" },
    { operation: "digital-human", label: "照片数字人", model: "wan-video/wan-2.2-s2v", description: "上传人物照片和语音，生成会说话的数字人视频。", billingMode: "output_seconds" },
    { operation: "lipsync", label: "视频对口型", model: "sync/lipsync-2", description: "让已有视频中的人物口型与新音频同步。", billingMode: "output_seconds" },
    { operation: "replace-person", label: "视频人物替换", model: "wan-video/wan-2.2-animate-replace", description: "把视频中的人物替换为指定角色，同时保留动作。", billingMode: "duration_resolution", tierKeys: ["480", "720"] },
    {
        operation: "upscale",
        label: "视频高清与超分",
        model: "topazlabs/video-upscale",
        description: "提升视频清晰度，可输出 720p、1080p 或 4K。",
        billingMode: "duration_resolution",
        tierKeys: ["720p:30", "720p:60", "1080p:30", "1080p:60", "4k:30", "4k:60"],
    },
    {
        operation: "image-to-video",
        label: "图片生成视频",
        model: "wan-video/wan-2.2-i2v-fast",
        description: "让静态图片按照文字描述生成动态短视频。",
        billingMode: "output_count",
        tierKeys: ["base:480p", "interpolate:480p", "base:720p", "interpolate:720p"],
    },
    { operation: "video-edit", label: "视频智能编辑", model: "wan-video/wan-2.7-videoedit", description: "用文字修改视频中的时间、天气、背景和视觉风格。", billingMode: "output_seconds" },
    { operation: "masked-edit", label: "局部视频编辑", model: "prunaai/vace-14b", description: "通过掩膜指定区域，局部修改人物、物体或背景。", billingMode: "runtime_seconds" },
];
export type ReplicateTask = {
    id: string;
    operation: ReplicateOperation;
    model: string;
    version: string;
    predictionId: string;
    status: "creating" | "uncertain" | "running" | "generated" | "completed" | "failed" | "cancelled";
    credits: number;
    pricingSnapshot?: string;
    refunded: boolean;
    mimeType: string;
    error?: string;
    metrics: string;
};
export type ReplicateQuote = {
    inputSummary?: string;
    operation: ReplicateOperation;
    label: string;
    model: string;
    description?: string;
    credits: number;
    billingMode?: string;
    billingDescription?: string;
    pricingSnapshot?: string;
    configured: boolean;
    available: boolean;
    reason?: string;
    unitCredits?: number;
    minimumCredits?: number;
    billableUnits?: number;
    durationSeconds?: number;
    usedDefaultDuration?: boolean;
    calculation?: string;
    submissionBlocked?: string;
};

export function transcriptionUnavailable(model?: ReplicateQuote) {
    if (!model) return "当前服务尚未提供云端语音识别，请联系管理员更新并重启服务；无需重复填写已有服务密钥。";
    return model.available ? "" : publicServiceText(model.reason || "云端语音识别尚未启用，请管理员在后台设置识别价格并启用；已有服务密钥可以复用。");
}

function sessionToken() {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录，使用平台智能服务");
    return token;
}
export function publicServiceText(value: string) {
    return value
        .replace(/Replicate/gi, "平台服务")
        .replace(/\b(?:wan(?:-video)?|wan\s*2(?:\.\d+)?)\b/gi, "标准视频服务")
        .replace(/\bhailuo(?:[-\s]*\d+(?:\.\d+)?)?\b/gi, "快速视频服务")
        .replace(/\btopaz(?:labs)?\b/gi, "视频增强服务")
        .replace(/\bvace\b/gi, "局部视频编辑服务")
        .replace(/\bqwen(?:[-\s]*\w+)?\b/gi, "系统音色服务")
        .replace(/\b(?:minimax|prunaai|sync)\/[\w.-]+\b/gi, "平台处理服务")
        .replace(/prediction[\s_-]*ID/gi, "任务编号")
        .replace(/上游/g, "平台服务");
}
async function cloudRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api/v1/replicate/${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal,
        headers: { Authorization: `Bearer ${sessionToken()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0) {
        const error = new Error(publicServiceText(payload?.msg || (response.status === 404 ? "平台服务暂未开通" : "平台服务请求失败，请稍后重试或恢复任务查询")));
        if (payload?.msg === "任务不存在或无权访问") error.name = "ReplicateTaskNotFound";
        throw error;
    }
    return payload.data as T;
}
export function getReplicateModels(signal?: AbortSignal) {
    return cloudRequest<ReplicateQuote[]>("models", undefined, signal);
}
export async function uploadReplicateReference(media: UploadedFile & { name?: string; kind?: string }, signal?: AbortSignal, purpose?: "transcribe"): Promise<string> {
    const blob = await workbenchMediaBlob({ ...media, kind: media.mimeType.startsWith("image/") ? "image" : media.kind });
    const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a" };
    const extension = extensions[media.mimeType] || media.mimeType.split("/")[1];
    const form = new FormData();
    form.append("file", blob, media.name || `reference.${extension}`);
    if (purpose) form.append("purpose", purpose);
    const response = await fetch("/api/v1/media/references", { method: "POST", signal, body: form, headers: { Authorization: `Bearer ${sessionToken()}` } });
    const raw = await response.text();
    let payload: { code?: number | string; data?: { url?: string } | null; msg?: string; message?: string } | null = null;
    try {
        payload = raw ? JSON.parse(raw) : null;
    } catch {
        /* Keep the HTTP status as the fallback when the server did not return JSON. */
    }
    const message = payload?.msg || payload?.message;
    if (!response.ok || payload?.code !== 0 || !payload.data?.url) {
        throw new Error(message || (response.status ? `模型参考素材上传失败（HTTP ${response.status}）` : "模型参考素材上传失败"));
    }
    return payload.data.url;
}
export function quoteReplicate(operation: ReplicateOperation, input: Record<string, unknown>, signal?: AbortSignal) {
    return cloudRequest<ReplicateQuote>("quote", { operation, input }, signal);
}
async function refreshCloudBalance() {
    const { token } = useUserStore.getState();
    try {
        const user = await fetchCurrentUser(token);
        if (useUserStore.getState().token === token) useUserStore.getState().setSession(token, user);
    } catch {
        /* A balance refresh must not clear a valid session. */
    }
}
export async function createReplicateTask(id: string, operation: ReplicateOperation, input: Record<string, unknown>, expectedCredits: number, signal?: AbortSignal) {
    const task = await cloudRequest<ReplicateTask>("tasks", { id, operation, input, expectedCredits }, signal);
    void refreshCloudBalance();
    return task;
}
export async function readReplicateTask(id: string, signal?: AbortSignal) {
    const task = await cloudRequest<ReplicateTask>(`tasks/${encodeURIComponent(id)}`, undefined, signal);
    if (task.refunded) void refreshCloudBalance();
    return task;
}
export async function cancelReplicateTask(id: string) {
    const task = await cloudRequest<ReplicateTask>(`tasks/${encodeURIComponent(id)}/cancel`, {});
    void refreshCloudBalance();
    return task;
}
export async function waitForReplicateTask(id: string, signal: AbortSignal, onProgress: (task: ReplicateTask) => void): Promise<ReplicateTask> {
    for (;;) {
        signal.throwIfAborted();
        const task = await readReplicateTask(id, signal);
        onProgress(task);
        if (task.status === "failed" || task.status === "cancelled" || task.status === "uncertain" || (task.status === "generated" && task.error)) throw new Error(task.error || "模型任务未完成，请恢复查询");
        if (task.status === "completed") return task;
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
                reject(new DOMException("等待已暂停", "AbortError"));
            };
            const timer = window.setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
            }, VIDEO_ACTIVE_POLL_INTERVAL_MS);
            signal.addEventListener("abort", abort, { once: true });
        });
    }
}
export async function storeReplicateResult(task: ReplicateTask): Promise<UploadedFile> {
    return uploadMediaFile(await fetchReplicateResult(task.id), "replicate");
}
export async function fetchReplicateResult(id: string): Promise<Blob> {
    const response = await fetch(`/api/v1/replicate/tasks/${encodeURIComponent(id)}/content`, { headers: { Authorization: `Bearer ${sessionToken()}` } });
    if (!response.ok) throw new Error("作品下载失败，请从任务记录恢复查询");
    return response.blob();
}

export async function readReplicateTranscription(task: ReplicateTask) {
    if (task.operation !== "transcribe") throw new Error("该任务不是语音识别任务");
    const result = JSON.parse(await (await fetchReplicateResult(task.id)).text()) as { text: string; segments: import("@/types/video-workbench").SubtitleSegment[] };
    if (!result.text?.trim()) throw new Error("没有识别到口播文字，请检查人声或手动粘贴参考原文");
    return result;
}

export function reconcileReplicateTask(id: string, predictionId: string) {
    return apiPost<ReplicateTask>(`/api/admin/replicate/tasks/${encodeURIComponent(id)}/reconcile`, { predictionId }, sessionToken());
}
