import type { ReplacementJob } from "@/services/api/replacement-jobs";

export function replacementDurationSummary(job: ReplacementJob) {
    const parts = job.parts || [];
    const original = parts.reduce((sum, p) => sum + p.end - p.start, 0);
    const inputs = parts.reduce((sum, p) => sum + p.inputEnd - p.inputStart, 0);
    const billed = parts.reduce((sum, p) => sum + p.seconds, 0);
    return `原片 ${original.toFixed(2)} 秒 · ${parts.length} 段 · 重叠 ${Math.max(0, inputs - original).toFixed(2)} 秒 · 补齐 ${Math.max(0, billed - inputs).toFixed(2)} 秒 · 本轮生成 ${billed.toFixed(2)} 秒`;
}
