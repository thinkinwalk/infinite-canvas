import { expect, test } from "bun:test";
import type { ViralAnalysisFact } from "../src/pages/video-tool/viral-evidence";
import { viralAnalysisBody, viralAnalysisEditText, viralEvidence, viralExecutionAnalysis, viralFrameLabel, viralSupportedFacts } from "../src/pages/video-tool/viral-evidence";
import { emptyVideoDraft } from "../src/types/video-workbench";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } });
}
const { defaultConfig } = await import("../src/stores/use-config-store");
const { viralAdoptAnalysis, viralAnalysisProvenance, viralAnalysisResultPatch, viralEditAnalysis, viralSource, viralAdoptedAnalysisError } = await import("../src/pages/video-tool/viral-analysis");
const { viralEffectCandidates, viralPlanEffects } = await import("../src/pages/video-tool/viral-plan");
const { viralScriptPrompt, viralVideoPrompt } = await import("../src/pages/video-tool/viral-recreate-request");
const { viralKeyframePrompt } = await import("../src/pages/video-tool/viral-keyframe");
const fact = (id: string, patch: Partial<ViralAnalysisFact> = {}): ViralAnalysisFact => ({
    id, kind: "event", subject: "裙摆A", description: "裙摆向上展开，仍与裙身连续连接",
    time: "00:00.8–00:02.2（估计）", evidence: ["抽样画面2、3"], status: "observed", source: "visual", ...patch,
});
const document = (...facts: ViralAnalysisFact[]) => `原始说明：可能变成独立折扇。\n\`\`\`json\n${JSON.stringify({ analysisFacts: facts })}\n\`\`\``;
const draft = () => {
    const d = emptyVideoDraft("viral-recreate");
    d.media = [{ id: "video-a", name: "原片.mp4", kind: "video", role: "reference", url: "blob:video", storageKey: "video-a", mimeType: "video/mp4", bytes: 1 }];
    return d;
};

test("uncertain identity changes never become keep effects or execution facts, but observed real transformations remain", () => {
    const text = document(fact("cloth"), fact("guess", { description: "长裙变成独立折扇", status: "uncertain" }));
    const d = { ...draft(), analysis: text };
    expect(viralEffectCandidates(text).map((e) => e.description)).toEqual(["裙摆向上展开，仍与裙身连续连接"]);
    expect(viralPlanEffects(d)).toHaveLength(1);
    expect(viralExecutionAnalysis(d)).not.toContain("独立折扇");
    expect(viralExecutionAnalysis(d)).toContain("尚未经独立视觉核验");
    const real = document(fact("real", { description: "画面中布裙确实变为金属道具" }));
    expect(viralEffectCandidates(real)[0].description).toContain("变为金属道具");
});

test("text facts require a carrier and preserve two separate surfaces with the same text", () => {
    const onCloth = fact("cloth-text", { kind: "text", description: "金色西安二字随布面起伏", surface: "裙摆A上部布面" });
    const onBuilding = fact("building-text", { kind: "text", subject: "建筑B", description: "红色西安标识固定", surface: "建筑B屋顶" });
    expect(viralEvidence(document(onCloth, onBuilding)).state).toBe("valid");
    const prompt = viralExecutionAnalysis({ ...draft(), analysis: document(onCloth, onBuilding) });
    expect(prompt).toContain("裙摆A上部布面");
    expect(prompt).toContain("建筑B屋顶");
    expect(viralEvidence(document({ ...onCloth, surface: "" })).state).toBe("invalid");
});

test("sampled frames cannot supply heard audio; selected transcript remains separately attributed", () => {
    const d = { ...draft(), viralAnalysisMode: "frames" as const };
    const version = { text: document(fact("visual"), fact("audio", { source: "audio", kind: "audio", description: "鼓点重拍" }),
        fact("transcript", { source: "transcript", kind: "audio", description: "转写歌词" })), provenance: viralAnalysisProvenance(d, "frames") };
    const adopted = { ...d, ...viralAdoptAnalysis(d, version) };
    expect(viralSupportedFacts(adopted).map((f) => f.id)).toEqual(["visual"]);
    const withTranscript = { ...adopted, viralAdoptedAnalysis: { ...adopted.viralAdoptedAnalysis!, provenance: { ...version.provenance, usesTranscript: true } } };
    expect(viralSupportedFacts(withTranscript).map((f) => f.id)).toEqual(["visual", "transcript"]);
    expect(viralPlanEffects(withTranscript)).toHaveLength(1);
});

test("invalid, duplicate and incomplete records cannot silently fall back to narrative generation", () => {
    const malformed = [
        '正文\n```json\n{"analysisFacts":[\n```',
        '正文\n```json\n{"analysisFacts":[]}',
        document(fact("same"), fact("same")),
        document(fact("empty", { evidence: [] })),
        `${document(fact("one"))}\n${document(fact("two"))}`,
    ];
    for (const analysis of malformed) {
        expect(viralEvidence(analysis).state).toBe("invalid");
        expect(viralEffectCandidates(analysis)).toEqual([]);
        expect(() => viralExecutionAnalysis({ ...draft(), analysis })).toThrow("观察记录不完整");
    }
    expect(viralEvidence("人工填写的镜头结构").state).toBe("none");
    expect(viralExecutionAnalysis({ ...draft(), analysis: "人工填写的镜头结构" })).toBe("人工填写的镜头结构");
});

