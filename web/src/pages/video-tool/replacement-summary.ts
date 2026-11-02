import type { ReplacementJob } from "@/services/api/replacement-jobs";

export function replacementDurationSummary(job: ReplacementJob) {
    const parts = job.parts || [];
    const original = parts.reduce((sum, p) => sum + p.end - p.start, 0);
    const inputs = parts.reduce((sum, p) => sum + p.inputEnd - p.inputStart, 0);
    const billed = parts.reduce((sum, p) => sum + p.seconds, 0);
    const references = parts.reduce((sum, p) => sum + (p.referenceSeconds || p.seconds), 0);
    if (parts.length === 1) {
        return `原片 ${original.toFixed(2)} 秒 · 整段生成 · 参考视频 ${references.toFixed(2)} 秒 · 生成 ${billed.toFixed(2)} 秒${references > inputs ? ` · 参考补齐 ${(references - inputs).toFixed(2)} 秒` : ""}`;
    }
    return `原片 ${original.toFixed(2)} 秒 · ${parts.length} 段 · 重叠 ${Math.max(0, inputs - original).toFixed(2)} 秒 · 参考视频 ${references.toFixed(2)} 秒 · 参考补齐 ${Math.max(0, references - inputs).toFixed(2)} 秒 · 本轮生成 ${billed.toFixed(2)} 秒`;
}
