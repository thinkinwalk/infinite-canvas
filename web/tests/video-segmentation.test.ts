import { expect, mock, test } from "bun:test";
import type { SegmentPlan } from "../src/lib/video-segmentation";
mock.module("../src/i18n", () => ({ default: { t: (key: string) => key } }));
const { moveSegmentBoundary, segmentationModels, segmentPlanError, splitOrMergeSegment } = await import("../src/lib/video-segmentation");
const { defaultConfig } = await import("../src/stores/use-config-store");

const plan = (): SegmentPlan => ({
    sourceId: "source", workerUrl: "/worker", model: "", minSeconds: 2, maxSeconds: 15, targetSeconds: 10,
    duration: 20, sceneCount: 1, pauseCount: 0,
    parts: [{ start: 0, end: 10, boundary: "scene", name: "开场", selected: true }, { start: 10, end: 20, boundary: "end", name: "结尾", selected: true }],
});

test("editing shared boundaries preserves full coverage and validates both neighbours", () => {
    const moved = moveSegmentBoundary(plan(), 0, 12.345);
    expect(moved.parts.map((part) => [part.start, part.end])).toEqual([[0, 12.345], [12.345, 20]]);
    expect(segmentPlanError(moved)).toBe("");
    expect(() => moveSegmentBoundary(plan(), 0, 19)).toThrow();
    expect(() => moveSegmentBoundary(plan(), 0, NaN)).toThrow();
    expect(plan().parts[0].end).toBe(10);
});

test("splitting and merging retain timeline and reject model limit violations", () => {
    const split = splitOrMergeSegment(plan(), 0);
    expect(split.parts.map((part) => [part.start, part.end])).toEqual([[0, 5], [5, 10], [10, 20]]);
    expect(splitOrMergeSegment(split, 0, true).parts.map((part) => [part.start, part.end])).toEqual([[0, 10], [10, 20]]);
    expect(() => splitOrMergeSegment(plan(), 0, true)).toThrow();
    expect(() => splitOrMergeSegment({ ...plan(), minSeconds: 6 }, 0)).toThrow();
});

test("already saved ranges cannot be moved or split and gaps are never accepted", () => {
    const saved = plan();
    saved.parts[1].savedClipId = "clip";
    expect(() => moveSegmentBoundary(saved, 0, 12)).toThrow("已保存");
    expect(() => splitOrMergeSegment(saved, 1)).toThrow("已保存");
    const gap = plan();
    gap.parts[1].start = 11;
    expect(segmentPlanError(gap)).toContain("不连续");
    expect(segmentPlanError({ ...plan(), duration: 21 })).toContain("完整覆盖");
});

test("model choices use reference limits rather than output seconds and exclude unsupported models", () => {
    const config = { ...defaultConfig, channelMode: "remote" as const, channels: [{ id: "remote", name: "平台", baseUrl: "", apiKey: "", apiFormat: "openai" as const,
        models: ["supported", "unknown", "text-only"].map((name) => ({ name, capability: "video" as const })) }],
        videoModels: {
            supported: { displayName: "支持参考", interface: "relay", maxImages: 1, maxVideos: 1, maxAudios: 0, seconds: ["30"], referenceVideoMinSeconds: 2, referenceVideoMaxSeconds: 15 },
            unknown: { interface: "relay", maxVideos: 1 },
            "text-only": { interface: "relay", maxVideos: 0, referenceVideoMaxSeconds: 15 },
        } };
    const choices = segmentationModels(config as typeof defaultConfig);
    expect(choices.map((item) => [item.value, item.min, item.max])).toEqual([["remote::supported", 2, 15]]);
});
