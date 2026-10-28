import { afterEach, expect, test } from "bun:test";
import type { PublicManagedCatalog } from "../src/services/api/model-management";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } });
}
const { configForFeature, defaultConfig, managedEffectiveConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { useUserStore } = await import("../src/stores/use-user-store");
const { requestVideoUnderstanding, videoAnalysisAvailable, videoAnalysisConfig, VIDEO_ANALYSIS_FEATURE } = await import("../src/services/api/video-understanding");
const { viralAnalysisMode, viralInput, viralVideoPrompt } = await import("../src/pages/video-tool/viral-recreate-request");
const { viralSource, viralAnalysisInputKey, viralAnalysisProvenance, viralAnalysisResultPatch, viralAdoptAnalysis, viralAdoptedAnalysisError, viralAdoptedAnalysisText, viralCurrentAnalysis, viralEditAnalysis, viralRecordAnalysis } = await import("../src/pages/video-tool/viral-analysis");
const { emptyVideoDraft } = await import("../src/types/video-workbench");

const catalog: PublicManagedCatalog = {
    enabled: true, revision: 41, features: [],
    models: [
        { id: "model_native", label: "视频分析", description: "", capability: "text" },
        { id: "model_script", label: "脚本", description: "", capability: "text" },
    ],
    bindings: [
        { featureId: VIDEO_ANALYSIS_FEATURE, modelId: "model_native", available: true, default: true, order: 0, operations: ["video-understand"], adapter: "text.gemini-video", credits: 7 },
        ...["viral-recreate.script", "viral-recreate.analyze"].map((featureId) => ({ featureId, modelId: "model_script", available: true, default: true, order: 0, operations: ["text"], adapter: "text.openai", credits: 3 })),
    ],
};
const config = managedEffectiveConfig({ ...defaultConfig, channelMode: "remote" }, catalog, { text: "viral-recreate.script" });
const originalFetch = globalThis.fetch, originalReader = globalThis.FileReader;
const originalUser = useUserStore.getState(), originalConfig = useConfigStore.getState();
afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalReader;
    useUserStore.setState(originalUser);
    useConfigStore.setState(originalConfig);
});

test("native video binding is independent of script/image analysis and never inferred from a label", () => {
    expect(videoAnalysisAvailable(config)).toBe(true);
    expect(videoAnalysisConfig(config).textModel).toBe("remote::model_native");
    expect(config.textModel).toBe("remote::model_script");
    expect(configForFeature(config, "viral-recreate.analyze", "text").textModel).toBe("remote::model_script");
    const unsupported = { ...config, managed: { ...catalog, bindings: catalog.bindings.map((b) => ({ ...b, adapter: "text.openai" })) } };
    expect(videoAnalysisAvailable(unsupported)).toBe(false);
    const draft = emptyVideoDraft("viral-recreate");
    expect(viralAnalysisMode(draft, config)).toBe("video");
    expect(viralAnalysisMode(draft, unsupported)).toBe("frames");
    expect(viralAnalysisMode({ ...draft, viralAnalysisMode: "video" }, unsupported)).toBe("video");
    expect(viralAnalysisMode({ ...draft, viralAnalysisMode: "frames" }, config)).toBe("frames");
    expect(viralInput(draft, config).viralAnalysisMode).toBe("video");
    expect(videoAnalysisAvailable({ ...config, channelMode: "local" })).toBe(false);
});

