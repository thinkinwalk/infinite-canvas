import type { ReplacementJob } from "@/services/api/replacement-jobs";
import type { VideoDraft, VideoRecord } from "@/types/video-workbench";

export const replacementHistoryStates = {
    planning: "分析中", ready: "待确认费用", preview: "预览待确认", running: "处理中", paused: "已暂停", completed: "已完成",
};
export const videoHistoryStates = { running: "处理中", completed: "已完成", failed: "本次未完成", interrupted: "查询暂停" };
export const replacementHistoryKinds = { person: "换人物", product: "换商品", background: "换背景" };

export function replacementJobActive(job: ReplacementJob) {
    return ["planning", "running"].includes(job.status) || ["recognizing", "rendering"].includes(job.captionStatus || "");
}

export function replacementJobResult(job: ReplacementJob) {
    return job.captionResult || job.result || job.previousResults?.[job.previousResults.length - 1];
}

export function videoHistoryStatus(records: VideoRecord[], hasResult: boolean) {
    const latest = records.find((record) => record.stage !== "draft");
    if (!latest) return hasResult ? "已有结果" : "草稿";
    return videoHistoryStates[latest.status];
}

export function contentReplacementTaskGroups(records: VideoRecord[], jobs: ReplacementJob[], current?: VideoDraft) {
    const parents = new Map<string, string>();
    const root = (key: string): string => {
        const parent = parents.get(key);
        if (!parent) { parents.set(key, key); return key; }
        if (parent === key) return key;
        const value = root(parent);
        parents.set(key, value);
        return value;
    };
    const link = (a: string, b: string) => { parents.set(root(b), root(a)); };
    const localId = (record: VideoRecord) => `local:${record.replacementDraft?.replacementTaskId || record.replacementInput?.replacementTaskId || record.id}`;
    const localRecords = records.filter((record) => record.tool === "content-replace");
    for (const record of localRecords) root(localId(record));
    for (const job of jobs) root(`job:${job.id}`);
    // Only explicit saved identifiers join browser snapshots and online jobs.
    for (const record of localRecords) {
        if (record.replacementDraft?.replacementJobId) link(localId(record), `job:${record.replacementDraft.replacementJobId}`);
    }
    for (const draft of [...localRecords.flatMap((record) => record.replacementDraft ? [record.replacementDraft] : []), ...(current ? [current] : [])]) {
        const key = draft.replacementTaskId ? `local:${draft.replacementTaskId}` : draft.replacementJobId ? `job:${draft.replacementJobId}` : undefined;
        if (!key) continue;
        for (const id of new Set([...(draft.replacementJobIds || []), ...(draft.replacementJobId ? [draft.replacementJobId] : [])]))
            link(key, `job:${id}`);
        const active = localRecords.find((record) => record.id === draft.activeRecord);
        if (active) link(key, localId(active));
    }
    const groups = new Map<string, { records: VideoRecord[]; jobs: ReplacementJob[]; keys: string[] }>();
    const group = (key: string) => {
        const id = root(key);
        if (!groups.has(id)) groups.set(id, { records: [], jobs: [], keys: [] });
        return groups.get(id)!;
    };
    for (const record of localRecords) group(localId(record)).records.push(record);
    for (const job of jobs) group(`job:${job.id}`).jobs.push(job);
    for (const key of parents.keys()) if (groups.has(root(key))) groups.get(root(key))!.keys.push(`content-replace:${key}`);
    return [...groups].map(([id, entries]) => {
        const ordered = entries.records.sort((a, b) => b.createdAt - a.createdAt);
        const online = entries.jobs.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
        const snapshot = ordered.find((record) => record.replacementDraft);
        const saved = snapshot?.replacementDraft || ordered.find((record) => record.replacementInput)?.replacementInput;
        const live = current?.replacementJobId && online.some((job) => job.id === current.replacementJobId) ? current : undefined;
        const source = saved?.media.find((media) => media.role === "reference" && media.kind === "video") || live?.media.find((media) => media.role === "reference" && media.kind === "video");
        const latest = ordered.find((record) => record.stage !== "draft");
        const job = online[0];
        const resultJob = online.find((item) => replacementJobResult(item));
        const resultRecord = ordered.find((record) => record.result);
        const hasResult = Boolean(resultJob || resultRecord);
        const kind = saved?.replacement || "person";
        return {
            id, keys: entries.keys, records: ordered, jobs: online, snapshot, latest, job, resultJob, resultRecord, hasResult,
            title: source?.name || saved?.instructions.trim() || `${replacementHistoryKinds[kind]}任务${job ? ` · ${job.id.slice(0, 8)}` : ""}`,
            kind: replacementHistoryKinds[kind],
            status: job ? job.captionStatus === "failed" ? "字幕未完成" : job.captionStatus === "recognizing" ? "识别字幕中" : job.captionStatus === "rendering" ? "合成字幕中" : replacementHistoryStates[job.status] : videoHistoryStatus(ordered, hasResult),
            updatedAt: Math.max(...ordered.map((record) => record.createdAt), ...online.map((item) => Date.parse(item.updatedAt || item.createdAt))),
            processing: online.some(replacementJobActive) || ordered.some((record) => record.status === "running"),
        };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
}
