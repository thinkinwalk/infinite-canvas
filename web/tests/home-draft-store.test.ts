import { afterEach, expect, mock, test } from "bun:test";

const memory = new Map<string, string>();
let readError = false;
let writeError = false;
mock.module("localforage", () => ({ default: { createInstance: () => ({
    getItem: async (key: string) => { if (readError) throw new Error("read failed"); return memory.get(key) || null; },
    setItem: async (key: string, value: string) => { if (writeError) throw new Error("quota"); memory.set(key, value); },
    removeItem: async (key: string) => { memory.delete(key); },
}) } }));
const { useHomeDraftStore: store } = await import("../src/stores/use-home-draft-store");
await store.persist.rehydrate();
afterEach(() => {
    readError = false; writeError = false;
    store.setState({ hydrated: false, storageError: false, kind: "image", prompts: { image: "", video: "", human: "" }, humanMode: "photo", humanCopySource: "manual" });
    memory.clear();
});

test("home draft updates and hydration retain separate prompts and selected creation settings", async () => {
    store.getState().setKind("human");
    store.getState().setPrompt("image", "商品照片");
    store.getState().setPrompt("video", "镜头环绕");
    store.getState().setPrompt("human", "口播原文");
    store.getState().setHumanMode("video");
    store.getState().setHumanCopySource("brief");
    await store.persist.rehydrate();
    expect(store.getState()).toMatchObject({
        hydrated: true, storageError: false, kind: "human",
        prompts: { image: "商品照片", video: "镜头环绕", human: "口播原文" }, humanMode: "video", humanCopySource: "brief",
    });
    expect(Object.keys(JSON.parse(memory.get("home-creation")!).state).sort()).toEqual(["humanCopySource", "humanMode", "kind", "prompts"]);
});

test("failed home draft hydration reports storage failure while completing initialization", async () => {
    readError = true;
    await store.persist.rehydrate();
    expect(store.getState().hydrated).toBe(true);
    expect(store.getState().storageError).toBe(true);
    expect(store.getState().prompts).toEqual({ image: "", video: "", human: "" });
});

test("failed home draft writes preserve the current prompt and expose storage failure", async () => {
    writeError = true;
    store.getState().setPrompt("video", "未保存的草稿");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(store.getState().prompts.video).toBe("未保存的草稿");
    expect(store.getState().storageError).toBe(true);
    expect(memory.has("home-creation")).toBe(false);
});
