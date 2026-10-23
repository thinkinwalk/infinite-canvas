import { afterEach, expect, mock, test } from "bun:test";
import { emptyVideoDraft, type VideoDraft, type VideoRecord } from "../src/types/video-workbench";
import type { VideoExtraction } from "../src/stores/use-video-extraction-store";

let session = { token: "session", user: { id: "alice" } };
const original = new Blob(["original"]);
const compatible = new Blob(["compatible"]);
let reference: { storageKey: string; cleanedAt?: number } | null = { storageKey: "video:original" };
let missing = false;
let afterUse = () => {};
let jobs: { id: string; status: string; archived?: boolean; captionStatus?: string }[] = [];
let written: VideoDraft | undefined;
let failPersist = false;
const state = {
    hydrated: true, storageError: "", busyTools: {} as Record<string, boolean>, records: [] as VideoRecord[],
    drafts: {} as Record<string, VideoDraft>, replaceDraft: async (_tool: string, draft: VideoDraft) => {
        if (failPersist) throw new Error("存储失败");
        written = draft;
    },
};
mock.module("../src/stores/use-user-store", () => ({ useUserStore: { getState: () => session } }));
mock.module("../src/stores/use-video-workbench-store", () => ({ useVideoWorkbenchStore: { getState: () => state } }));
mock.module("../src/services/file-storage", () => ({ getMediaBlob: async (key: string) => missing ? null : key === "video:original" ? original : compatible }));
mock.module("../src/services/video-reference-retention", () => ({
    updateVideoReferenceRetention: async () => { afterUse(); },
    readVideoReferenceRetention: async () => reference,
}));
mock.module("../src/services/api/replacement-jobs", () => ({ listReplacementJobs: async () => jobs }));
const { readExtractedVideo, sendExtractionToWorkbench } = await import("../src/pages/video-extract/extraction-actions");
const record: VideoExtraction = {
    id: "one", createdAt: 1, originalBytes: original.size,
    media: { id: "media", name: "视频.mp4", url: "blob:compatible", storageKey: "video:compatible", bytes: compatible.size,
        kind: "video", role: "reference", mimeType: "video/mp4", referenceId: "ref",
        source: { platform: "douyin", title: "视频", author: "作者", sourceUrl: "https://v.douyin.com/test/" } },
};
const signal = () => new AbortController().signal;
afterEach(() => {
    session = { token: "session", user: { id: "alice" } }; reference = { storageKey: "video:original" };
    missing = false; afterUse = () => {}; jobs = []; written = undefined; failPersist = false;
    state.drafts = {}; state.busyTools = {}; state.records = [];
});

test("download reads the original while creation reads the playable copy", async () => {
    expect(await readExtractedVideo(record, signal(), true)).toBe(original);
    expect(await readExtractedVideo(record, signal())).toBe(compatible);
});

test("expired or missing files cannot be downloaded or handed off", async () => {
    reference = { storageKey: "video:original", cleanedAt: 1 };
    await expect(sendExtractionToWorkbench(record, "upscale", undefined, signal())).rejects.toThrow("已清理");
    expect(written).toBeUndefined();
    reference = { storageKey: "video:original" }; missing = true;
    await expect(readExtractedVideo(record, signal(), true)).rejects.toThrow("已清理");
});

test("a target edited or started during media lookup is never overwritten", async () => {
    afterUse = () => { state.drafts.upscale = emptyVideoDraft("upscale"); };
    await expect(sendExtractionToWorkbench(record, "upscale", undefined, signal())).rejects.toThrow("草稿已变化");
    expect(written).toBeUndefined();
    state.drafts = {}; afterUse = () => { state.busyTools.upscale = true; };
    await expect(sendExtractionToWorkbench(record, "upscale", undefined, signal())).rejects.toThrow("已有任务");
    expect(written).toBeUndefined();
});

test("handoff preserves provenance and awaits draft persistence", async () => {
    await sendExtractionToWorkbench(record, "viral-recreate", undefined, signal());
    expect(written?.media[0].storageKey).toBe("video:compatible");
    expect(written?.media[0].source).toEqual(record.media.source);
    expect(written?.media[0].id).not.toBe(record.media.id);
    written = undefined; failPersist = true;
    await expect(sendExtractionToWorkbench(record, "upscale", undefined, signal())).rejects.toThrow("存储失败");
    expect(written).toBeUndefined();
});

test("unknown, unfinished and caption-processing replacement jobs block draft replacement", async () => {
    const previous = { ...emptyVideoDraft("content-replace"), replacementJobId: "job" };
    state.drafts["content-replace"] = previous;
    for (const currentJobs of [[], [{ id: "job", status: "running" }], [{ id: "job", status: "completed", captionStatus: "rendering" }]]) {
        jobs = currentJobs;
        await expect(sendExtractionToWorkbench(record, "content-replace", previous, signal())).rejects.toThrow("整片任务");
        expect(written).toBeUndefined();
    }
    jobs = [{ id: "job", status: "completed" }];
    await sendExtractionToWorkbench(record, "content-replace", previous, signal());
    expect(written?.replacementJobId).toBeUndefined();
});

test("session changes and cancellation during file preparation block downloads and writes", async () => {
    afterUse = () => { session = { token: "other", user: { id: "bob" } }; };
    await expect(sendExtractionToWorkbench(record, "upscale", undefined, signal())).rejects.toThrow("登录状态");
    expect(written).toBeUndefined();
    session = { token: "session", user: { id: "alice" } };
    const controller = new AbortController(); afterUse = () => controller.abort();
    await expect(readExtractedVideo(record, controller.signal, true)).rejects.toHaveProperty("name", "AbortError");
});
