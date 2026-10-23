import { afterEach, expect, mock, test } from "bun:test";
import type { SegmentPlan } from "../src/lib/video-segmentation";

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
const clip = { id: "clip", createdAt: 200, start: 2, end: 5, media: { ...record.media, id: "clip", storageKey: "video:clip", name: "开场.mp4", durationMs: 3000 } };
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

test("multiple clips survive reload without duplicating or changing the parent file", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    await store.getState().saveClip("alice", record.id, clip);
    await store.getState().saveClip("alice", record.id, { ...clip, id: "second" });
    await store.getState().load("alice");
    expect(store.getState().records[0].media).toEqual(record.media);
    expect(store.getState().records[0].clips?.map((item) => item.id)).toEqual(["clip", "second"]);
    expect(store.getState().records[0].clips?.[0].media.storageKey).toBe("video:clip");
});

test("edits and removals preserve sibling clips, while stale edits are rejected", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    await store.getState().saveClip("alice", record.id, clip);
    await store.getState().saveClip("alice", record.id, { ...clip, id: "second" });
    const renamed = { ...clip, media: { ...clip.media, name: "改名.mp4" } };
    await store.getState().saveClip("alice", record.id, renamed, clip);
    await expect(store.getState().saveClip("alice", record.id, clip, clip)).rejects.toThrow("其他页面修改");
    await expect(store.getState().removeClip("alice", record.id, clip)).rejects.toThrow("已变化");
    await store.getState().removeClip("alice", record.id, renamed);
    expect(store.getState().records[0].clips?.map((item) => item.id)).toEqual(["second"]);
    expect(store.getState().records[0].media).toEqual(record.media);
});

test("removed parents, changed accounts, cancelled commits and quota failures never claim a clip was saved", async () => {
    await store.getState().load("alice");
    await expect(store.getState().saveClip("alice", record.id, clip)).rejects.toThrow("记录已移除");
    await store.getState().add("alice", record);
    failWrite = true;
    await expect(store.getState().saveClip("alice", record.id, clip)).rejects.toThrow("quota");
    expect(store.getState().records[0].clips).toBeUndefined();
    failWrite = false;
    const controller = new AbortController();
    controller.abort();
    await expect(store.getState().saveClip("alice", record.id, clip, undefined, () => controller.signal.throwIfAborted())).rejects.toHaveProperty("name", "AbortError");
    await store.getState().load("bob");
    await expect(store.getState().saveClip("alice", record.id, clip)).rejects.toThrow("账号已变化");
    expect((memory.get("alice") as typeof record[])[0]).toEqual(record);
});

const segmentationPlan = (): SegmentPlan => ({
    sourceId: "source.mp4", workerUrl: "/worker", model: "", minSeconds: 1, maxSeconds: 4, targetSeconds: 3,
    duration: 6, sceneCount: 1, pauseCount: 0, parts: [
        { start: 0, end: 3, name: "开场", boundary: "scene", selected: true },
        { start: 3, end: 6, name: "结尾", boundary: "end", selected: true },
    ],
});
test("segment plans reload and stale tabs cannot erase a newer plan or a saved marker", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    const plan = segmentationPlan();
    await store.getState().savePlan("alice", record.id, plan, () => {});
    await store.getState().load("alice");
    expect(store.getState().records[0].segmentPlan).toEqual(plan);
    await expect(store.getState().savePlan("alice", record.id, plan, () => {})).rejects.toThrow("其他页面变化");
    const cropped = { ...clip, start: 0, end: 3 };
    await store.getState().saveClip("alice", record.id, cropped, undefined, () => {}, plan.sourceId);
    expect(store.getState().records[0].segmentPlan?.parts[0].savedClipId).toBe(cropped.id);
    await expect(store.getState().saveClip("alice", record.id, cropped, undefined, () => {}, plan.sourceId)).rejects.toThrow("已变化");
    await expect(store.getState().savePlan("alice", record.id, plan, () => {}, plan)).rejects.toThrow("其他页面变化");
    expect(store.getState().records[0].clips).toHaveLength(1);
});

test("quota failure writes neither clip nor saved marker; removing the clip makes the range available again", async () => {
    await store.getState().load("alice");
    await store.getState().add("alice", record);
    const plan = segmentationPlan();
    await store.getState().savePlan("alice", record.id, plan, () => {});
    const cropped = { ...clip, start: 0, end: 3 };
    failWrite = true;
    await expect(store.getState().saveClip("alice", record.id, cropped, undefined, () => {}, plan.sourceId)).rejects.toThrow("quota");
    expect(store.getState().records[0].clips).toBeUndefined();
    expect(store.getState().records[0].segmentPlan?.parts[0].savedClipId).toBeUndefined();
    failWrite = false;
    await store.getState().saveClip("alice", record.id, cropped, undefined, () => {}, plan.sourceId);
    await store.getState().removeClip("alice", record.id, cropped);
    expect(store.getState().records[0].segmentPlan?.parts[0].savedClipId).toBeUndefined();
    expect(store.getState().records[0].media).toEqual(record.media);
});
