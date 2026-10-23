import { afterEach, expect, mock, test } from "bun:test";

const memory = new Map<string, unknown>();
let failRead = false;
let failWrite = false;
let delayRead: (() => Promise<unknown>) | undefined;
mock.module("localforage", () => ({ default: { createInstance: () => ({
    getItem: async (key: string) => { if (failRead) throw new Error("read failed"); return delayRead ? delayRead() : structuredClone(memory.get(key) || null); },
    setItem: async (key: string, value: unknown) => { if (failWrite) throw new Error("quota"); memory.set(key, structuredClone(value)); },
}) } }));
const { useVideoExtractionStore: store } = await import("../src/stores/use-video-extraction-store");
const record = {
    id: "one", createdAt: 100, originalBytes: 300, media: {
        id: "media", name: "片段.mp4", kind: "video" as const, role: "reference" as const,
        url: "blob:temporary", storageKey: "video:one", mimeType: "video/mp4", bytes: 300, referenceId: "ref",
        source: { platform: "xiaohongshu", title: "片段", author: "作者", sourceUrl: "https://xhslink.com/test" },
    },
};
afterEach(async () => { failRead = false; failWrite = false; delayRead = undefined; memory.clear(); await store.getState().load(""); });

test("extraction history reloads metadata and file handles without duplicating the video", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    await store.getState().load("");
    await store.getState().load("alice");
    expect(store.getState().records).toEqual([record]);
    expect(store.getState().records[0].media.referenceId).toBe("ref");
});

test("account changes hide previous records and reject cross-account writes", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    await store.getState().load("bob");
    expect(store.getState().records).toEqual([]);
    await expect(store.getState().add("alice", record)).rejects.toThrow("尚未恢复");
    await store.getState().load("alice");
    expect(store.getState().records).toHaveLength(1);
});

test("a late history load cannot expose the previous account after logout", async () => {
    let release!: (value: unknown) => void;
    delayRead = () => new Promise((resolve) => { release = resolve; });
    const pending = store.getState().load("alice");
    await store.getState().load("");
    release([record]);
    await pending;
    expect(store.getState().owner).toBe("");
    expect(store.getState().records).toEqual([]);
});

test("read and write failures keep existing history and never claim the failed record was saved", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    failWrite = true;
    await expect(store.getState().add("alice", { ...record, id: "two" })).rejects.toThrow("quota");
    expect(store.getState().records).toEqual([record]);
    failWrite = false;
    failRead = true;
    await store.getState().load("alice");
    expect(store.getState().error).toContain("读取失败");
    await expect(store.getState().add("alice", record)).rejects.toThrow();
    expect(memory.get("alice")).toEqual([record]);
});

test("removing an extraction record preserves metadata of other entries", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    await store.getState().add("alice", { ...record, id: "two" });
    await store.getState().remove("alice", "one");
    await store.getState().load("alice");
    expect(store.getState().records.map((row) => row.id)).toEqual(["two"]);
    expect(store.getState().records[0].media.source).toEqual(record.media.source);
});
