import { afterEach, expect, mock, test } from "bun:test";

let session = { token: "session", user: { id: "alice" } };
let controller = new AbortController();
let onImport = () => {};
let onStore = () => {};
let failImport = false;
let failSave = false;
const added: unknown[] = [];
const source = { platform: "douyin", title: "分享", author: "作者", sourceUrl: "https://v.douyin.com/test/" };
const media = { storageKey: "video:compatible", url: "blob:compatible", referenceId: "ref", bytes: 50, mimeType: "video/mp4" };
mock.module("../src/stores/use-user-store", () => ({ useUserStore: { getState: () => session } }));
mock.module("../src/stores/use-video-workbench-store", () => ({ useVideoWorkbenchStore: { getState: () => ({ worker: { url: "/worker", token: "" } }) } }));
mock.module("../src/stores/use-video-extraction-store", () => ({ useVideoExtractionStore: { getState: () => ({
    add: async (owner: string, record: unknown) => { if (failSave) throw new Error("quota"); expect(owner).toBe("alice"); added.push(record); },
}) } }));
mock.module("../src/services/api/video-import", () => ({ importVideoURL: async () => {
    onImport();
    if (failImport) throw new Error("解析失败");
    return { file: new File(["original-video"], "分享.mp4", { type: "video/mp4" }), source };
} }));
mock.module("../src/services/api/video-worker", () => ({ storeTemporaryWorkbenchVideo: async (_config: unknown, _file: unknown, _name: unknown, options: { compatible: boolean; signal: AbortSignal; source: unknown }) => {
    expect(options).toEqual({ compatible: true, signal: controller.signal, source });
    onStore();
    return media;
} }));
const { extractVideoToHistory } = await import("../src/pages/video-extract/extract-video");
afterEach(() => {
    session = { token: "session", user: { id: "alice" } }; controller = new AbortController();
    onImport = () => {}; onStore = () => {}; failImport = false; failSave = false; added.length = 0;
});

test("successful extraction saves original size, playable copy and provenance together", async () => {
    const stages: string[] = [];
    const result = await extractVideoToHistory("share", controller.signal, (stage) => stages.push(stage));
    expect(stages).toEqual(["extract", "prepare", "save"]);
    expect(result.originalBytes).toBe(14);
    expect(result.media.storageKey).toBe("video:compatible");
    expect(result.media.referenceId).toBe("ref");
    expect(result.media.source).toEqual(source);
    expect(result.media.kind).toBe("video");
    expect(added).toEqual([result]);
});

test("cancel during parsing or media preparation never commits a late record", async () => {
    onImport = () => controller.abort();
    await expect(extractVideoToHistory("share", controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(added).toHaveLength(0);
    controller = new AbortController(); onImport = () => {}; onStore = () => controller.abort();
    await expect(extractVideoToHistory("share", controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(added).toHaveLength(0);
});

test("session changes during parsing or preparation never commit into another account", async () => {
    onImport = () => { session = { token: "new-session", user: { id: "bob" } }; };
    await expect(extractVideoToHistory("share", controller.signal)).rejects.toThrow("登录状态已变化");
    session = { token: "session", user: { id: "alice" } }; onImport = () => {};
    onStore = () => { session = { token: "new-session", user: { id: "bob" } }; };
    await expect(extractVideoToHistory("share", controller.signal)).rejects.toThrow("登录状态已变化");
    expect(added).toHaveLength(0);
});

test("parser or persistence failures do not report successful extraction", async () => {
    failImport = true;
    const stages: string[] = [];
    await expect(extractVideoToHistory("share", controller.signal, (stage) => stages.push(stage))).rejects.toThrow("解析失败");
    expect(stages).toEqual(["extract"]);
    expect(added).toHaveLength(0);
    failImport = false; failSave = true;
    await expect(extractVideoToHistory("share", controller.signal)).rejects.toThrow("quota");
    expect(added).toHaveLength(0);
});
