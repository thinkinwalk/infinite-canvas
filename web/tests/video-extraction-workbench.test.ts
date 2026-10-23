import { afterEach, expect, mock, test } from "bun:test";
import { emptyVideoDraft, type VideoRecord } from "../src/types/video-workbench";

const memory = new Map<string, string>();
let failWrite = false;
let holdWrite = false;
let completeWrite: (() => void) | undefined;
mock.module("localforage", () => ({ default: { createInstance: () => ({
    getItem: async (key: string) => memory.get(key) || null,
    setItem: async (key: string, value: string) => {
        if (failWrite) throw new Error("quota");
        if (holdWrite) await new Promise<void>((resolve) => { completeWrite = resolve; });
        memory.set(key, value);
    },
    removeItem: async (key: string) => { memory.delete(key); },
}) } }));
const { useVideoWorkbenchStore: store } = await import("../src/stores/use-video-workbench-store");
await store.persist.rehydrate();
afterEach(() => { failWrite = false; holdWrite = false; completeWrite = undefined; store.setState({ storageError: "", drafts: {}, records: [] }); });

test("new extraction drafts remove optional fields from the previous draft without modifying history or other tools", async () => {
    const record = { id: "completed", tool: "viral-recreate", status: "completed" } as VideoRecord;
    const other = { ...emptyVideoDraft("upscale"), title: "其他草稿" };
    store.setState({ drafts: {
        "viral-recreate": { ...emptyVideoDraft("viral-recreate"), viralFrameSource: "old-source", activeRecord: "old", viralOutputStale: true },
        upscale: other,
    }, records: [record] });
    await store.getState().replaceDraft("viral-recreate", emptyVideoDraft("viral-recreate"));
    const state = store.getState();
    expect(state.drafts["viral-recreate"]?.viralFrameSource).toBeUndefined();
    expect(state.drafts["viral-recreate"]?.activeRecord).toBeUndefined();
    expect(state.drafts["viral-recreate"]?.viralOutputStale).toBeUndefined();
    expect(state.drafts.upscale).toBe(other);
    expect(state.records).toEqual([record]);
});

test("handoff remains pending until IndexedDB persistence completes", async () => {
    holdWrite = true;
    let done = false;
    const writing = store.getState().replaceDraft("upscale", emptyVideoDraft("upscale")).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(completeWrite).toBeDefined();
    holdWrite = false; completeWrite!();
    await writing;
    expect(done).toBe(true);
    expect(JSON.parse(memory.get("workbench")!).state.drafts.upscale.media).toEqual([]);
});

test("a failed draft write is reported to the extraction action", async () => {
    failWrite = true;
    await expect(store.getState().replaceDraft("upscale", emptyVideoDraft("upscale"))).rejects.toThrow("草稿保存失败");
    expect(store.getState().storageError).toBe("quota");
});
