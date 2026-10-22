import type { VideoDraft, VideoRecord } from "@/types/video-workbench";

/** 只规范当前草稿；历史任务的输入快照仍用于恢复，不在这里修改。 */
export function normalizeContentReplacementDraft(draft: VideoDraft): VideoDraft {
    if (draft.replacement !== "person") return draft;
    if (draft.route === "replicate" && !draft.maskedPerson && !draft.maskedEdit && !draft.regions.length && draft.replacementSeedTime === undefined && !draft.media.some((m) => m.role === "mask")) return draft;
    return {
        ...draft, route: "replicate", maskedPerson: false, maskedEdit: false,
        regions: [], replacementSeedTime: undefined, media: draft.media.filter((m) => m.role !== "mask"),
    };
}

export function hasReplacementRecovery(record: VideoRecord): boolean {
    return record.tool === "content-replace" && Boolean(record.replicateTask || record.workerJob || record.modelTask || record.replacementPipeline || record.maskedReplacement || record.replacementMaskTask);
}

export function isPendingReplacement(record: VideoRecord): boolean {
    return ["running", "interrupted"].includes(record.status) && hasReplacementRecovery(record);
}

export function isLegacyMaskedPersonRecord(record: VideoRecord): boolean {
    const input = record.replacementInput;
    return record.tool === "content-replace" && record.stage === "video" &&
        input?.replacement === "person" && input.route === "replicate" && input.maskedPerson && hasReplacementRecovery(record);
}
