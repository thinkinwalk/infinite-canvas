import { getMediaBlob, type UploadedFile } from "@/services/file-storage";
import { useAssetStore } from "@/stores/use-asset-store";

export async function saveVoiceAsset(sample: UploadedFile, name: string, transcript: string) {
    if (!useAssetStore.getState().hydrated) throw new Error("素材库正在加载，请稍后重试");
    if (!name.trim()) throw new Error("请填写音色名称");
    const blob = sample.storageKey ? await getMediaBlob(sample.storageKey) : null;
    if (!blob?.size) throw new Error("参考音频已清理，请重新提取");
    return useAssetStore.getState().addAssetPersisted({
        kind: "audio",
        title: name.trim(),
        coverUrl: "",
        tags: ["人物音色"],
        note: transcript.trim(),
        data: {
            url: sample.url,
            storageKey: sample.storageKey,
            bytes: blob.size,
            mimeType: blob.type || sample.mimeType,
            durationMs: sample.durationMs,
        },
    });
}
