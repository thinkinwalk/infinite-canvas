import { nanoid } from "nanoid";
import { extractionDraft, extractionTargetError, type ExtractionTarget } from "@/lib/video-extraction";
import { listReplacementJobs } from "@/services/api/replacement-jobs";
import { getMediaBlob } from "@/services/file-storage";
import { readVideoReferenceRetention, updateVideoReferenceRetention } from "@/services/video-reference-retention";
import type { VideoExtraction } from "@/stores/use-video-extraction-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useUserStore } from "@/stores/use-user-store";
import type { VideoDraft } from "@/types/video-workbench";

function extractionSession(signal: AbortSignal) {
    const { token, user } = useUserStore.getState();
    if (!token || !user?.id) throw new Error("请登录后提取视频");
    const validate = () => {
        signal.throwIfAborted();
        const current = useUserStore.getState();
        if (current.token !== token || current.user?.id !== user.id) throw new Error("登录状态已变化，请重新操作");
    };
    validate();
    return { validate };
}

export async function readExtractedVideo(record: VideoExtraction, signal: AbortSignal, original = false) {
    const { validate } = extractionSession(signal);
    if (!record.media.referenceId) throw new Error("素材登记信息缺失，请重新提取");
    await updateVideoReferenceRetention(record.media.referenceId, "use", signal);
    validate();
    const reference = await readVideoReferenceRetention(record.media.referenceId);
    if (!reference || reference.cleanedAt) throw new Error("原视频已清理，请重新提取");
    const blob = await getMediaBlob(original && !record.media.source?.clip ? reference.storageKey : record.media.storageKey);
    validate();
    if (!blob) throw new Error("本地视频已清理，请重新提取");
    return blob;
}

export async function sendExtractionToWorkbench(record: VideoExtraction, tool: ExtractionTarget, previous: VideoDraft | undefined, signal: AbortSignal) {
    const { validate } = extractionSession(signal);
    const check = () => {
        validate();
        const latest = useVideoWorkbenchStore.getState();
        const error = extractionTargetError(tool, latest);
        if (error) throw new Error(error);
        if (latest.drafts[tool] !== previous) throw new Error("目标草稿已变化，请重新确认");
    };
    check();
    if (tool === "content-replace" && previous?.replacementJobId) {
        const jobs = await listReplacementJobs(signal);
        const job = jobs.find((job) => job.id === previous.replacementJobId);
        if (!job || (!job.archived && job.status !== "completed") || ["recognizing", "rendering"].includes(job.captionStatus || "")) {
            throw new Error("请先在内容替换中完成或归档当前整片任务");
        }
    }
    await readExtractedVideo(record, signal);
    check();
    await useVideoWorkbenchStore.getState().replaceDraft(tool, extractionDraft(tool, { ...record.media, id: nanoid() }));
    validate();
}
