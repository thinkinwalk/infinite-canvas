import { afterEach, beforeEach, expect, mock, test } from "bun:test";

const databases = new Map<string, Map<string, unknown>>();
const database = (name = "app_state") => {
    if (!databases.has(name)) databases.set(name, new Map());
    return databases.get(name)!;
};
const forage = {
    config: () => {},
    createInstance: ({ storeName }: { storeName: string }) => ({
        getItem: async (key: string) => database(storeName).get(key) ?? null,
        setItem: async (key: string, value: unknown) => { database(storeName).set(key, value); return value; },
        removeItem: async (key: string) => { database(storeName).delete(key); },
        iterate: async (callback: (value: unknown, key: string) => void) => { for (const [key, value] of database(storeName)) callback(value, key); },
    }),
    getItem: async (key: string) => database().get(key) ?? null,
};
mock.module("localforage", () => ({ default: forage }));
mock.module("../src/stores/use-config-store", () => ({ withLocalProxy: (url: string) => url }));
const user = { token: "session", user: { id: "test-user" } };
mock.module("../src/stores/use-user-store", () => ({ useUserStore: { getState: () => user } }));
let workbench: any;
let assets: unknown[];
let projects: unknown[];
const persist = { hasHydrated: () => true };
mock.module("../src/stores/use-video-workbench-store", () => ({
    useVideoWorkbenchStore: { getState: () => workbench, setState: (patch: object) => Object.assign(workbench, patch), persist },
}));
mock.module("../src/stores/use-asset-store", () => ({ useAssetStore: { getState: () => ({ hydrated: true, assets }), persist } }));
mock.module("../src/stores/canvas/use-canvas-store", () => ({ useCanvasStore: { getState: () => ({ hydrated: true, projects }), persist } }));
mock.module("../src/lib/localforage-storage", () => ({ localForageStorage: { getItem: async (key: string) => database().get(key) ?? null } }));
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request: async (_name: string, options: unknown, callback?: (lock: object) => unknown) =>
        callback ? callback({}) : (options as () => unknown)(),
} } });