test("video bytes, signed quote and feature go to native analysis without a worker or responses call", async () => {
    const calls: string[] = [];
    const reader = class {
        result = "data:video/mp4;base64,dmlkZW8=";
        onload?: () => void;
        readAsDataURL() { this.onload?.(); }
    };
    globalThis.FileReader = reader as unknown as typeof FileReader;
    useUserStore.setState({ token: "native-test", hydrateUser: async () => {} });
    let submitted = false;
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        calls.push(path);
        if (path === "/api/v1/models/quote") return new Response(JSON.stringify({ code: 0, data: { credits: 7, quoteToken: "native-proof", calculation: "7 点" } }));
        if (path.startsWith("data:")) return new Response("video", { headers: { "Content-Type": "video/mp4" } });
        expect(path).toBe("/api/v1/video-understanding");
        expect(submitted).toBe(true);
        const headers = init?.headers as Record<string, string>;
        expect(headers).toMatchObject({ "X-Model-Feature": VIDEO_ANALYSIS_FEATURE, "X-Model-Revision": "41", "X-Model-Quote": "native-proof", "X-Expected-Credits": "7", Authorization: "Bearer native-test" });
        expect(JSON.parse(String(init?.body))).toEqual({ model: "model_native", prompt: "分析声音和动作", video: { mimeType: "video/mp4", data: "dmlkZW8=" } });
        return new Response(JSON.stringify({ code: 0, data: { text: "00:00 人物转身" } }));
    };
    const text = await requestVideoUnderstanding(config, { url: "data:video/mp4;base64,dmlkZW8=", storageKey: "", mimeType: "video/mp4", bytes: 5, width: 100, height: 100 }, "分析声音和动作", new AbortController().signal, () => { submitted = true; });
    expect(text).toBe("00:00 人物转身");
    expect(calls).toEqual(["/api/v1/models/quote", "data:video/mp4;base64,dmlkZW8=", "/api/v1/video-understanding"]);
});

test("retired video analysis cannot silently fall back or send data", async () => {
    const missing = { ...config, managed: { ...catalog, revision: 42, bindings: [] } };
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("unexpected"); };
    await expect(requestVideoUnderstanding(missing, { url: "data:video/mp4;base64,dmlkZW8=", storageKey: "", mimeType: "video/mp4", bytes: 5, width: 100, height: 100 }, "分析", new AbortController().signal)).rejects.toThrow("没有可用");
    expect(calls).toBe(0);
});

const referenceDraft = () => {
    const draft = emptyVideoDraft("viral-recreate");
    draft.media = [{ id: "reference-a", name: "原视频.mp4", kind: "video", role: "reference", url: "blob:video-a", storageKey: "video-a", mimeType: "video/mp4", bytes: 5, width: 100, height: 100 }];
    draft.frames = [{ url: "blob:frame-a", storageKey: "frame-a", mimeType: "image/jpeg", bytes: 5, width: 100, height: 100 }];
    draft.viralFrameSource = viralSource(draft);
    draft.viralFrameTimes = [0];
    draft.viralTranscriptSource = viralSource(draft);
    draft.transcript = "商品介绍";
    return draft;
};

test("native analysis depends only on its source, not sampling, transcription, product or generation settings", () => {
    const draft = referenceDraft(), key = viralAnalysisInputKey(draft, "video");
    const changed = { ...draft, frameCount: 12, frames: [], viralFrameTimes: [], viralUseTranscript: true, transcript: "修改转写", viralFacts: "新商品", script: "改编稿", viralAnalysisMode: "frames" as const, viralFirstFrameId: "frame:a" };
    expect(viralAnalysisInputKey(changed, "video")).toBe(key);
    expect(viralAnalysisInputKey({ ...changed, media: [] }, "video")).not.toBe(key);
    expect(viralAnalysisInputKey({ ...draft, media: draft.media.map((m) => ({ ...m, url: "blob:restored" })) }, "video")).toBe(key);
});

test("sample analysis tracks frames and only the transcript explicitly selected for its source", () => {
    const draft = referenceDraft(), key = viralAnalysisInputKey(draft, "frames");
    expect(viralAnalysisInputKey({ ...draft, transcript: "未采用的编辑" }, "frames")).toBe(key);
    expect(viralAnalysisInputKey({ ...draft, frameCount: 8 }, "frames")).not.toBe(key);
    expect(viralAnalysisInputKey({ ...draft, frames: [] }, "frames")).not.toBe(key);
    expect(viralAnalysisInputKey({ ...draft, viralFrameTimes: [1] }, "frames")).not.toBe(key);
    const enabled = { ...draft, viralUseTranscript: true };
    expect(viralAnalysisInputKey(enabled, "frames")).not.toBe(key);
    expect(viralAnalysisInputKey({ ...enabled, transcript: "已采用的编辑" }, "frames")).not.toBe(viralAnalysisInputKey(enabled, "frames"));
    expect(viralAnalysisInputKey({ ...enabled, viralTranscriptSource: "another-video" }, "frames")).toBe(viralAnalysisInputKey({ ...enabled, transcript: "" }, "frames"));
});

