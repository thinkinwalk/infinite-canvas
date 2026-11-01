import { emptyVideoDraft, type VideoDraft, type VideoRecord } from "@/types/video-workbench";

export function hasContentReplacementDraft(draft: VideoDraft | undefined): draft is VideoDraft {
    return Boolean(draft && (
        draft.media.length || draft.frames.length || draft.activeRecord || draft.replacementJobId ||
        draft.video || draft.edited || draft.final || draft.replacementSource ||
        draft.instructions.trim() || draft.regions.length ||
        draft.replacement !== "person" || draft.replacementModel !== "wan" || draft.route !== "replicate" ||
        draft.replicateResolution !== "480p" || draft.replicateTargetResolution !== "1080p" ||
        draft.subtitleMode !== "auto" || draft.subtitleSize !== 42 || draft.subtitleColor !== "#ffffff" ||
        draft.highlightColor !== "#ffe066" || draft.replaceSubtitles || draft.regenerateSubtitles
    ));
}

export function archiveContentReplacementDraft(draft: VideoDraft | undefined, records: VideoRecord[]): VideoRecord[] {
    if (!hasContentReplacementDraft(draft)) return records;
    const taskId = draft.replacementTaskId || crypto.randomUUID();
    const id = `content-replace-draft:${taskId}`;
    return [{
        id,
        tool: "content-replace",
        stage: "draft",
        status: "completed",
        createdAt: Date.now(),
        replacementDraft: { ...draft, replacementTaskId: taskId },
        result: draft.final || draft.edited || draft.video || undefined,
        text: draft.instructions || undefined,
    }, ...records.filter((record) => record.id !== id)];
}

export function newContentReplacementDraft(draft?: VideoDraft): VideoDraft {
    return { ...emptyVideoDraft("content-replace"), ...draft, replacementTaskId: draft?.replacementTaskId || crypto.randomUUID() };
}

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
