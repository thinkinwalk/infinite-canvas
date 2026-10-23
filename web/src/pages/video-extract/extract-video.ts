import { nanoid } from "nanoid";
import { importVideoURL } from "@/services/api/video-import";
import { storeTemporaryWorkbenchVideo } from "@/services/api/video-worker";
import { useVideoExtractionStore, type VideoExtraction } from "@/stores/use-video-extraction-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useUserStore } from "@/stores/use-user-store";

export type ExtractionStage = "extract" | "prepare" | "save";

export async function extractVideoToHistory(text: string, signal: AbortSignal, onStage?: (stage: ExtractionStage) => void) {
    const { token, user } = useUserStore.getState();
    if (!token || !user?.id) throw new Error("请登录后提取视频");
    const validate = () => {
        signal.throwIfAborted();
        const current = useUserStore.getState();
        if (current.token !== token || current.user?.id !== user.id) throw new Error("登录状态已变化，请重新提取");
    };
    validate();
    onStage?.("extract");
    const { file, source } = await importVideoURL(text, signal);
    validate();
    onStage?.("prepare");
    const media = await storeTemporaryWorkbenchVideo(useVideoWorkbenchStore.getState().worker, file, file.name, { source, signal, compatible: true });
    validate();
    const record: VideoExtraction = {
        id: nanoid(), createdAt: Date.now(), originalBytes: file.size,
        media: { ...media, id: nanoid(), name: file.name, kind: "video", role: "reference", source },
    };
    onStage?.("save");
    await useVideoExtractionStore.getState().add(user.id, record);
    validate();
    return record;
}