const { cleanupTemporaryVideoReferences, readVideoReferenceRetention, registerTemporaryReferenceCopy, saveAnalysisReference, trackTemporaryVideo, updateVideoReferenceRetention } = await import("../src/services/video-reference-retention");
const originalFetch = globalThis.fetch;
const key = "media:reference";
beforeEach(() => {
    databases.clear();
    assets = [];
    projects = [];
    workbench = { hydrated: true, storageError: "", drafts: {}, records: [], digitalPresets: [], busyTools: {} };
    database("video_workbench").set("workbench", JSON.stringify({ state: workbench }));
    globalThis.fetch = (async () => Response.json({ code: 0, data: { canClean: true } })) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
async function expired() {
    database("media_files").set(key, new Blob(["original"]));
    database("media_files").set("media:historical", new Blob(["history"]));
    const media = await trackTemporaryVideo({ storageKey: key, url: "blob:reference", mimeType: "video/mp4", bytes: 8 }, "对标.mp4");
    const saved = (await readVideoReferenceRetention(media.referenceId!))!;
    database("temporary_video_references").set(saved.id, { ...saved, lastUsedAt: Date.now() - 8 * 86400000 });
    return media;
}

test("an expired new reference is deleted, its metadata survives and historical media stays intact", async () => {
    const media = await expired();
    workbench.drafts = { "viral-recreate": { media: [media], analysis: "保留分析" } };
    await cleanupTemporaryVideoReferences();
    expect(database("media_files").has(key)).toBe(false);
    expect(database("media_files").has("media:historical")).toBe(true);
    expect((await readVideoReferenceRetention(media.referenceId!))?.cleanedAt).toBeNumber();
    expect(workbench.drafts["viral-recreate"].media[0].url).toBe("");
    expect(workbench.drafts["viral-recreate"].analysis).toBe("保留分析");
});

test("assets, canvas references, shared drafts and active task snapshots protect the underlying bytes", async () => {
    for (const protect of ["asset", "canvas", "shared-draft", "shared-derivatives", "running", "interrupted", "output"] as const) {
        const media = await expired();
        assets = protect === "asset" ? [media] : [];
        projects = protect === "canvas" ? [{ nodes: [media] }] : [];
        workbench.drafts = protect === "shared-draft" ? { a: { media: [media] }, b: { media: [media] } } : {};
        if (protect === "shared-derivatives") {
            const saved = (await readVideoReferenceRetention(media.referenceId!))!;
            database("temporary_video_references").set(saved.id, { ...saved, keys: [...saved.keys, "media:trim"] });
            workbench.drafts = { a: { media: [media] }, b: { media: [{ ...media, storageKey: "media:trim" }] } };
        }
        workbench.records = ["running", "interrupted"].includes(protect) ? [{ status: protect, viralInput: { media: [media] } }] : protect === "output" ? [{ status: "completed", result: media }] : [];
        await cleanupTemporaryVideoReferences();
        expect(database("media_files").has(key)).toBe(true);
        expect((await readVideoReferenceRetention(media.referenceId!))?.cleanedAt).toBeUndefined();
    }
});

test("server-side active work and missing or damaged local task snapshots defer cleanup", async () => {
    const media = await expired();
    globalThis.fetch = (async () => Response.json({ code: 0, data: { canClean: false } })) as typeof fetch;
    await cleanupTemporaryVideoReferences();
    expect(database("media_files").has(key)).toBe(true);
    globalThis.fetch = (async () => Response.json({ code: 0, data: { canClean: true } })) as typeof fetch;
    database("video_workbench").delete("workbench");
    await cleanupTemporaryVideoReferences();
    expect(database("media_files").has(key)).toBe(true);
    expect((await readVideoReferenceRetention(media.referenceId!))?.cleanedAt).toBeUndefined();
});

test("retention toggles and completing comparison persist the explicit lifecycle choice", async () => {
    const media = await expired();
    await updateVideoReferenceRetention(media.referenceId!, "keep");
    await cleanupTemporaryVideoReferences();
    expect(database("media_files").has(key)).toBe(true);
    await updateVideoReferenceRetention(media.referenceId!, "temporary");
    await updateVideoReferenceRetention(media.referenceId!, "review");
    const saved = (await readVideoReferenceRetention(media.referenceId!))!;
    expect(saved.keep).toBe(false);
    expect(saved.reviewedAt).toBeNumber();
    await cleanupTemporaryVideoReferences();
    expect(database("media_files").has(key)).toBe(true);
});

test("a pin saved by another tab in the persisted asset store prevents deletion", async () => {
    const media = await expired();
    database().set("infinite-canvas:asset_store", JSON.stringify({ state: { assets: [{ data: media }] } }));
    await cleanupTemporaryVideoReferences();
    expect(database("media_files").has(key)).toBe(true);
});

test("analysis cache records its exact source and retains every derived file for later cleanup", async () => {
    const media = await expired();
    const analysis = { storageKey: "media:analysis", url: "blob:analysis", mimeType: "video/mp4", bytes: 4 };
    await saveAnalysisReference(media.referenceId!, key, analysis);
    expect((await readVideoReferenceRetention(media.referenceId!))?.analysisSourceKey).toBe(key);
    await saveAnalysisReference(media.referenceId!, "media:trimmed", { ...analysis, storageKey: "media:trim-analysis" });
    const saved = (await readVideoReferenceRetention(media.referenceId!))!;
    expect(saved.analysisSourceKey).toBe("media:trimmed");
    expect(saved.keys).toEqual([key, "media:analysis", "media:trim-analysis"]);
});

test("a late worker download cannot resurrect a cleaned reference", async () => {
    const original = await expired();
    await cleanupTemporaryVideoReferences();
    const copy = { ...original, storageKey: "media:late-copy" };
    database("media_files").set(copy.storageKey, new Blob(["late"]));
    await expect(registerTemporaryReferenceCopy(original.referenceId!, copy)).rejects.toThrow("已清理");
    expect(database("media_files").has(copy.storageKey)).toBe(false);
});
