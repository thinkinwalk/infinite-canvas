import { useUserStore } from "@/stores/use-user-store";
import { getMediaBlob, readPlayableVideoMeta, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { uploadImage, imageToDataUrl } from "@/services/image-storage";
import { VIDEO_ACTIVE_POLL_INTERVAL_MS } from "./video";
import type { WorkbenchMedia, WorkerCapabilities, WorkerConfig, WorkerJob } from "@/types/video-workbench";
import type { VideoImportSource } from "@/types/video-workbench";

export function resolveWorkerUrl(config: WorkerConfig) {
    const url = new URL(config.url, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("处理服务地址必须是 HTTP 或 HTTPS 地址");
    return url.href.replace(/\/+$/, "");
}

async function workerRequest(config: WorkerConfig, path: string, init: RequestInit = {}) {
    const url = new URL(path.replace(/^\//, ""), `${resolveWorkerUrl(config)}/`);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("处理服务地址必须是 HTTP 或 HTTPS 地址");
    const gateway = url.origin === window.location.origin && url.pathname.startsWith("/api/v1/video-worker/");
    const token = gateway ? useUserStore.getState().token : config.token;
    if (gateway && !token) throw new Error("请先登录后使用服务器剪辑服务");
    const response = await fetch(url, {
        ...init,
        headers: { "X-Canvas-Worker": "1", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
    }).catch(() => {
        throw new Error(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
            ? "本机视频处理服务未连接，请先运行 video-worker/start.ps1 后重试；本地使用不需要部署服务器。若已启动，请检查服务地址与跨域配置。"
            : "无法连接视频处理服务，请检查服务地址、启动状态及跨域配置");
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(typeof payload?.detail === "string" ? payload.detail : payload?.msg || `处理服务请求失败（${response.status}）`);
    }
    if (gateway && response.headers.get("Content-Type")?.includes("application/json")) {
        const payload = await response.clone().json().catch(() => null);
        if (typeof payload?.code === "number" && payload.code !== 0) throw new Error(payload.msg || "服务器剪辑服务请求失败");
    }
    return response;
}

export async function getWorkerCapabilities(config: WorkerConfig, signal?: AbortSignal): Promise<WorkerCapabilities[]> {
    return (await (await workerRequest(config, "health", { signal })).json()).capabilities;
}

export async function workbenchMediaBlob(media: UploadedFile & { kind?: string }) {
    if (media.referenceId) {
        const { readVideoReferenceRetention } = await import("@/services/video-reference-retention");
        if ((await readVideoReferenceRetention(media.referenceId))?.cleanedAt) throw new Error("参考视频已清理，请重新导入");
    }
    if (media.kind === "image") {
        const data = await imageToDataUrl({ dataUrl: media.url, storageKey: media.storageKey });
        return (await fetch(data)).blob();
    }
    const blob = media.storageKey ? await getMediaBlob(media.storageKey) : null;
    if (blob) return blob;
    const response = await fetch(media.url);
    if (!response.ok) throw new Error("读取素材失败，请重新上传");
    return response.blob();
}

export async function uploadWorkerMedia(config: WorkerConfig, media: UploadedFile & { name?: string; kind?: WorkbenchMedia["kind"] }, signal?: AbortSignal): Promise<string> {
    const { temporaryReferenceHeaders } = await import("@/services/video-reference-retention");
    const headers = await temporaryReferenceHeaders(media, signal);
    const form = new FormData();
    form.append("file", await workbenchMediaBlob(media), media.name || `media.${media.mimeType.startsWith("audio/") ? "wav" : media.mimeType.startsWith("image/") ? "png" : "mp4"}`);
    form.append("metadata", JSON.stringify({ width: media.width, height: media.height, durationMs: media.durationMs }));
    return (await (await workerRequest(config, "media", { method: "POST", body: form, signal, headers })).json()).id;
}

export async function analysisReferenceVideo(config: WorkerConfig, media: UploadedFile, signal: AbortSignal): Promise<UploadedFile> {
    if (!media.referenceId) return media;
    const { readVideoReferenceRetention, saveAnalysisReference, updateVideoReferenceRetention } = await import("@/services/video-reference-retention");
    await updateVideoReferenceRetention(media.referenceId, "use", signal);
    const saved = await readVideoReferenceRetention(media.referenceId);
    if (saved?.analysis && saved.analysisSourceKey === media.storageKey) return { ...saved.analysis, referenceId: media.referenceId };
    const capabilities = await getWorkerCapabilities(config, signal);
    if (!capabilities.some((item) => item.name === "analysis-proxy" && item.available)) throw new Error("处理服务尚不支持分析副本，请更新视频处理服务后重试，原视频已保留");
    const video = await uploadWorkerMedia(config, media, signal);
    const job = await createWorkerJob(config, "analysis-proxy", { video }, {}, signal);
    try {
        const completed = await waitForWorkerJob(config, job.id, signal, () => {});
        if (!completed.result?.file) throw new Error("分析副本准备失败，原视频已保留");
        await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}/temporary`, {
            method: "POST", signal, headers: { "X-Video-Reference-ID": media.referenceId },
        });
        const file = await storeWorkerResult(config, completed.result.file);
        signal.throwIfAborted();
        await saveAnalysisReference(media.referenceId, media.storageKey, file);
        return { ...file, referenceId: media.referenceId };
    } catch (error) {
        if (signal.aborted) void cancelWorkerJob(config, job.id).catch(() => {});
        throw error;
    }
}

export async function storeTemporaryWorkbenchVideo(config: WorkerConfig, blob: Blob, name: string, options: {
    source?: VideoImportSource; signal?: AbortSignal; compatible?: boolean;
} = {}): Promise<UploadedFile> {
    const { trackTemporaryVideo, registerTemporaryReferenceCopy } = await import("@/services/video-reference-retention");
    const original = await trackTemporaryVideo(await uploadMediaFile(blob, "video-original"), name, options.source);
    options.signal?.throwIfAborted();
    if (!options.compatible) return original;
    const prepared = await prepareWorkbenchVideo(config, blob, name, options.signal, original);
    if (prepared === blob) return original;
    const copy = await uploadMediaFile(prepared, "video-compatible");
    return registerTemporaryReferenceCopy(original.referenceId!, copy);
}

export async function prepareWorkbenchVideo(config: WorkerConfig, blob: Blob, name?: string, signal?: AbortSignal, reference?: UploadedFile): Promise<Blob> {
    signal?.throwIfAborted();
    try {
        await readPlayableVideoMeta(blob);
        signal?.throwIfAborted();
        return blob;
    } catch {
        // MIME/extension alone cannot establish that the browser can decode the video.
    }
    signal?.throwIfAborted();
    let jobId: string | undefined;
    try {
        const capabilities = await getWorkerCapabilities(config, signal);
        if (!capabilities.some((item) => item.name === "compose" && item.available)) throw new Error("处理服务未启用视频格式转换");
        const url = URL.createObjectURL(blob);
        let id: string;
        try {
            id = await uploadWorkerMedia(config, { url, storageKey: "", bytes: blob.size, mimeType: blob.type, name, referenceId: reference?.referenceId }, signal);
        } finally {
            URL.revokeObjectURL(url);
        }
        const job = await createWorkerJob(config, "compose", { video: id }, reference?.referenceId ? { referenceCompatibility: true } : {}, signal);
        jobId = job.id;
        const completed = await waitForWorkerJob(config, job.id, signal || new AbortController().signal, () => {});
        if (!completed.result?.file) throw new Error("处理服务未返回转换后的视频");
        if (reference?.referenceId) await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}/temporary`, {
            method: "POST", signal, headers: { "X-Video-Reference-ID": reference.referenceId },
        });
        const converted = await (await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}`, { signal })).blob();
        await readPlayableVideoMeta(converted);
        signal?.throwIfAborted();
        return converted;
    } catch (error) {
        if (signal?.aborted) {
            if (jobId) void cancelWorkerJob(config, jobId).catch(() => {});
            signal.throwIfAborted();
        }
        throw new Error(`视频编码不兼容，自动转换失败：${error instanceof Error ? error.message : "处理失败"}。请改用 H.264 编码的 MP4 视频，原文件未修改。`);
    }
}

export async function createWorkerJob(config: WorkerConfig, operation: string, inputs: Record<string, string | string[]>, options: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerJob> {
    return (await workerRequest(config, "jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, inputs, options }), signal })).json();
}

export async function trimWorkbenchVideo(config: WorkerConfig, media: UploadedFile & { name?: string }, start: number, end: number, signal: AbortSignal): Promise<UploadedFile> {
    if (![start, end].every(Number.isFinite) || start < 0 || end - start < 1 || end - start > 30) throw new Error("请选择 1–30 秒的参考片段");
    const capabilities = await getWorkerCapabilities(config, signal);
    signal.throwIfAborted();
    if (!capabilities.some((item) => item.name === "trim" && item.available)) throw new Error("当前剪辑服务暂不支持裁剪，请更新或连接处理服务后重试");
    const id = await uploadWorkerMedia(config, media, signal);
    const job = await createWorkerJob(config, "trim", { video: id }, { start, end }, signal);
    try {
        const completed = await waitForWorkerJob(config, job.id, signal, () => {});
        if (!completed.result?.file) throw new Error("剪辑服务未返回视频");
        if (media.referenceId) await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}/temporary`, {
            method: "POST", signal, headers: { "X-Video-Reference-ID": media.referenceId },
        });
        const blob = await (await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}`, { signal })).blob();
        const meta = await readPlayableVideoMeta(blob);
        if (!meta.durationMs || meta.durationMs < 1000 || meta.durationMs > 30000) throw new Error("裁剪结果不在 1–30 秒内，请缩短选区后重试");
        signal.throwIfAborted();
        const file = await uploadMediaFile(blob, "video-trim");
        if (!media.referenceId) return file;
        const { registerTemporaryReferenceCopy } = await import("@/services/video-reference-retention");
        return registerTemporaryReferenceCopy(media.referenceId, file);
    } catch (error) {
        if (signal.aborted) void cancelWorkerJob(config, job.id).catch(() => {});
        throw error;
    }
}

export async function readWorkerJob(config: WorkerConfig, id: string, signal?: AbortSignal): Promise<WorkerJob> {
    return (await workerRequest(config, `jobs/${encodeURIComponent(id)}`, { signal })).json();
}

export async function cancelWorkerJob(config: WorkerConfig, id: string): Promise<WorkerJob> {
    return (await workerRequest(config, `jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" })).json();
}

export async function waitForWorkerJob(config: WorkerConfig, id: string, signal: AbortSignal, onProgress: (job: WorkerJob) => void): Promise<WorkerJob> {
    for (;;) {
        signal.throwIfAborted();
        const job = await readWorkerJob(config, id, signal);
        onProgress(job);
        if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error || (job.status === "cancelled" ? "任务已取消" : "处理失败"));
        if (job.status === "completed") return job;
        await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new DOMException("等待已暂停", "AbortError")); };
            const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, VIDEO_ACTIVE_POLL_INTERVAL_MS);
            signal.addEventListener("abort", abort, { once: true });
        });
    }
}

export async function storeWorkerResult(config: WorkerConfig, file: string): Promise<UploadedFile> {
    const response = await workerRequest(config, `media/${encodeURIComponent(file)}`);
    const media = await uploadMediaFile(await response.blob(), "video-worker");
    const id = response.headers.get("X-Video-Reference-ID");
    if (!id) return media;
    const { registerTemporaryReferenceCopy } = await import("@/services/video-reference-retention");
    return registerTemporaryReferenceCopy(id, media);
}

export async function storeWorkerImage(config: WorkerConfig, file: string): Promise<UploadedFile> {
    const response = await workerRequest(config, `media/${encodeURIComponent(file)}`);
    const image = await uploadImage(await response.blob());
    return { ...image, storageKey: image.storageKey || "" };
}
