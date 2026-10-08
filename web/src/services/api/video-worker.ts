import { useUserStore } from "@/stores/use-user-store";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
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

export async function createWorkerJob(config: WorkerConfig, operation: string, inputs: Record<string, string | string[]>, options: Record<string, unknown>, signal?: AbortSignal): Promise<WorkerJob> {
    return (await workerRequest(config, "jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, inputs, options }), signal })).json();
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
