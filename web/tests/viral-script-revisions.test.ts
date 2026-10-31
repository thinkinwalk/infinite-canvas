import { expect, test } from "bun:test";
import { emptyVideoDraft } from "../src/types/video-workbench";

if (!globalThis.localStorage) {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    } });
}
const { applyViralScriptEdits, viralInitialScript, viralScriptEditDraft, viralScriptProposal, viralResolveScript, viralRestoreScript, viralScriptRequestError, viralScriptChangeSummary } = await import("../src/pages/video-tool/viral-script-revisions");
const { viralScriptPrompt, viralInput } = await import("../src/pages/video-tool/viral-recreate-request");
const { viralSettingsRequireScriptReview, viralVideoPrompt } = await import("../src/pages/video-tool/viral-recreate-request");
const { viralKeyframePrompt } = await import("../src/pages/video-tool/viral-keyframe");
const { defaultConfig } = await import("../src/stores/use-config-store");
const { storeVideoSettings } = await import("../src/pages/video-tool/store-explore-request");
const { viralAdoptAnalysis, viralAnalysisProvenance } = await import("../src/pages/video-tool/viral-analysis");
const draft = () => {
    const d = { ...emptyVideoDraft("viral-recreate"), viralTaskId: "script-task" };
    return { ...d, ...viralAdoptAnalysis(d, { text: "0–3 秒：原片开头。\n3–6 秒：原片结尾。", provenance: viralAnalysisProvenance(d, "video") }) };
};

test("changing only the video model keeps the script; timing and aspect-ratio changes require review", () => {
    const settings = storeVideoSettings(defaultConfig);
    expect(viralSettingsRequireScriptReview(settings, { ...settings, videoModel: "another-model" })).toBe(false);
    expect(viralSettingsRequireScriptReview(settings, { ...settings, vquality: "1080" })).toBe(false);
    expect(viralSettingsRequireScriptReview(settings, { ...settings, videoSeconds: settings.videoSeconds + 1 })).toBe(true);
    expect(viralSettingsRequireScriptReview(settings, { ...settings, size: "720x1280" })).toBe(true);
});

test("initial extracted text is visible without billing and never replaces manual or deliberately cleared text", () => {
    const d = draft(), initial = viralInitialScript(d);
    expect(initial.script).toBe(d.analysis);
    expect(initial.viralScriptStale).toBe(true);
    expect(viralInitialScript({ ...d, script: "手写稿" })).toEqual({});
    expect(viralInitialScript({ ...d, viralScriptSeeded: true })).toEqual({});
    expect(viralInitialScript({ ...d, viralScriptSuggestion: "待采用稿" })).toEqual({});
    expect(viralInitialScript({ ...d, analysis: "" })).toEqual({});
});

test("a conversation response preserves the current script until accepted", () => {
    const d = { ...draft(), script: "当前人工稿", viralScriptChatInput: "只改开头" };
    const proposed = { ...d, ...viralScriptProposal(d, "修改后的完整脚本", "只改开头") };
    expect(proposed.script).toBe("当前人工稿");
    expect(proposed.viralScriptSuggestion).toBe("修改后的完整脚本");
    expect(proposed.viralScriptSuggestionBase).toBe("当前人工稿");
    expect(proposed.viralScriptChatInput).toBe("");
    expect(proposed.viralScriptTurns?.[0].status).toBe("pending");
    const adopted = { ...proposed, ...viralResolveScript(proposed, true) };
    expect(adopted.script).toBe("修改后的完整脚本");
    expect(adopted.viralScriptSuggestion).toBe("");
    expect(adopted.viralScriptStale).toBe(false);
    expect(adopted.viralScriptTurns?.[0].status).toBe("accepted");
});

test("keeping the current draft rejects the proposal and retains manual changes", () => {
    const d = { ...draft(), script: "原稿" };
    const proposed = { ...d, ...viralScriptProposal(d, "建议稿", "换开头"), script: "建议返回后的人工编辑" };
    const kept = { ...proposed, ...viralResolveScript(proposed, false) };
    expect(kept.script).toBe("建议返回后的人工编辑");
    expect(kept.viralScriptSuggestion).toBe("");
    expect(kept.viralScriptTurns?.[0].status).toBe("rejected");
});

