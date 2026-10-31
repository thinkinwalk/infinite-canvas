import type { VideoDraft, ViralScriptTurn } from "@/types/video-workbench";
import { viralAdoptedAnalysisError, viralSource } from "./viral-analysis";
import { viralVisibleAnalysis } from "./viral-evidence";

export type ViralScriptEditMode = "local" | "rewrite";

export function viralInitialScript(draft: VideoDraft): Partial<VideoDraft> {
    if (draft.viralScriptSeeded || draft.script.trim() || draft.viralScriptSuggestion || !draft.analysis.trim() || viralAdoptedAnalysisError(draft)) return {};
    return { script: viralVisibleAnalysis(draft.analysis), viralScriptSeeded: true, viralScriptStale: true };
}

export function splitViralScript(script: string) {
    const parts = script.split(/(\r?\n(?:[ \t]*\r?\n)*)/);
    return { segments: parts.filter((_, index) => index % 2 === 0), separators: parts.filter((_, index) => index % 2 === 1) };
}

export function applyViralScriptEdits(script: string, response: string) {
    const json = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new Error("脚本修改建议格式无法识别；原稿未改动，请重试");
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { edits?: unknown }).edits)) {
        throw new Error("脚本修改建议缺少有效的分段编辑；原稿未改动，请重试");
    }
    const { segments, separators } = splitViralScript(script);
    const replacements = new Map<number, { start: number; end: number; text: string }[]>();
    for (const item of (parsed as { edits: unknown[] }).edits) {
        if (!item || typeof item !== "object") throw new Error("脚本修改建议无效；原稿未改动，请重试");
        const { segment, before, after } = item as { segment?: unknown; before?: unknown; after?: unknown };
        if (typeof segment !== "number" || !Number.isInteger(segment) || segment < 1 || segment > segments.length || typeof before !== "string" || !before.trim() || typeof after !== "string") {
            throw new Error("脚本修改建议未能对应原稿段落；原稿未改动，请重试");
        }
        const source = segments[segment - 1], start = source.indexOf(before);
        if (start < 0 || source.indexOf(before, start + 1) >= 0) throw new Error("脚本修改片段无法唯一对应原文；原稿未改动");
        const edits = replacements.get(segment) || [];
        const end = start + before.length;
        if (edits.some((edit) => start < edit.end && end > edit.start)) throw new Error("脚本修改片段重复或重叠；原稿未改动");
        edits.push({ start, end, text: after });
        replacements.set(segment, edits);
    }
    if (!replacements.size) throw new Error("模型没有提出可应用的脚本修改；原稿未改动");
    const result = segments.map((segment, index) => {
        for (const edit of (replacements.get(index + 1) || []).sort((a, b) => b.start - a.start)) {
            segment = segment.slice(0, edit.start) + edit.text + segment.slice(edit.end);
        }
        return segment + (separators[index] || "");
    }).join("");
    if (result === script) throw new Error("模型没有提出可应用的脚本修改；原稿未改动");
    if (!result.trim()) throw new Error("修改建议会清空整份脚本；原稿未改动");
    return result;
}

export function viralScriptRequestError(draft: VideoDraft, request: string) {
    if (!/(水印|watermark)/i.test(request)) return "";
    const removal = /去掉|去除|移除|删除|擦除|消除|抹掉|remove|erase/i.test(request);
    const generationConstraint = /生成|新增|添加|补充|不要|不加|不出现|禁止|without|no watermark/i.test(request);
    if (removal && !generationConstraint && !/(水印|watermark)/i.test(draft.script)) {
        return "当前脚本没有水印描述可修改；脚本对话不能擦除视频画面中的水印。请使用支持区域擦除的视频编辑功能，或在脚本中明确后续生成不出现水印。";
    }
    return "";
}

export function viralScriptChangeSummary(before: string, after: string) {
    const beforeLength = Array.from(before).length, afterLength = Array.from(after).length, change = afterLength - beforeLength;
    return `${beforeLength} → ${afterLength} 字（${change < 0 ? "减少" : "增加"} ${Math.abs(change)} 字${beforeLength ? `，${Math.round(Math.abs(change) / beforeLength * 100)}%` : ""}）`;
}

export function viralScriptProposal(draft: VideoDraft, after: string, request?: string): Partial<VideoDraft> {
    const turn: ViralScriptTurn = {
        id: crypto.randomUUID(), source: viralSource(draft), request: request || (draft.script.trim() ? "根据复刻要求修改脚本" : "撰写改编脚本"),
        before: draft.script, beforeStale: Boolean(draft.viralScriptStale), after, status: draft.script.trim() ? "pending" : "accepted", createdAt: Date.now(),
    };
    return {
        viralScriptTurns: [...(draft.viralScriptTurns || []).map((item) => item.status === "pending" ? { ...item, status: "rejected" as const } : item), turn],
        ...(request ? { viralScriptChatInput: "" } : {}),
        ...(draft.script.trim() ? { viralScriptSuggestion: after, viralScriptSuggestionBase: draft.script } : { script: after, viralScriptStale: false, viralOutputStale: true }),
    };
}

export function viralResolveScript(draft: VideoDraft, accepted: boolean): Partial<VideoDraft> {
    if (!draft.viralScriptSuggestion) return {};
    const turns = draft.viralScriptTurns || [];
    return {
        ...(accepted ? { script: draft.viralScriptSuggestion, viralScriptStale: false, viralOutputStale: true } : {}),
        viralScriptSuggestion: "", viralScriptSuggestionBase: undefined,
        viralScriptTurns: [
            ...turns.map((turn) => turn.status === "pending" ? { ...turn, status: accepted ? "accepted" as const : "rejected" as const, before: accepted ? draft.script : turn.before, beforeStale: accepted ? Boolean(draft.viralScriptStale) : turn.beforeStale } : turn),
            ...(accepted && !turns.some((turn) => turn.status === "pending") ? [{
                id: crypto.randomUUID(), source: viralSource(draft), request: "采用脚本建议", before: draft.script,
                beforeStale: Boolean(draft.viralScriptStale), after: draft.viralScriptSuggestion, status: "accepted" as const, createdAt: Date.now(),
            }] : []),
        ],
    };
}

export function viralRestoreScript(draft: VideoDraft, script: string, request: string): Partial<VideoDraft> {
    return {
        script, viralScriptStale: false, viralOutputStale: true, viralScriptSuggestion: "", viralScriptSuggestionBase: undefined,
        viralScriptTurns: [
            ...(draft.viralScriptTurns || []).map((turn) => turn.status === "pending" ? { ...turn, status: "rejected" as const } : turn),
            { id: crypto.randomUUID(), source: viralSource(draft), request, before: draft.script, beforeStale: Boolean(draft.viralScriptStale), after: script, status: "accepted", createdAt: Date.now() },
        ],
    };
}

export function viralScriptAuthority(draft: VideoDraft) {
    return draft.viralScriptTurns?.some((turn) => turn.source === viralSource(draft) && (turn.status === "accepted" || turn.status === "reverted"))
        ? "当前脚本已经用户通过对话采用、手动调整或恢复版本，最终画面、台词与顺序以当前脚本为准。原片分析只用于解释保留下来的内容，不得按旧分析或要点把当前稿中已删除、替换的内容自动补回；未采用、已拒绝或撤销的建议不执行。"
        : "";
}
