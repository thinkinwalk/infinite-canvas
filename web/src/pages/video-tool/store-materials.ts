import type { StoreMaterialSuggestion, VideoDraft } from "@/types/video-workbench";

export const storeCandidateMaterials = (d: Pick<VideoDraft, "media">) => d.media.filter((m) => m.kind === "image" && ["reference", "model", "first-frame"].includes(m.role));
export const storeSelectedIds = (d: VideoDraft) => [...new Set(d.storeShots?.length ? d.storeShots.flatMap((s) => s.materialIds) : d.storeReferenceIds || [])];
export const storeMaterialKey = (d: VideoDraft, limit: number) => JSON.stringify([
    d.script, d.storeShots, d.storeReferenceIds, d.storeFacts, d.instructions, d.analysis, limit,
    storeCandidateMaterials(d).map((m) => [m.id, m.storageKey, m.storePurpose, m.storePerson]),
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
    if (selected.size > limit) throw new Error(`建议仍超过当前模型的 ${limit} 张上限，请手动调整参考图片`);
    return { shots, referenceIds, base: storeMaterialKey(d, limit), mode };
}
