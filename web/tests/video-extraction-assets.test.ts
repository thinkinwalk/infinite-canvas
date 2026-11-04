import { afterEach, expect, mock, test } from "bun:test";
import type { AudioAsset, VideoAsset } from "../src/stores/use-asset-store";

const memory = new Map<string, string>();
const media = new Map<string, Blob>();
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
mock.module("../src/services/file-storage", () => ({
    cleanupUnusedMedia: async () => {},
    resolveMediaUrl: async () => "blob:restored",
    getMediaBlob: async (key: string) => media.get(key) || null,
}));
const { useAssetStore: store } = await import("../src/stores/use-asset-store");
const { saveVoiceAsset } = await import("../src/pages/video-voice-extract/save-voice-asset");
await store.persist.rehydrate();
const asset = {
    kind: "video" as const, title: "提取视频", tags: ["抖音"], coverUrl: "", source: "https://v.douyin.com/test/",
    metadata: { extractionId: "extraction", referenceId: "reference" },
    data: { storageKey: "video:compatible", url: "blob:compatible", width: 720, height: 1280, bytes: 200, mimeType: "video/mp4" },
};
afterEach(() => { failWrite = false; holdWrite = false; completeWrite = undefined; store.setState({ assets: [], hydrated: true }); memory.clear(); media.clear(); });

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

const sample = { storageKey: "voice:sample", url: "blob:sample", bytes: 44, mimeType: "audio/wav", durationMs: 5000 };
const wav = new Blob([new Uint8Array(44)], { type: "audio/wav" });

test("extracted person voice saves local audio and corrected transcript without account authentication", async () => {
    media.set(sample.storageKey, wav);
    const id = await saveVoiceAsset(sample, " 店主声音 ", " 核对后的简体字幕 ");
    const saved = JSON.parse(memory.get("infinite-canvas:asset_store")!).state.assets[0] as AudioAsset;
    expect(saved.id).toBe(id);
    expect(saved.kind).toBe("audio");
    expect(saved.title).toBe("店主声音");
    expect(saved.note).toBe("核对后的简体字幕");
    expect(saved.tags).toContain("人物音色");
    expect(saved.data).toEqual(sample);
    await store.persist.rehydrate();
    const restored = store.getState().assets[0] as AudioAsset;
    expect(restored.data.url).toBe("blob:restored");
    expect(restored.data.storageKey).toBe(sample.storageKey);
});

test("missing subtitles and failed recognition do not prevent saving a usable person voice", async () => {
    media.set(sample.storageKey, wav);
    await saveVoiceAsset(sample, "店主声音", "");
    expect(store.getState().assets[0].note).toBe("");
    expect(store.getState().assets[0].kind).toBe("audio");
});

test("missing audio or an unhydrated library cannot create a false saved voice", async () => {
    await expect(saveVoiceAsset(sample, "店主声音", "")).rejects.toThrow("重新提取");
    media.set(sample.storageKey, wav);
    store.setState({ hydrated: false });
    await expect(saveVoiceAsset(sample, "店主声音", "")).rejects.toThrow("正在加载");
    expect(store.getState().assets).toHaveLength(0);
});

test("voice persistence failure is reported and preserves existing library assets", async () => {
    const id = await store.getState().addAssetPersisted(asset);
    media.set(sample.storageKey, wav);
    failWrite = true;
    await expect(saveVoiceAsset(sample, "店主声音", "")).rejects.toThrow("资产保存失败");
    expect(store.getState().assets.map((item) => item.id)).toEqual([id]);
    expect(JSON.parse(memory.get("infinite-canvas:asset_store")!).state.assets).toHaveLength(1);
});
