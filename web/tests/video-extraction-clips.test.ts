import { afterEach, expect, mock, test } from "bun:test";
import type { VideoExtraction, VideoExtractionClip } from "../src/stores/use-video-extraction-store";

let session = { token: "session", user: { id: "alice" } };
let controller = new AbortController();
let afterRead = () => {};
let afterTrim = () => {};
let trims = 0;
let failTrim = false;
let failSave = false;
let committed: VideoExtractionClip | undefined;
let replaced: VideoExtractionClip | undefined;
const source = { platform: "douyin", title: "原片", author: "作者", sourceUrl: "https://v.douyin.com/test/" };
const parent: VideoExtraction = {
    id: "parent", createdAt: 1, originalBytes: 1000,
    media: { id: "original", name: "原片.mp4", kind: "video", role: "reference", storageKey: "video:original",
        url: "blob:original", bytes: 1000, mimeType: "video/mp4", referenceId: "ref", durationMs: 60_000, source },
};
const file = { storageKey: "video:clip", url: "blob:clip", bytes: 100, mimeType: "video/mp4", referenceId: "ref", durationMs: 5000 };
mock.module("../src/stores/use-user-store", () => ({ useUserStore: { getState: () => session } }));
mock.module("../src/stores/use-video-workbench-store", () => ({ useVideoWorkbenchStore: { getState: () => ({ worker: { url: "/worker", token: "" } }) } }));
mock.module("../src/services/file-storage", () => ({ readPlayableVideoMeta: async () => ({ durationMs: 60_000, width: 720, height: 1280 }) }));
mock.module("../src/pages/video-extract/extraction-actions", () => ({ readExtractedVideo: async () => { afterRead(); return new Blob(["original"]); } }));
mock.module("../src/services/api/video-worker", () => ({ trimWorkbenchVideo: async (_worker: unknown, media: unknown, start: number, end: number, signal: AbortSignal) => {
    trims++;
    expect(media).toMatchObject({ storageKey: parent.media.storageKey, referenceId: "ref" });
    expect([start, end]).toEqual([5, 10]);
    expect(signal).toBe(controller.signal);
    afterTrim();
    if (failTrim) throw new Error("裁剪失败");
    return file;
} }));
mock.module("../src/stores/use-video-extraction-store", () => ({ useVideoExtractionStore: { getState: () => ({
    saveClip: async (owner: string, parentId: string, clip: VideoExtractionClip, previous: VideoExtractionClip | undefined, validate: () => void) => {
        validate();
        expect([owner, parentId]).toEqual(["alice", "parent"]);
        if (failSave) throw new Error("quota");
        committed = clip; replaced = previous;
    },
}) } }));
const { saveExtractionClip } = await import("../src/pages/video-extract/extraction-clips");
afterEach(() => {
    session = { token: "session", user: { id: "alice" } }; controller = new AbortController();
    afterRead = () => {}; afterTrim = () => {}; trims = 0; failTrim = false; failSave = false; committed = undefined; replaced = undefined;
});

test("a clip persists its own file, source range and shared retention group", async () => {
    const result = await saveExtractionClip(parent, "开场 / 钩子", [5, 10], controller.signal);
    expect(committed).toBe(result);
    expect(result.media.name).toBe("开场   钩子.mp4");
    expect(result.media.storageKey).toBe("video:clip");
    expect(result.media.referenceId).toBe("ref");
    expect(result.media.source).toEqual({ ...source, clip: { extractionId: parent.id, start: 5, end: 10 } });
    expect(parent.media.storageKey).toBe("video:original");
    expect(replaced).toBeUndefined();
});

test("invalid ranges or blank names never start a worker job", async () => {
    for (const range of [[-1, 10], [0, 61], [0, 31], [2, 2], [5, 5.5], [NaN, 10]] as [number, number][]) {
        await expect(saveExtractionClip(parent, "片段", range, controller.signal)).rejects.toThrow();
    }
    await expect(saveExtractionClip(parent, " / ", [5, 10], controller.signal)).rejects.toThrow("名称");
    expect(trims).toBe(0);
    expect(committed).toBeUndefined();
});

test("missing cached duration is read from the original media before cropping", async () => {
    await saveExtractionClip({ ...parent, media: { ...parent.media, durationMs: undefined } }, "片段", [5, 10], controller.signal);
    expect(trims).toBe(1);
    expect(committed?.end).toBe(10);
});

test("rename reuses the file and identity while recropping creates a distinct file identity", async () => {
    const previous: VideoExtractionClip = { id: "old", createdAt: 2, start: 5, end: 10,
        media: { ...parent.media, ...file, id: "old", name: "旧名.mp4", source: { ...source, clip: { extractionId: parent.id, start: 5, end: 10 } } } };
    const renamed = await saveExtractionClip(parent, "新名", [5, 10], controller.signal, previous);
    expect(renamed.id).toBe("old");
    expect(renamed.media.storageKey).toBe(file.storageKey);
    expect(trims).toBe(0);
    expect(replaced).toBe(previous);
    const recropped = await saveExtractionClip(parent, "新范围", [5, 10], controller.signal, { ...previous, start: 4 });
    expect(recropped.id).not.toBe("old");
    expect(trims).toBe(1);
});

test("cancel or account switch after local read or worker completion never commits a clip", async () => {
    afterRead = () => controller.abort();
    await expect(saveExtractionClip(parent, "片段", [5, 10], controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(trims).toBe(0);
    controller = new AbortController(); afterRead = () => {};
    afterTrim = () => { session = { token: "other", user: { id: "bob" } }; };
    await expect(saveExtractionClip(parent, "片段", [5, 10], controller.signal)).rejects.toThrow("登录状态");
    expect(committed).toBeUndefined();
    session = { token: "session", user: { id: "alice" } };
    afterTrim = () => controller.abort();
    await expect(saveExtractionClip(parent, "片段", [5, 10], controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(committed).toBeUndefined();
});

test("worker and history storage failures preserve the parent and do not report success", async () => {
    failTrim = true;
    await expect(saveExtractionClip(parent, "片段", [5, 10], controller.signal)).rejects.toThrow("裁剪失败");
    expect(committed).toBeUndefined();
    failTrim = false; failSave = true;
    await expect(saveExtractionClip(parent, "片段", [5, 10], controller.signal)).rejects.toThrow("quota");
    expect(committed).toBeUndefined();
    expect(parent.media.storageKey).toBe("video:original");
});
