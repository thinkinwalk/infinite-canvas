import { useUserStore } from "@/stores/use-user-store";
import { getMediaBlob, readPlayableVideoMeta, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { uploadImage, imageToDataUrl } from "@/services/image-storage";
import { VIDEO_ACTIVE_POLL_INTERVAL_MS } from "./video";
import type { WorkbenchMedia, WorkerCapabilities, WorkerConfig, WorkerJob } from "@/types/video-workbench";

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

export async function getWorkerCapabilities(config: WorkerConfig): Promise<WorkerCapabilities[]> {
    return (await (await workerRequest(config, "health")).json()).capabilities;
}

export async function workbenchMediaBlob(media: UploadedFile & { kind?: string }) {
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
    const form = new FormData();
    form.append("file", await workbenchMediaBlob(media), media.name || `media.${media.mimeType.startsWith("audio/") ? "wav" : media.mimeType.startsWith("image/") ? "png" : "mp4"}`);
    form.append("metadata", JSON.stringify({ width: media.width, height: media.height, durationMs: media.durationMs }));
    return (await (await workerRequest(config, "media", { method: "POST", body: form, signal })).json()).id;
}

export async function prepareWorkbenchVideo(config: WorkerConfig, blob: Blob, name?: string): Promise<Blob> {
    try {
        await readPlayableVideoMeta(blob);
        return blob;
    } catch {
        // MIME/extension alone cannot establish that the browser can decode the video.
    }
    try {
        const capabilities = await getWorkerCapabilities(config);
        if (!capabilities.some((item) => item.name === "compose" && item.available)) throw new Error("处理服务未启用视频格式转换");
        const url = URL.createObjectURL(blob);
        let id: string;
        try {
            id = await uploadWorkerMedia(config, { url, storageKey: "", bytes: blob.size, mimeType: blob.type, name });
        } finally {
            URL.revokeObjectURL(url);
        }
        const job = await createWorkerJob(config, "compose", { video: id }, {});
        const completed = await waitForWorkerJob(config, job.id, new AbortController().signal, () => {});
        if (!completed.result?.file) throw new Error("处理服务未返回转换后的视频");
        const converted = await (await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}`)).blob();
        await readPlayableVideoMeta(converted);
        return converted;
    } catch (error) {
        throw new Error(`视频编码不兼容，自动转换失败：${error instanceof Error ? error.message : "处理失败"}。请改用 H.264 编码的 MP4 视频，原文件未修改。`);
    }
}

export async function createWorkerJob(config: WorkerConfig, operation: string, inputs: Record<string, string | string[]>, options: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerJob> {
    return (await workerRequest(config, "jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, inputs, options }), signal })).json();
}

export async function trimWorkbenchVideo(config: WorkerConfig, media: UploadedFile & { name?: string }, start: number, end: number, signal: AbortSignal): Promise<UploadedFile> {
    if (![start, end].every(Number.isFinite) || start < 0 || end - start < 1 || end - start > 15) throw new Error("请选择 1–15 秒的参考片段");
    const capabilities = await getWorkerCapabilities(config);
    signal.throwIfAborted();
    if (!capabilities.some((item) => item.name === "trim" && item.available)) throw new Error("当前剪辑服务暂不支持裁剪，请更新或连接处理服务后重试");
    const id = await uploadWorkerMedia(config, media, signal);
    const job = await createWorkerJob(config, "trim", { video: id }, { start, end }, signal);
    try {
        const completed = await waitForWorkerJob(config, job.id, signal, () => {});
        if (!completed.result?.file) throw new Error("剪辑服务未返回视频");
        const blob = await (await workerRequest(config, `media/${encodeURIComponent(completed.result.file)}`, { signal })).blob();
        const meta = await readPlayableVideoMeta(blob);
        if (!meta.durationMs || meta.durationMs < 1000 || meta.durationMs > 15000) throw new Error("裁剪结果不在 1–15 秒内，请缩短选区后重试");
        signal.throwIfAborted();
        return uploadMediaFile(blob, "video-trim");
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
    return uploadMediaFile(await response.blob(), "video-worker");
}

export async function storeWorkerImage(config: WorkerConfig, file: string): Promise<UploadedFile> {
    const response = await workerRequest(config, `media/${encodeURIComponent(file)}`);
    const image = await uploadImage(await response.blob());
    return { ...image, storageKey: image.storageKey || "" };
}
