import { expect, test } from "bun:test";
import { clipExtraction, extractionClipError, extractionDraft, extractionTargetError, extractionTargets, hasExtractionTargetDraft } from "../src/lib/video-extraction";
import { emptyVideoDraft, type VideoRecord, type WorkbenchMedia } from "../src/types/video-workbench";

const media: WorkbenchMedia = {
    id: "extracted", storageKey: "video:extracted", url: "blob:extracted", bytes: 100, mimeType: "video/mp4",
    kind: "video", role: "reference", name: "分享视频.mp4", referenceId: "reference",
    source: { platform: "douyin", title: "分享视频", author: "作者", sourceUrl: "https://v.douyin.com/example/" },
};
const state = () => ({ hydrated: true, storageError: "", busyTools: {}, records: [] as VideoRecord[] });

test("handoff blocks loading, failed storage and running or interrupted target tasks", () => {
    expect(extractionTargetError("upscale", { ...state(), hydrated: false })).toContain("尚未恢复");
    expect(extractionTargetError("upscale", { ...state(), storageError: "quota" })).toContain("存储异常");
    expect(extractionTargetError("upscale", { ...state(), busyTools: { upscale: true } })).toContain("已有任务");
    for (const status of ["running", "interrupted"] as const) {
        expect(extractionTargetError("upscale", { ...state(), records: [{ tool: "upscale", status } as VideoRecord] })).toContain("已有任务");
    }
});

test("unrelated and completed records allow handoff without rewriting history", () => {
    const records = [{ tool: "upscale", status: "completed" }, { tool: "viral-recreate", status: "running" }] as VideoRecord[];
    expect(extractionTargetError("upscale", { ...state(), records })).toBe("");
    expect(records).toHaveLength(2);
});

test("every supported destination receives the existing file, provenance and retention id", () => {
    for (const { key } of extractionTargets) {
        const draft = extractionDraft(key, media);
        expect(draft.media).toEqual([media]);
        expect(draft.media[0]).not.toBe(media);
        expect(draft.media[0].source).toBe(media.source);
        expect(draft.media[0].referenceId).toBe("reference");
        expect(draft.final).toBeNull();
        expect(draft.frames).toEqual([]);
        expect(draft.analysis).toBe("");
        expect(draft.activeRecord).toBeUndefined();
        expect(draft.replacementJobId).toBeUndefined();
        expect(draft.viralFrameSource).toBeUndefined();
    }
    expect(extractionDraft("subtitle-remove", media).subtitleMode).toBe("manual");
});

test("existing materials, settings, analysis and outputs require confirmation", () => {
    expect(hasExtractionTargetDraft("upscale")).toBe(false);
    expect(hasExtractionTargetDraft("upscale", emptyVideoDraft("upscale"))).toBe(false);
    for (const patch of [{ media: [media] }, { scale: 4 }, { analysis: "已分析" }, { final: media }, { replacementJobId: "job" }]) {
        expect(hasExtractionTargetDraft("upscale", { ...emptyVideoDraft("upscale"), ...patch })).toBe(true);
    }
});

test("manual selections respect video bounds and the existing one-to-thirty second worker range", () => {
    expect(extractionClipError(0, 1, 40_000)).toBe("");
    expect(extractionClipError(10, 40, 40_000)).toBe("");
    expect(extractionClipError(0.14, 1.14, 40_000)).toBe("");
    for (const [start, end] of [[-1, 3], [0, 41], [5, 5], [5, 4], [NaN, 10], [0, Infinity]]) {
        expect(extractionClipError(start, end, 40_000)).not.toBe("");
    }
    expect(extractionClipError(0, 0.99, 40_000)).toContain("1–30");
    expect(extractionClipError(0, 30.01, 40_000)).toContain("1–30");
    expect(extractionClipError(0, 10)).toContain("尚未识别");
});

test("a selected clip enters every destination with its own file and original time range", () => {
    const clipped = { ...media, id: "clip", name: "开场.mp4", storageKey: "video:clip", durationMs: 5000,
        source: { ...media.source!, clip: { extractionId: "parent", start: 12, end: 17 } } };
    const record = clipExtraction({ id: "clip", createdAt: 1, start: 12, end: 17, media: clipped });
    expect(record.originalBytes).toBe(clipped.bytes);
    for (const { key } of extractionTargets) {
        const draft = extractionDraft(key, record.media);
        expect(draft.media[0].storageKey).toBe("video:clip");
        expect(draft.media[0].durationMs).toBe(5000);
        expect(draft.media[0].source?.clip).toEqual({ extractionId: "parent", start: 12, end: 17 });
    }
});