test("continued edits use the pending result and apply the accumulated changes only once", () => {
    const d = { ...draft(), script: "旧开头。\n\n保留中段。\n\n旧结尾。" };
    const first = { ...d, ...viralScriptProposal(d, d.script.replace("旧开头", "新开头"), "只改开头") };
    const prompt = viralScriptPrompt(first, defaultConfig, "再改结尾");
    expect(prompt).toContain("新开头");
    expect(prompt).not.toContain("旧开头");
    expect(prompt).toContain("尚未应用");
    expect(prompt).toContain("只改开头");
    const finalText = applyViralScriptEdits(viralScriptEditDraft(first).script, '{"edits":[{"segment":3,"before":"旧结尾","after":"新结尾"}]}');
    const second = { ...first, ...viralScriptProposal(first, finalText, "再改结尾") };
    expect(second.script).toBe(d.script);
    expect(second.viralScriptSuggestion).toBe("新开头。\n\n保留中段。\n\n新结尾。");
    expect(second.viralScriptSuggestionBase).toBe(d.script);
    expect(second.viralScriptTurns?.map((turn) => turn.status)).toEqual(["superseded", "pending"]);
    expect(second.viralScriptTurns?.[1].before).toBe(first.viralScriptSuggestion);
    const accepted = { ...second, ...viralResolveScript(second, true) };
    expect(accepted.script).toBe(finalText);
    expect(accepted.viralScriptSuggestion).toBe("");
    expect(accepted.viralScriptTurns?.[1].before).toBe(d.script);
    expect(accepted.viralScriptTurns?.[1].status).toBe("accepted");
});

test("continuing after manual edits retains the original comparison base and restores the overwritten text", () => {
    const d = { ...draft(), script: "最初底稿" };
    const first = { ...d, ...viralScriptProposal(d, "第一次修改", "第一轮要求"), script: "期间手写稿" };
    const second = { ...first, ...viralScriptProposal(first, "第二次修改", "第二轮要求") };
    expect(second.viralScriptSuggestionBase).toBe("最初底稿");
    expect(viralScriptEditDraft(second).script).toBe("第二次修改");
    const accepted = { ...second, ...viralResolveScript(second, true) };
    expect(accepted.viralScriptTurns?.at(-1)?.before).toBe("期间手写稿");
    const rejected = { ...second, ...viralResolveScript(second, false) };
    expect(rejected.script).toBe("期间手写稿");
    expect(rejected.viralScriptTurns?.at(-1)?.after).toBe("第二次修改");
    const prompt = viralScriptPrompt(rejected, defaultConfig, "重新改写");
    expect(prompt).toContain("期间手写稿");
    expect(prompt).not.toContain("第一次修改");
    expect(prompt).not.toContain("第二轮要求");
});

test("watermark edits validate the pending result and a cleared current draft can still be refined", () => {
    const d = { ...draft(), script: "人物转身。" };
    const first = { ...d, ...viralScriptProposal(d, "人物转身。左上角显示水印。", "加入画面说明") };
    expect(viralScriptRequestError(first, "删除水印描述")).toBe("");
    const cleared = { ...first, script: "" };
    const refined = { ...cleared, ...viralScriptProposal(cleared, "人物站立。", "改为站立") };
    expect(refined.script).toBe("");
    expect(refined.viralScriptSuggestion).toBe("人物站立。");
    expect(refined.viralScriptTurns?.at(-1)?.status).toBe("pending");
    expect(viralScriptPrompt(cleared, defaultConfig, "改为站立")).toContain("人物转身。左上角显示水印。");
});

