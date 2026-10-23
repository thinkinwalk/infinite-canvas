import { isWan30, videoProfile } from "@/lib/video-capabilities";
import { modelOptionLabel, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

export type SegmentPart = { start: number; end: number; boundary: "scene" | "silence" | "duration" | "end" | "manual"; name: string; selected: boolean; savedClipId?: string };
export type SegmentPlan = {
    sourceId: string; workerUrl: string; model: string; minSeconds: number; maxSeconds: number; targetSeconds: number;
    duration: number; sceneCount: number; pauseCount: number; parts: SegmentPart[];
};

export function segmentationModels(config: AiConfig) {
    return selectableModelsByCapability(config, "video").flatMap((model) => {
        const profile = videoProfile(config, model);
        const min = Math.max(1, profile.referenceVideoMinSeconds || (isWan30(model) ? 1 : 0));
        const max = Math.min(30, profile.referenceVideoMaxSeconds || (isWan30(model) ? 30 : 0));
        return profile.maxVideos > 0 && max >= min && profile.interface !== "unavailable"
            ? [{ value: model, label: modelOptionLabel(config, model), min, max }] : [];
    });
}

export function segmentPlanError(plan: Pick<SegmentPlan, "duration" | "minSeconds" | "maxSeconds" | "parts">) {
    if (!Number.isFinite(plan.duration) || plan.duration <= 0 || !plan.parts.length) return "分段方案为空或视频时长无效，请重新分析";
    if (![plan.minSeconds, plan.maxSeconds].every(Number.isFinite) || plan.minSeconds < 1 || plan.maxSeconds > 30 || plan.minSeconds > plan.maxSeconds) return "分段时长规格无效";
    let previous = 0;
    for (const [index, part] of plan.parts.entries()) {
        const span = Math.round(part.end * 1000) - Math.round(part.start * 1000);
        if (![part.start, part.end].every(Number.isFinite) || Math.abs(part.start - previous) > 0.00001 || span < Math.ceil(plan.minSeconds * 1000) || span > Math.floor(plan.maxSeconds * 1000)) return `第 ${index + 1} 段超出时长范围或与相邻片段不连续`;
        if (!part.name.trim()) return `请填写第 ${index + 1} 段的名称`;
        previous = part.end;
    }
    return Math.abs(previous - plan.duration) > 0.00001 ? "分段未完整覆盖原视频，请重新分析" : "";
}

export function moveSegmentBoundary(plan: SegmentPlan, index: number, end: number): SegmentPlan {
    const parts = plan.parts.map((part) => ({ ...part }));
    if (!parts[index] || !parts[index + 1] || parts[index].savedClipId || parts[index + 1].savedClipId) throw new Error("已保存的相邻片段不能调整，请重新分析");
    parts[index].end = end;
    parts[index].boundary = "manual";
    parts[index + 1].start = end;
    const next = { ...plan, parts };
    const error = segmentPlanError(next);
    if (error) throw new Error(error);
    return next;
}

export function splitOrMergeSegment(plan: SegmentPlan, index: number, merge = false): SegmentPlan {
    const part = plan.parts[index];
    const adjacent = plan.parts[index + 1];
    if (!part || part.savedClipId || merge && (!adjacent || adjacent.savedClipId)) throw new Error("已保存的片段不能拆分或合并，请重新分析");
    const parts = plan.parts.map((item) => ({ ...item }));
    if (merge) parts.splice(index, 2, { ...part, end: adjacent.end, boundary: adjacent.boundary });
    else {
        const middle = Math.round((part.start + part.end) * 500) / 1000;
        parts.splice(index, 1, { ...part, end: middle, boundary: "manual" }, { ...part, start: middle, name: `${part.name} · 2` });
    }
    const next = { ...plan, parts };
    const error = segmentPlanError(next);
    if (error) throw new Error(error);
    return next;
}