test("unedited results automatically become the current reference while preserving modes and script body", () => {
    const draft = { ...referenceDraft(), script: "保留已有脚本" };
    const video = { text: "视频动作和声音", provenance: viralAnalysisProvenance(draft, "video", config) };
    const withVideo = { ...draft, ...viralAnalysisResultPatch(draft, video) };
    const frames = { text: "离散画面结构", provenance: viralAnalysisProvenance(draft, "frames", config) };
    const withBoth = { ...withVideo, ...viralAnalysisResultPatch(withVideo, frames) };
    expect(withBoth.viralAnalyses?.video).toEqual(video);
    expect(withBoth.viralAnalyses?.frames).toEqual(frames);
    expect(withBoth.analysis).toBe(frames.text);
    expect(withBoth.viralAdoptedAnalysis?.provenance).toEqual(frames.provenance);
    expect(withBoth.viralScriptStale).toBe(true);
    expect(withBoth.script).toBe(draft.script);
    expect(viralAdoptedAnalysisError(withBoth)).toBe("");
    expect(draft.viralAnalyses).toBeUndefined();
    expect(video.provenance.model).toBe("remote::model_native");
    expect(frames.provenance.model).toBe("remote::model_script");
    expect(video.provenance.sourceName).toBe("原视频.mp4");
});

test("reanalyzing replaces an unedited result and records the new source without a pending suggestion", () => {
    const draft = referenceDraft(), original = { text: "第一份分析", provenance: viralAnalysisProvenance(draft, "video", config) };
    const adopted = { ...draft, ...viralAnalysisResultPatch(draft, original) };
    const next = { text: "第二份分析", provenance: { ...original.provenance, createdAt: original.provenance.createdAt + 1 } };
    const updated = { ...adopted, ...viralAnalysisResultPatch(adopted, next) };
    expect(updated.analysis).toBe(next.text);
    expect(updated.viralAnalyses?.video).toEqual(next);
    expect(updated.viralAdoptedAnalysis?.provenance.createdAt).toBe(next.provenance.createdAt);
});

test("another mode and unattributed legacy body both protect manual reference content", () => {
    const draft = referenceDraft(), original = { text: "人工校对音画", provenance: { ...viralAnalysisProvenance(draft, "video", config), edited: true } };
    const adopted = { ...draft, viralAnalyses: { video: original }, ...viralAdoptAnalysis(draft, original) };
    const next = { text: "新抽样结果", provenance: viralAnalysisProvenance(draft, "frames", config) };
    const updated = { ...adopted, ...viralAnalysisResultPatch(adopted, next) };
    expect(updated.analysis).toBe(original.text);
    expect(updated.viralAnalyses?.frames).toEqual(next);
    const legacy = { ...draft, analysis: "旧分析，来源不明" };
    expect(viralAnalysisResultPatch(legacy, next).analysis).toBeUndefined();
    expect(viralCurrentAnalysis(legacy).provenance.modelLabel).toBe("来源未确认");
    expect(viralCurrentAnalysis(legacy).provenance.createdAt).toBe(0);
});

