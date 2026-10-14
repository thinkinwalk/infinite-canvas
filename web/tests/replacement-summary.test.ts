import { expect, test } from "bun:test";
import { replacementDurationSummary } from "../src/pages/video-tool/replacement-summary";
import type { ReplacementJob } from "../src/services/api/replacement-jobs";

test("quote separates original time, overlap and padding from generation time", () => {
    const job = { parts: [
        { start: 0, end: 9.75, inputStart: 0, inputEnd: 10, seconds: 10 },
        { start: 9.75, end: 15, inputStart: 9.5, inputEnd: 15, seconds: 6 },
    ] } as ReplacementJob;
    expect(replacementDurationSummary(job)).toBe("原片 15.00 秒 · 2 段 · 重叠 0.50 秒 · 补齐 0.50 秒 · 本轮生成 16.00 秒");
});
