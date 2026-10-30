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
const { viralInitialScript, viralScriptProposal, viralResolveScript, viralRestoreScript } = await import("../src/pages/video-tool/viral-script-revisions");
const { viralScriptPrompt, viralInput } = await import("../src/pages/video-tool/viral-recreate-request");
const { viralVideoPrompt } = await import("../src/pages/video-tool/viral-recreate-request");
const { viralKeyframePrompt } = await import("../src/pages/video-tool/viral-keyframe");
const { defaultConfig } = await import("../src/stores/use-config-store");
const { viralAdoptAnalysis, viralAnalysisProvenance } = await import("../src/pages/video-tool/viral-analysis");
const draft = () => {
    const d = { ...emptyVideoDraft("viral-recreate"), viralTaskId: "script-task" };
    return { ...d, ...viralAdoptAnalysis(d, { text: "0–3 秒：原片开头。\n3–6 秒：原片结尾。", provenance: viralAnalysisProvenance(d, "video") }) };
};

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
    expect(prompt).toContain("第一版已采用稿");
    expect(prompt).toContain("再短一些，只改第二段");
    expect(prompt).toContain("未要求修改的镜头、台词和顺序保持");
    expect(prompt).not.toContain("不应生效的要求");
    expect(prompt).not.toContain("不应带回的建议");
    const otherVideo = { ...kept, analysis: "", media: [{ id: "other", kind: "video" as const, role: "reference" as const, storageKey: "other", url: "blob:other", name: "另一原片.mp4", mimeType: "video/mp4", bytes: 1 }] };
    expect(viralScriptPrompt(otherVideo, defaultConfig, "改开头")).not.toContain("第一版已采用稿");
});

test("task input snapshots retain conversation and unfinished composer text", () => {
    const d = { ...draft(), ...viralScriptProposal(draft(), "首版稿", "撰写脚本"), viralScriptChatInput: "未发送的要求" };
    const input = viralInput(d, defaultConfig);
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