test("adopting after further manual edits backs up the actual overwritten draft", () => {
    const d = { ...draft(), script: "生成建议前的稿" };
    const proposed = { ...d, ...viralScriptProposal(d, "AI 建议稿", "缩短结尾"), script: "建议返回后的手写稿" };
    const accepted = { ...proposed, ...viralResolveScript(proposed, true) };
    expect(accepted.viralScriptTurns?.[0].before).toBe("建议返回后的手写稿");
    const restored = { ...accepted, ...viralRestoreScript(accepted, accepted.viralScriptTurns![0].before, "恢复修改前") };
    expect(restored.script).toBe("建议返回后的手写稿");
    expect(restored.viralScriptTurns?.[1].before).toBe("AI 建议稿");
});

test("the first AI script without an existing draft becomes the current version", () => {
    const value = viralScriptProposal(draft(), "首版脚本", "撰写口播");
    expect(value.script).toBe("首版脚本");
    expect(value.viralScriptTurns?.[0].status).toBe("accepted");
    expect(value.viralScriptSuggestion).toBeUndefined();
});

test("multi-turn prompts use latest manual text and only adopted versions from this video", () => {
    const d = { ...draft(), script: "最新人工编辑", instructions: "保留自然语气" };
    const proposed = { ...d, ...viralScriptProposal(d, "第一版已采用稿", "加强开头") };
    const adopted = { ...proposed, ...viralResolveScript(proposed, true), script: "最新人工编辑" };
    const rejected = { ...adopted, ...viralScriptProposal(adopted, "不应带回的建议", "不应生效的要求") };
    const kept = { ...rejected, ...viralResolveScript(rejected, false) };
    const prompt = viralScriptPrompt(kept, defaultConfig, "再短一些，只改第二段");
    expect(prompt).toContain("最新人工编辑");
    expect(prompt).toContain("加强开头");
    expect(prompt).toContain("再短一些，只改第二段");
    expect(prompt).toContain("未修改的段落必须由应用原样保留");
    expect(prompt).toContain('"segment":1');
    expect(prompt).not.toContain("按此规格重排内容与节奏");
    expect(prompt).not.toContain("第一版已采用稿");
    expect(prompt).not.toContain("不应生效的要求");
    expect(prompt).not.toContain("不应带回的建议");
    const otherVideo = { ...kept, analysis: "", media: [{ id: "other", kind: "video" as const, role: "reference" as const, storageKey: "other", url: "blob:other", name: "另一原片.mp4", mimeType: "video/mp4", bytes: 1 }] };
    expect(viralScriptPrompt(otherVideo, defaultConfig, "改开头")).not.toContain("第一版已采用稿");
});

test("scoped edits preserve every untouched character and reject full-script rewrites", () => {
    const opening = "甲".repeat(450);
    const ending = "保留结尾台词。" + "乙".repeat(540);
    const source = `${opening}\n\n${ending}`;
    expect(Array.from(source).length).toBe(999);
    const edited = applyViralScriptEdits(source, JSON.stringify({ edits: [{ segment: 2, before: "结尾台词", after: "最后一句" }] }));
    expect(edited).toBe(source.replace("结尾台词", "最后一句"));
    expect(() => applyViralScriptEdits(source, "重写后的整份短脚本")).toThrow("原稿未改动");
    expect(() => applyViralScriptEdits(source, JSON.stringify({ edits: [{ segment: 9, before: "结尾台词", after: "越界段落" }] }))).toThrow("未能对应");
    expect(() => applyViralScriptEdits(source, JSON.stringify({ edits: [{ segment: 1, text: "旧格式整段替换" }] }))).toThrow("未能对应");
});

