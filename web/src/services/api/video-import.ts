import { useUserStore } from "@/stores/use-user-store";
import type { VideoImportSource } from "@/types/video-workbench";

export async function importVideoURL(text: string, signal: AbortSignal): Promise<{ file: File; source: VideoImportSource }> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请登录后提取视频");
    const response = await fetch("/api/v1/video/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: text }),
        signal,
    }).catch((error: unknown) => {
        signal.throwIfAborted();
        throw new Error(error instanceof TypeError ? "视频提取服务连接失败，请稍后重试" : "视频提取请求失败");
    });
    if (!response.ok || !response.headers.get("Content-Type")?.startsWith("video/mp4")) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.msg || (response.status === 404 ? "视频提取接口未启用，请更新后端服务" : "视频提取失败，请稍后重试"));
    }
    let source: VideoImportSource;
    try {
        const encoded = response.headers.get("X-Video-Import") || "";
        source = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))));
        if (typeof source.platform !== "string" || typeof source.title !== "string" || typeof source.author !== "string" || typeof source.sourceUrl !== "string") throw new Error("invalid metadata");
    } catch {
        throw new Error("视频来源信息不完整，请重新提取");
    }
    const blob = await response.blob();
    signal.throwIfAborted();
    if (!blob.size) throw new Error("提取的视频为空，原素材已保留");
    const name = (source.title || "提取的视频").replace(/[\\/:*?"<>|\r\n\x00-\x1f]/g, " ").trim();
    return { file: new File([blob], `${name || "提取的视频"}.mp4`, { type: "video/mp4" }), source };
}