test("editing an adopted version synchronizes the actual script reference and keeps stale input blocked", () => {
    const draft = { ...referenceDraft(), script: "旧脚本" };
    const version = { text: "原稿", provenance: viralAnalysisProvenance(draft, "video", config) };
    const adopted = { ...draft, ...viralAnalysisResultPatch(draft, version) };
    const edited = { ...adopted, ...viralEditAnalysis(adopted, version, "右侧编辑稿") };
    expect(edited.analysis).toBe("右侧编辑稿");
    expect(edited.viralAnalyses?.video?.text).toBe(edited.analysis);
    expect(edited.viralAdoptedAnalysis?.provenance.edited).toBe(true);
    expect(edited.viralScriptStale).toBe(true);
    expect(viralAdoptedAnalysisText(edited)).toContain("右侧编辑稿");
    const stale = { ...edited, media: [] };
    const editedStale = { ...stale, ...viralEditAnalysis(stale, viralCurrentAnalysis(stale), "再次编辑", true) };
    expect(viralAdoptedAnalysisError(editedStale)).toContain("输入已变化");
    const other = { text: "未采用抽样稿", provenance: viralAnalysisProvenance(edited, "frames", config) };
    expect(viralEditAnalysis(edited, other, "只改抽样稿").analysis).toBeUndefined();
});

test("late results cannot automatically acknowledge changed inputs; record reuse preserves unrelated inputs", () => {
    const draft = referenceDraft(), version = { text: "历史视频分析", provenance: viralAnalysisProvenance(draft, "video", config) };
    const changed = { ...draft, media: [], viralFacts: "当前商品", instructions: "当前要求", script: "当前脚本" };
    expect(viralAnalysisResultPatch(changed, version).analysis).toBeUndefined();
    const adopted = { ...changed, ...viralAdoptAnalysis(changed, version) };
    expect(adopted.media).toEqual([]);
    expect(adopted.viralFacts).toBe(changed.viralFacts);
    expect(adopted.instructions).toBe(changed.instructions);
    expect(adopted.script).toBe(changed.script);
    expect(viralAdoptedAnalysisText(adopted)).toContain("用户确认沿用原稿");
    const record = {
        id: "record", tool: "viral-recreate" as const, stage: "analyze", status: "completed" as const, createdAt: 1,
        draftPatch: { viralAnalysisMode: "video" as const, viralAnalyses: { video: { ...version, suggestion: { ...version, text: "真正的新结果" } } } },
    };
    expect(viralRecordAnalysis(record)?.text).toBe("真正的新结果");
    expect(viralRecordAnalysis({ ...record, status: "failed" })).toBeUndefined();
    expect(viralRecordAnalysis({ ...record, stage: "product-analyze" })).toBeUndefined();
});
test("reanalyzing protects the editable draft and adopted version while storing a suggestion with its own provenance", () => {
    const draft = referenceDraft();
    const original = { text: "手动校对后的原稿", provenance: { ...viralAnalysisProvenance(draft, "video", config), edited: true } };
    const saved = { ...draft, viralAnalyses: { video: original }, ...viralAdoptAnalysis(draft, original) };
    const next = { text: "模型新分析", provenance: { ...viralAnalysisProvenance(draft, "video", config), createdAt: original.provenance.createdAt + 1 } };
    const updated = { ...saved, ...viralAnalysisResultPatch(saved, next) };
    expect(updated.viralAnalyses?.video?.text).toBe(original.text);
    expect(updated.viralAnalyses?.video?.suggestion).toEqual(next);
    expect(updated.analysis).toBe(original.text);
    expect(updated.viralAdoptedAnalysis).toEqual(saved.viralAdoptedAnalysis);
    expect(viralAdoptedAnalysisText(updated)).toContain(original.text);
    expect(viralAdoptedAnalysisText(updated)).not.toContain(next.text);
});

test("changing the viewed mode never switches the adopted analysis used by prompts", () => {
    const draft = referenceDraft();
    const video = { text: "采用的视频分析", provenance: viralAnalysisProvenance(draft, "video", config) };
    const frames = { text: "未采用的抽样分析", provenance: viralAnalysisProvenance(draft, "frames", config) };
    const adopted = { ...draft, viralAnalyses: { video, frames }, ...viralAdoptAnalysis(draft, video), viralAnalysisMode: "frames" as const };
    expect(viralAdoptedAnalysisError(adopted)).toBe("");
    const prompt = viralVideoPrompt(adopted, defaultConfig);
    expect(prompt).toContain(video.text);
    expect(prompt).not.toContain(frames.text);
    expect(prompt).toContain("视频与音轨");
});

