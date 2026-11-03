import { expect, test } from "bun:test";
import { contentReplacementTaskGroups, replacementJobActive, replacementJobResult, videoHistoryStatus } from "../src/lib/video-task-history";
import { emptyVideoDraft, type VideoRecord } from "../src/types/video-workbench";
import type { ReplacementJob } from "../src/services/api/replacement-jobs";
import { archiveContentReplacementDraft, hasContentReplacementDraft } from "../src/lib/content-replacement-state";

const file = { url: "blob:output", storageKey: "output", bytes: 100, mimeType: "video/mp4" };
const source = { ...file, id: "source", role: "reference" as const, kind: "video" as const, name: "source.mp4" };
const draft = (patch = {}) => ({ ...emptyVideoDraft("content-replace"), replacementTaskId: "task", media: [source], ...patch });
const record = (patch: Partial<VideoRecord> = {}): VideoRecord => ({
    id: "step", tool: "content-replace", stage: "video", status: "completed", createdAt: 100, replacementInput: draft(), ...patch,
});
const job = (patch: Partial<ReplacementJob> = {}): ReplacementJob => ({
    id: "online", model: "model", resolution: "720", seconds: "5", status: "completed", step: "done",
    credits: 400, planned: true, previewRequired: false, previewReady: false, previewApproved: false,
    captionRevision: 0, subtitleSize: 42, subtitleColor: "#ffffff", subtitleBottom: 0, subtitleFont: "",
    source: "source.mp4", subtitles: false, createdAt: new Date(200).toISOString(), parts: null, ...patch,
});

test("steps and a saved snapshot count as one task without counting the snapshot as a completion", () => {
    const records = [
        record({ id: "failed", status: "failed", createdAt: 300, error: "failed" }),
        record({ id: "complete", result: file }),
        record({ id: "snapshot", stage: "draft", createdAt: 500, replacementDraft: draft() }),
    ];
    const groups = contentReplacementTaskGroups(records, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: "source.mp4", kind: "换人物", status: "本次未完成", hasResult: true });
    expect(groups[0].resultRecord?.id).toBe("complete");
    expect(groups[0].records).toHaveLength(3);
});

test("a draft without a generated result stays a draft even though snapshots have completed status", () => {
    const groups = contentReplacementTaskGroups([record({ stage: "draft", replacementDraft: draft() })], []);
    expect(groups[0]).toMatchObject({ status: "草稿", hasResult: false });
    expect(videoHistoryStatus([], false)).toBe("草稿");
    expect(videoHistoryStatus([], true)).toBe("已有结果");
});

test("online jobs and browser snapshots join only through explicit identifiers", () => {
    const groups = contentReplacementTaskGroups([
        record({ stage: "draft", replacementDraft: draft({ replacementJobId: "online" }), result: file }),
    ], [job({ result: "output.mp4" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].jobs).toHaveLength(1);
    expect(groups[0].keys).toContain("content-replace:job:online");
    expect(groups[0].keys).toContain("content-replace:local:task");
});

test("the current draft links an online job before a snapshot has been saved", () => {
    const groups = contentReplacementTaskGroups([], [job()], draft({ replacementJobId: "online" }));
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("source.mp4");
    expect(groups[0].keys).toContain("content-replace:local:task");
});

test("changing inputs keeps explicit older online versions in one task", () => {
    const saved = draft({ replacementJobIds: ["older", "online"] });
    const groups = contentReplacementTaskGroups([
        record({ stage: "draft", replacementDraft: saved }),
    ], [job({ id: "older", createdAt: new Date(50).toISOString(), result: "old-result.mp4" }), job({ status: "paused" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].jobs).toHaveLength(2);
    expect(groups[0].status).toBe("已暂停");
    expect(groups[0].resultJob?.id).toBe("older");
    expect(groups[0].hasResult).toBe(true);
});

test("same filenames and identical media are never enough to join unrelated old records", () => {
    const groups = contentReplacementTaskGroups([
        record({ id: "old-a", replacementInput: undefined }),
        record({ id: "old-b", replacementInput: undefined }),
        record({ id: "new-a", replacementInput: draft({ replacementTaskId: "a" }) }),
        record({ id: "new-b", replacementInput: draft({ replacementTaskId: "b" }) }),
    ], [job()]);
    expect(groups).toHaveLength(5);
});

test("a saved active record explicitly links an older step with no task identifier", () => {
    const groups = contentReplacementTaskGroups([
        record({ id: "legacy", replacementInput: undefined }),
        record({ id: "snapshot", replacementInput: undefined, replacementDraft: draft({ activeRecord: "legacy" }) }),
    ], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].records.map((item) => item.id)).toContain("legacy");
});

test("a saved job link without a local task id still joins its snapshot", () => {
    const saved = { ...emptyVideoDraft("content-replace"), replacementJobId: "online" };
    const groups = contentReplacementTaskGroups([record({ replacementInput: undefined, replacementDraft: saved })], [job()]);
    expect(groups).toHaveLength(1);
});

test("tasks sort by actual online activity and retain previous outputs after caption failure", () => {
    const groups = contentReplacementTaskGroups([], [
        job({ id: "newer-created", createdAt: new Date(400).toISOString() }),
        job({ id: "older-updated", createdAt: new Date(100).toISOString(), updatedAt: new Date(600).toISOString(), result: "ready.mp4", captionStatus: "failed" }),
    ]);
    expect(groups[0]).toMatchObject({ status: "字幕未完成", hasResult: true, updatedAt: 600 });
    expect(groups[0].job?.id).toBe("older-updated");
});

test("processing includes captions and all linked online versions", () => {
    for (const value of [job({ status: "running" }), job({ status: "planning" }), job({ captionStatus: "recognizing" }), job({ captionStatus: "rendering" })])
        expect(replacementJobActive(value)).toBe(true);
    expect(replacementJobActive(job({ status: "paused" }))).toBe(false);
    const groups = contentReplacementTaskGroups([], [job({ status: "running" })]);
    expect(groups[0].processing).toBe(true);
});

test("a failed regeneration with only previous versions still has a viewable result", () => {
    const saved = job({ status: "paused", result: undefined, previousResults: ["older.mp4", "latest.mp4"] });
    expect(replacementJobResult(saved)).toBe("latest.mp4");
    const groups = contentReplacementTaskGroups([], [saved]);
    expect(groups[0].hasResult).toBe(true);
    expect(groups[0].resultJob?.id).toBe(saved.id);
    expect(replacementJobResult({ ...saved, result: "current.mp4", captionResult: "caption.mp4" })).toBe("caption.mp4");
});
test("grouping does not mutate input records, drafts, jobs or ordering", () => {
    const records = [record({ createdAt: 1 }), record({ id: "later", createdAt: 2 })];
    const jobs = [job(), job({ id: "other" })];
    const before = structuredClone({ records, jobs });
    contentReplacementTaskGroups(records, jobs);
    expect({ records, jobs }).toEqual(before);
});

test("clearing inputs never drops saved online version identifiers when archiving the current draft", () => {
    const saved = { ...emptyVideoDraft("content-replace"), replacementTaskId: "task", replacementJobIds: ["older", "newer"] };
    expect(hasContentReplacementDraft(saved)).toBe(true);
    const snapshots = archiveContentReplacementDraft(saved, []);
    expect(snapshots[0].replacementDraft?.replacementJobIds).toEqual(["older", "newer"]);
    expect(contentReplacementTaskGroups(snapshots, [job({ id: "older" }), job({ id: "newer" })])).toHaveLength(1);
});
