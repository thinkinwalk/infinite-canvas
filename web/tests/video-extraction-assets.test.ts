import { afterEach, expect, mock, test } from "bun:test";
import type { VideoAsset } from "../src/stores/use-asset-store";

const memory = new Map<string, string>();
let failWrite = false;
let holdWrite = false;
let completeWrite: (() => void) | undefined;
mock.module("../src/lib/localforage-storage", () => ({ localForageStorage: {
    getItem: async (key: string) => memory.get(key) || null,
    setItem: async (key: string, value: string) => {
        if (failWrite) throw new Error("quota");
        if (holdWrite) await new Promise<void>((resolve) => { completeWrite = resolve; });
        memory.set(key, value);
    },
    removeItem: async (key: string) => { memory.delete(key); },
} }));
mock.module("../src/services/image-storage", () => ({
    cleanupUnusedImages: async () => {}, ensureImagePreview: async () => {}, previewUrlFor: () => "",
    resolveImageUrl: async () => "", uploadImage: async () => ({}),
}));
mock.module("../src/services/file-storage", () => ({ cleanupUnusedMedia: async () => {}, resolveMediaUrl: async () => "blob:restored" }));
const { useAssetStore: store } = await import("../src/stores/use-asset-store");
await store.persist.rehydrate();
const asset = {
    kind: "video" as const, title: "提取视频", tags: ["抖音"], coverUrl: "", source: "https://v.douyin.com/test/",
    metadata: { extractionId: "extraction", referenceId: "reference" },
    data: { storageKey: "video:compatible", url: "blob:compatible", width: 720, height: 1280, bytes: 200, mimeType: "video/mp4" },
};
afterEach(() => { failWrite = false; holdWrite = false; completeWrite = undefined; store.setState({ assets: [] }); memory.clear(); });

test("saving an extracted asset persists provenance and existing video reference", async () => {
    const id = await store.getState().addAssetPersisted(asset);
    const saved = JSON.parse(memory.get("infinite-canvas:asset_store")!).state.assets[0] as VideoAsset;
    expect(saved.id).toBe(id);
    expect(saved.source).toBe(asset.source);
    expect(saved.metadata?.extractionId).toBe("extraction");
    expect(saved.data.storageKey).toBe("video:compatible");
});

test("asset save awaits durable storage", async () => {
    holdWrite = true;
    let done = false;
    const saving = store.getState().addAssetPersisted(asset).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    holdWrite = false; completeWrite!();
    await saving;
    expect(done).toBe(true);
});

test("quota failures remove only the unsaved addition and retain prior assets", async () => {
    const id = await store.getState().addAssetPersisted(asset);
    failWrite = true;
    await expect(store.getState().addAssetPersisted({ ...asset, title: "未保存的视频" })).rejects.toThrow("资产保存失败");
    expect(store.getState().assets.map((item) => item.id)).toEqual([id]);
    expect(JSON.parse(memory.get("infinite-canvas:asset_store")!).state.assets).toHaveLength(1);
});
