import { emptyVideoDraft, type VideoDraft, type VideoRecord } from "@/types/video-workbench";

export function hasViralTaskContent(draft: VideoDraft) {
    return Boolean(draft.media.length || draft.frames.length || draft.video || draft.activeRecord ||
        [draft.instructions, draft.analysis, draft.script, draft.transcript, draft.viralFacts, draft.viralProductAnalysis,
            draft.viralKeyframePrompt, draft.viralClimaxPrompt, draft.viralScriptSuggestion, draft.viralProductSuggestion,
            ...Object.values(draft.viralBrief || {}), ...Object.values(draft.viralAnalyses || {}).map((value) => value?.text),
        ].some((value) => value?.trim()));
}

export function archiveViralTask(draft: VideoDraft | undefined, records: VideoRecord[]): VideoRecord[] {
    if (!draft || !hasViralTaskContent(draft)) return records;
    const taskId = draft.viralTaskId || crypto.randomUUID(), id = `viral-draft:${taskId}`;
    const snapshot: VideoRecord = {
        id, tool: "viral-recreate", stage: "draft", status: "completed", createdAt: Date.now(),
        viralTaskId: taskId, viralDraft: { ...draft, viralTaskId: taskId },
        text: draft.script || draft.analysis || draft.instructions, result: draft.video || undefined,
    };
    return [snapshot, ...records.filter((record) => record.id !== id)];
}

export function viralTaskDraft(record: VideoRecord): VideoDraft | undefined {
    if (record.viralDraft) return { ...emptyVideoDraft("viral-recreate"), ...record.viralDraft };
    if (!record.viralInput) return;
    const { channelMode: _mode, baseUrl: _url, ...input } = record.viralInput;
    const draft = {
        ...emptyVideoDraft("viral-recreate"), ...input,
        ...(record.status === "completed" ? record.draftPatch : {}),
        viralTaskId: record.viralTaskId || record.id, activeRecord: record.id,
    };
    return { ...draft, viralStep: record.stage === "video" ? 2 : ["script", "keyframe"].includes(record.stage) ? 1 : 0 };
}

export function viralTaskGroups(records: VideoRecord[]) {
    const groups = new Map<string, VideoRecord[]>();
    for (const record of records) {
        const id = record.viralTaskId || record.id;
        const group = groups.get(id) || [];
        group.push(record);
        groups.set(id, group);
    }
    return [...groups].map(([id, entries]) => {
        const ordered = [...entries].sort((a, b) => b.createdAt - a.createdAt);
        const current = ordered.find((record) => record.viralDraft || record.viralInput) || ordered[0];
        const draft = viralTaskDraft(current);
        return {
            id, current, records: ordered.filter((record) => record.stage !== "draft"),
            result: ordered.find((record) => record.result) || ordered.find((record) => record.text),
            updatedAt: ordered[0].createdAt,
            title: draft?.media.find((media) => media.kind === "video" && media.role === "reference")?.name || draft?.instructions.trim() || "未命名任务",
        };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
}
