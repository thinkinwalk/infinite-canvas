import type { StoreMaterialSuggestion, VideoDraft, WorkbenchMedia } from "@/types/video-workbench";

export const storeCandidateMaterials = (d: Pick<VideoDraft, "media">) => d.media.filter((m) => m.kind === "image" && ["reference", "model", "first-frame"].includes(m.role));
export const storeSelectedIds = (d: Pick<VideoDraft, "storeShots" | "storeReferenceIds">) => [...new Set(d.storeShots?.length ? d.storeShots.flatMap((s) => s.materialIds) : d.storeReferenceIds || [])];

// 素材被删除或替换后，方案里可能残留指向已不存在素材的编号。这里把所有引用点按剩余素材统一收口，
// 新增持有素材编号的字段时只改这里，不要在各个删除入口分别清理。
export function pruneStoreMediaReferences(d: VideoDraft, media: WorkbenchMedia[]): Partial<VideoDraft> {
    const kept = new Set(media.map((m) => m.id));
    const ids = (list: string[]) => list.filter((id) => kept.has(id));
    const keptFrame = (id: string) => (kept.has(id) ? id : undefined);
    const shots = (list: { materialIds: string[] }[]) => list.map((shot) => ({ ...shot, materialIds: ids(shot.materialIds) }));
    const next: Partial<VideoDraft> = {};
    if (d.storeShots) next.storeShots = shots(d.storeShots) as typeof d.storeShots;
    if (d.storeReferenceIds) next.storeReferenceIds = ids(d.storeReferenceIds);
    if (d.storeFirstFrameId) next.storeFirstFrameId = keptFrame(d.storeFirstFrameId);
    if (d.storeLastFrameId) next.storeLastFrameId = keptFrame(d.storeLastFrameId);
    if (d.storeShotSuggestion) next.storeShotSuggestion = shots(d.storeShotSuggestion) as typeof d.storeShotSuggestion;
    if (d.storeMaterialSuggestion) {
        const suggestion = d.storeMaterialSuggestion;
        next.storeMaterialSuggestion = { ...suggestion, shots: suggestion.shots.map((shot) => ({ ...shot, materialIds: ids(shot.materialIds) })), referenceIds: ids(suggestion.referenceIds) };
    }
    if (d.storePlanVersions) next.storePlanVersions = d.storePlanVersions.map((version) => ({ ...version, shots: shots(version.shots) as typeof version.shots, referenceIds: version.referenceIds ? ids(version.referenceIds) : undefined }));
    return next;
}

export function storeUnlinkedMaterialIds(d: Pick<VideoDraft, "media" | "storeShots" | "storeReferenceIds">) {
    const candidates = new Set(storeCandidateMaterials(d).map((m) => m.id));
    return storeSelectedIds(d).filter((id) => !candidates.has(id));
}
export function storeSelectedMaterialError(d: Pick<VideoDraft, "media" | "storeShots" | "storeReferenceIds">) {
    const candidates = new Set(storeCandidateMaterials(d).map((m) => m.id));
    const invalid = storeUnlinkedMaterialIds(d);
    if (!invalid.length) return "";
    return invalid.some((id) => d.media.some((m) => m.id === id))
        ? "方案中的图片引用当前类型或用途不可用；原素材仍在项目中，请调整素材用途或重新关联可用图片。"
        : "方案中的图片引用未关联到当前项目。素材库原文件不会被删除，请从素材库重新添加，或清除未关联引用。";
}
export function storeCast(d: Pick<VideoDraft, "media">) {
    const people = new Map<string, string[]>();
    for (const m of d.media.filter((m) => m.kind === "image" && m.role === "model")) {
        const name = m.storePerson?.trim() || "探店人";
        people.set(name, [...(people.get(name) || []), m.id]);
    }
    return [...people].map(([name, materialIds]) => ({ name, materialIds }));
}

export function storeCastReferenceError(d: Pick<VideoDraft, "media">, selectedIds: string[]) {
    const missing = storeCast(d).filter((person) => !person.materialIds.some((id) => selectedIds.includes(id)));
    return missing.length ? `方案未采用出镜人物「${missing.map((person) => person.name).join("、")}」的参考，请为出镜镜头选择人物图或重新编写方案` : "";
}

export const storeMaterialKey = (d: VideoDraft, limit: number) => JSON.stringify([
    d.script, d.storeShots, d.storeReferenceIds, d.storeFacts, d.instructions, d.analysis, limit,
    storeCandidateMaterials(d).map((m) => [m.id, m.storageKey, m.role, m.storePurpose, m.storePerson]),
]);

export function parseStoreMaterialSuggestion(raw: string, d: VideoDraft, limit: number, mode: "fill" | "select"): StoreMaterialSuggestion {
    let value: { shots?: unknown; referenceIds?: unknown };
    try {
        value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch {
        throw new Error("模型未返回有效配图建议，原选图已保留");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型未返回有效配图建议，原选图已保留");
    const allowed = new Set(storeCandidateMaterials(d).map((m) => m.id));
    const ids = (input: unknown): string[] => {
        if (!Array.isArray(input) || input.some((id) => typeof id !== "string" || !allowed.has(id))) throw new Error("配图建议引用了未知素材，原选图已保留");
        return [...new Set(input as string[])];
    };
    const current = d.storeShots || [];
    let shots: StoreMaterialSuggestion["shots"] = [];
    let referenceIds: string[] = [];
    if (current.length) {
        if (!Array.isArray(value.shots) || value.shots.length !== current.length) throw new Error("配图建议的镜头不完整，原方案已保留");
        const seen = new Set<string>();
        shots = value.shots.map((row) => {
            if (!row || typeof row !== "object" || typeof row.id !== "string" || seen.has(row.id)) throw new Error("配图建议的镜头编号无效");
            seen.add(row.id);
            const shot = current.find((s) => s.id === row.id);
            if (!shot) throw new Error("配图建议超出了当前镜头范围");
            const materialIds = ids(row.materialIds);
            if (mode === "fill" && shot.materialIds.length && JSON.stringify(materialIds) !== JSON.stringify(shot.materialIds)) throw new Error("配图建议修改了已有选图，原选择已保留");
            if (mode === "select" && shot.materialIds.length && !materialIds.length) throw new Error("精选建议遗漏了已有参考的镜头，请手动取舍");
            return { id: shot.id, materialIds };
        });
    } else {
        referenceIds = ids(value.referenceIds);
        if (mode === "fill" && (d.storeReferenceIds || []).some((id) => !referenceIds.includes(id))) throw new Error("配图建议移除了已有参考，原选择已保留");
    }
    const selected = new Set(current.length ? shots.flatMap((s) => s.materialIds) : referenceIds);
    const candidates = storeCandidateMaterials(d);
    for (const shot of current.length ? current : [{ id: "", visual: d.script, dialogue: "" }]) {
        const adopted = current.length ? shots.find((s) => s.id === shot.id)!.materialIds : referenceIds;
        for (const match of `${shot.visual}\n${shot.dialogue}`.matchAll(/@?图片(\d+)/g)) {
            if (!adopted.includes(candidates[Number(match[1]) - 1]?.id)) throw new Error("配图建议遗漏了方案明确引用的图片，原选择已保留");
        }
    }
    const castError = storeCastReferenceError(d, [...selected]);
    if (castError) throw new Error(castError);
    if (selected.size > limit) throw new Error(`建议仍超过当前模型的 ${limit} 张上限，请手动调整参考图片`);
    return { shots, referenceIds, base: storeMaterialKey(d, limit), mode };
}