test("new source blocks adopted analysis until explicit reuse, without rewriting its original source", () => {
    const draft = referenceDraft();
    const version = { text: "原视频分析稿", provenance: viralAnalysisProvenance(draft, "video", config) };
    const adopted = { ...draft, ...viralAdoptAnalysis(draft, version) };
    const replaced = { ...adopted, media: adopted.media.map((m) => ({ ...m, id: "reference-b", storageKey: "video-b", name: "新视频.mp4" })) };
    expect(viralAdoptedAnalysisError(replaced)).toContain("输入已变化");
    expect(() => viralAdoptedAnalysisText(replaced)).toThrow("输入已变化");
    expect(() => viralVideoPrompt(replaced, defaultConfig)).toThrow("输入已变化");
    const confirmed = { ...replaced, ...viralAdoptAnalysis(replaced, version) };
    expect(viralAdoptedAnalysisError(confirmed)).toBe("");
    expect(confirmed.viralAdoptedAnalysis?.provenance).toEqual(version.provenance);
    expect(viralAdoptedAnalysisText(confirmed)).toContain("用户确认沿用原稿");
    expect(viralAdoptedAnalysisText(confirmed)).toContain("原视频.mp4");
});

test("sampling and transcription invalidate only an adopted sample result and preserve native adoption", () => {
    const draft = { ...referenceDraft(), viralUseTranscript: true };
    for (const mode of ["video", "frames"] as const) {
        const version = { text: "已采用的分析", provenance: viralAnalysisProvenance(draft, mode, config) };
        const adopted = { ...draft, ...viralAdoptAnalysis(draft, version) };
        const countChanged = { ...adopted, frameCount: 12 };
        const textChanged = { ...adopted, transcript: "新转写文字" };
        expect(Boolean(viralAdoptedAnalysisError(countChanged))).toBe(mode === "frames");
        expect(Boolean(viralAdoptedAnalysisError(textChanged))).toBe(mode === "frames");
        expect(viralAdoptedAnalysisError({ ...adopted, viralFacts: "新商品资料", script: "新脚本" })).toBe("");
    }
});

test("input snapshots persist both results, pending suggestions, adoption and transcript choice", () => {
    const draft = { ...referenceDraft(), viralUseTranscript: true };
    const video = { text: "视频原稿", provenance: viralAnalysisProvenance(draft, "video", config) };
    const frames = { text: "抽样原稿", provenance: viralAnalysisProvenance(draft, "frames", config), suggestion: { text: "抽样新建议", provenance: viralAnalysisProvenance(draft, "frames", config) } };
    const adopted = { ...draft, viralAnalyses: { video, frames }, ...viralAdoptAnalysis(draft, video), viralAnalysisMode: "frames" as const };
    const restored = { ...emptyVideoDraft("viral-recreate"), ...JSON.parse(JSON.stringify(viralInput(adopted, config))) };
    expect(restored.viralAnalyses).toEqual(adopted.viralAnalyses);
    expect(restored.viralAdoptedAnalysis).toEqual(adopted.viralAdoptedAnalysis);
    expect(restored.viralUseTranscript).toBe(true);
    expect(restored.viralAnalysisMode).toBe("frames");
    expect(viralAdoptedAnalysisError(restored)).toBe("");
    expect(viralAdoptedAnalysisText(restored)).not.toContain(frames.text);
});

test("unattributed body requires explicit adoption, while a script without reference analysis stays usable", () => {
    const draft = { ...referenceDraft(), analysis: "保留的参考原稿" };
    expect(viralAdoptedAnalysisError(draft)).toContain("确认采用");
    const manual = { text: draft.analysis, provenance: viralAnalysisProvenance(draft, "frames") };
    const adopted = { ...draft, ...viralAdoptAnalysis(draft, manual) };
    expect(viralAdoptedAnalysisError(adopted)).toBe("");
    expect(viralAdoptedAnalysisText(adopted)).toContain("手写");
    expect(viralVideoPrompt({ ...emptyVideoDraft("viral-recreate"), script: "直接手写脚本" }, defaultConfig)).toContain("直接手写脚本");
});