test("editing prose removes unchanged automatic appendices so corrected names cannot conflict with old effects", () => {
    const previous = document(fact("old", { description: "长裙变为独立折扇" }));
    const corrected = previous.replace("原始说明：可能变成独立折扇。", "人工纠正：裙摆呈扇面状展开。");
    expect(viralAnalysisEditText(previous, corrected)).toBe("人工纠正：裙摆呈扇面状展开。");
    const oldEffects = '原文\n```json\n{"recreationEffects":[{"time":"1秒","description":"独立折扇"}]}\n```';
    expect(viralAnalysisEditText(oldEffects, oldEffects.replace("原文", "修正裙摆"))).toBe("修正裙摆");
    const editedRecords = document(fact("old", { description: "裙摆仍与裙身连接" }));
    expect(viralAnalysisEditText(previous, editedRecords)).toBe(editedRecords);
    expect(viralAnalysisBody(editedRecords)).toBe("原始说明：可能变成独立折扇。");
});

test("editing adopted evidence preserves script body, invalidates suggestions and both frame confirmations", () => {
    const d = { ...draft(), script: "旧脚本", viralScriptSuggestion: "旧建议" };
    const version = { text: document(fact("old")), provenance: viralAnalysisProvenance(d, "video") };
    const adopted = { ...d, ...viralAdoptAnalysis(d, version), viralKeyframe: { id: "opening", inputKey: "old", confirmed: true }, viralClimax: { id: "ending", inputKey: "old", confirmed: true } };
    const result = { ...adopted, ...viralEditAnalysis(adopted, version, "修正后的人工分析", true) };
    expect(result.script).toBe("旧脚本");
    expect(result.analysis).toBe("修正后的人工分析");
    expect(result.viralScriptStale).toBe(true);
    expect(result.viralScriptSuggestion).toBe("");
    expect(result.viralKeyframe?.confirmed).toBe(false);
    expect(result.viralClimax?.confirmed).toBe(false);
});

test("model review always remains a suggestion and malformed primary analysis never auto-adopts", () => {
    const d = draft(), original = { text: document(fact("original")), provenance: viralAnalysisProvenance(d, "video") };
    const adopted = { ...d, ...viralAdoptAnalysis(d, original), viralAnalyses: { video: original } };
    const reviewed = { text: document(fact("reviewed")), provenance: { ...original.provenance, createdAt: original.provenance.createdAt + 1, reviewOf: original.provenance.createdAt } };
    const patch = viralAnalysisResultPatch(adopted, reviewed, original);
    expect(patch.analysis).toBeUndefined();
    expect(patch.viralAnalyses?.video?.text).toBe(original.text);
    expect(patch.viralAnalyses?.video?.suggestion).toEqual(reviewed);
    const invalid = { ...reviewed, text: '```json\n{"analysisFacts":null}\n```' };
    expect(viralAnalysisResultPatch(d, invalid).analysis).toBeUndefined();
    expect(viralAdoptedAnalysisError({ ...d, ...viralAdoptAnalysis(d, invalid) })).toContain("观察记录不完整");
});

test("script, generation and keyframe prompts share observed identity and carrier without raw narrative guesses", () => {
    const d = draft(), version = { text: document(fact("cloth"), fact("text", { kind: "text", description: "金色西安", surface: "裙摆A上部" }),
        fact("guess", { description: "独立折扇", status: "uncertain" })), provenance: viralAnalysisProvenance(d, "video") };
    const adopted = { ...d, ...viralAdoptAnalysis(d, version), instructions: "只将裙摆上的字换成辉科胜邦", script: "裙摆开屏，字样随布面运动" };
    for (const prompt of [viralScriptPrompt(adopted, defaultConfig), viralVideoPrompt(adopted, defaultConfig), viralKeyframePrompt(adopted)]) {
        expect(prompt).toContain("裙摆A");
        expect(prompt).toContain("裙摆A上部");
        expect(prompt).not.toContain("原始说明");
        expect(prompt).not.toContain("独立折扇");
    }
    expect(viralSource(adopted)).toBe(viralSource(d));
});

test("frame labels distinguish estimated sample positions from unavailable timestamps", () => {
    const d = { ...draft(), viralFrameTimes: [0, 1.25, Number.NaN] };
    expect(viralFrameLabel(d, 0)).toBe("抽样画面1｜预计采样位置 0.00 秒");
    expect(viralFrameLabel(d, 1)).toContain("1.25 秒");
    expect(viralFrameLabel(d, 2)).toContain("时间未返回");
    expect(viralFrameLabel(d, 3)).toContain("时间未返回");
});
