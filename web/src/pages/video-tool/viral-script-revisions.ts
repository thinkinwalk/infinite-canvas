import type { VideoDraft, ViralScriptTurn } from "@/types/video-workbench";
import { viralAdoptedAnalysisError, viralSource } from "./viral-analysis";
import { viralVisibleAnalysis } from "./viral-evidence";

export function viralInitialScript(draft: VideoDraft): Partial<VideoDraft> {
    if (draft.viralScriptSeeded || draft.script.trim() || draft.viralScriptSuggestion || !draft.analysis.trim() || viralAdoptedAnalysisError(draft)) return {};
    return { script: viralVisibleAnalysis(draft.analysis), viralScriptSeeded: true, viralScriptStale: true };
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
