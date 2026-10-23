import { nanoid } from "nanoid";
import { extractionClipError } from "@/lib/video-extraction";
import { trimWorkbenchVideo } from "@/services/api/video-worker";
import { readPlayableVideoMeta } from "@/services/file-storage";
import { useVideoExtractionStore, type VideoExtraction, type VideoExtractionClip } from "@/stores/use-video-extraction-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useUserStore } from "@/stores/use-user-store";
import { readExtractedVideo } from "./extraction-actions";

export async function saveExtractionClip(parent: VideoExtraction, name: string, range: [number, number], signal: AbortSignal, previous?: VideoExtractionClip, prepared?: { sourceId: string; minSeconds: number; maxSeconds: number; onProgress?: (step: string) => void }) {
    const { token, user } = useUserStore.getState();
    const validate = () => {
        signal.throwIfAborted();
        const current = useUserStore.getState();
        if (!token || !user?.id || current.token !== token || current.user?.id !== user.id) throw new Error("登录状态已变化，请重新操作");
    };
    validate();
    const title = name.trim().replace(/\.mp4$/i, "").replace(/[\\/:*?"<>|\r\n\x00-\x1f]/g, " ").trim();
    if (!title) throw new Error("请填写片段名称");
    const unchanged = previous && previous.start === range[0] && previous.end === range[1];
    const blob = await readExtractedVideo(parent, signal);
    const media = parent.media.durationMs ? parent.media : { ...parent.media, ...await readPlayableVideoMeta(blob) };
    const error = extractionClipError(range[0], range[1], media.durationMs);
    if (error) throw new Error(error);
    const spanMs = Math.round(range[1] * 1000) - Math.round(range[0] * 1000);
    if (prepared && (spanMs < prepared.minSeconds * 1000 || spanMs > prepared.maxSeconds * 1000)) throw new Error("片段区间超出模型参考时长范围，请调整分界点后重试");
    validate();
    const file = unchanged ? previous.media : await trimWorkbenchVideo(useVideoWorkbenchStore.getState().worker, media, range[0], range[1], signal, prepared?.sourceId, prepared?.onProgress);
    if (prepared && (!file.durationMs || file.durationMs < prepared.minSeconds * 1000 || file.durationMs > prepared.maxSeconds * 1000)) throw new Error("实际裁剪结果超出模型参考时长范围，请调整分界点后重试");
    validate();
    const id = unchanged ? previous.id : nanoid();
    const clip: VideoExtractionClip = {
        id, createdAt: unchanged ? previous.createdAt : Date.now(), start: range[0], end: range[1],
        media: { ...file, id, name: `${title}.mp4`, kind: "video", role: "reference",
            source: parent.media.source && { ...parent.media.source, clip: { extractionId: parent.id, start: range[0], end: range[1] } } },
    };
    await useVideoExtractionStore.getState().saveClip(user!.id, parent.id, clip, previous, validate, prepared?.sourceId);
    validate();
    return clip;
}