test("exact patches handle deletions, repeated phrases, overlapping edits and CRLF without changing surrounding text", () => {
    const source = "00:00｜人物转身，左上角有水印。镜头保持。\r\n\r\n00:03｜保留声音。";
    expect(applyViralScriptEdits(source, JSON.stringify({ edits: [{ segment: 1, before: "左上角有水印。", after: "" }] })))
        .toBe("00:00｜人物转身，镜头保持。\r\n\r\n00:03｜保留声音。");
    expect(() => applyViralScriptEdits("转身转身", JSON.stringify({ edits: [{ segment: 1, before: "转身", after: "站立" }] }))).toThrow("唯一对应");
    expect(() => applyViralScriptEdits(source, JSON.stringify({ edits: [
        { segment: 1, before: "人物转身", after: "人物站立" }, { segment: 1, before: "转身，", after: "抬手，" },
    ] }))).toThrow("重叠");
    expect(() => applyViralScriptEdits(source, '{"edits":[]}')).toThrow("没有提出");
    expect(() => applyViralScriptEdits("完整脚本", '{"edits":[{"segment":1,"before":"完整脚本","after":""}]}')).toThrow("清空");
    expect(applyViralScriptEdits("原句。", '```json\n{"edits":[{"segment":1,"before":"原句。","after":"原句。不要新增水印。"}]}\n```')).toBe("原句。不要新增水印。");
});

test("watermark guidance distinguishes existing-frame removal from generation and script edits", () => {
    const current = { ...draft(), script: "人物转身，裙摆展开。" };
    expect(viralScriptRequestError(current, "去掉左上角和右下角的水印")).toContain("不能擦除视频画面中的水印");
    expect(viralScriptRequestError({ ...current, script: "甲".repeat(999) }, "去掉左上角和右下角的水印")).toContain("不能擦除");
    expect(viralScriptRequestError(current, "删除脚本中的水印描述")).toContain("没有水印描述");
    expect(viralScriptRequestError({ ...current, script: "右上角显示水印。" }, "删除水印描述")).toBe("");
    expect(viralScriptRequestError(current, "脚本中补充生成时不要水印")).toBe("");
    expect(viralScriptRequestError(current, "不要新增水印")).toBe("");
    expect(viralScriptRequestError(current, "只改开头")).toBe("");
});

test("whole-script rewriting is explicitly selected and character summaries include Unicode", () => {
    const d = { ...draft(), script: "当前脚本" };
    const local = viralScriptPrompt(d, defaultConfig, "全文不要变，只改开头");
    expect(local).toContain('"before"');
    expect(local).toContain("最小原文片段");
    const rewrite = viralScriptPrompt(d, defaultConfig, "重新调整节奏", "rewrite");
    expect(rewrite).toContain("用户已明确选择整稿改写");
    expect(rewrite).not.toContain("只返回 JSON");
    expect(viralScriptPrompt(d, defaultConfig)).toContain("按此规格重排内容与节奏");
    expect(viralScriptChangeSummary("甲".repeat(999), "乙".repeat(481))).toBe("999 → 481 字（减少 518 字，52%）");
    expect(viralScriptChangeSummary("😀甲", "甲")).toBe("2 → 1 字（减少 1 字，50%）");
});

test("task input snapshots retain pending edits, comparison base, conversation and unfinished composer text", () => {
    const current = { ...draft(), script: "当前脚本" };
    const d = { ...current, ...viralScriptProposal(current, "尚未应用的修改", "修改开头"), viralScriptChatInput: "未发送的要求" };
    const input = viralInput(d, defaultConfig);
    expect(input.script).toBe("当前脚本");
    expect(input.viralScriptSuggestion).toBe("尚未应用的修改");
    expect(input.viralScriptSuggestionBase).toBe("当前脚本");
    expect(input.viralScriptTurns).toEqual(d.viralScriptTurns);
    expect(input.viralScriptChatInput).toBe("未发送的要求");
});

test("video and keyframe generation honor the confirmed script instead of restoring removed content", () => {
    const d = { ...draft(), script: "原片中的旧内容" };
    const proposed = { ...d, ...viralScriptProposal(d, "确认稿：仅保留产品特写，不要口播", "去掉人物和口播") };
    const accepted = { ...proposed, ...viralResolveScript(proposed, true) };
    for (const prompt of [viralVideoPrompt(accepted, defaultConfig), viralKeyframePrompt(accepted)]) {
        expect(prompt).toContain("最终画面、台词与顺序以当前脚本为准");
        expect(prompt).toContain("不得按旧分析或要点把当前稿中已删除、替换的内容自动补回");
        expect(prompt).toContain("确认稿：仅保留产品特写，不要口播");
    }
});
