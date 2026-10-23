import { expect, test } from "bun:test";
import type { ReplacementJob } from "../src/services/api/replacement-jobs";
import { replacementPartStatus, replacementProgress } from "../src/pages/video-tool/replacement-progress";

const part = (start = 0) => ({ start, end: start + 5, inputStart: start, inputEnd: start + 5, seconds: 5, submitted: false, validated: false, credits: 30 });
const job = (patch: Partial<ReplacementJob> = {}): ReplacementJob => ({
    id: "test", model: "h3-video", resolution: "768", seconds: "5", status: "running", step: "处理第 1 / 2 段",
    credits: 60, planned: true, previewRequired: false, previewReady: false, previewApproved: false,
    captionRevision: 0, subtitleSize: 24, subtitleColor: "#ffffff", subtitleBottom: 20, subtitleFont: "",
    source: "source.mp4", subtitles: false, regenerateSubtitles: false, createdAt: "",
    parts: [part(), part(5)], ...patch,
});

test("generation stages follow actual input and result state", () => {
    const current = job();
    expect(replacementProgress(current)).toMatchObject({ activeIndex: 0, stage: 0, completed: 0 });
    current.parts![0].input = "input.mp4";
    current.parts![0].submitted = true;
    expect(replacementPartStatus(current, 0)).toMatchObject({ active: true, label: "模型生成中" });
    current.parts![0].generated = "generated.mp4";
    expect(replacementProgress(current).stage).toBe(2);
    current.parts![0].validated = true;
    expect(replacementProgress(current)).toMatchObject({ activeIndex: 1, completed: 1 });
    current.parts![1].validated = true;
    expect(replacementProgress(current)).toMatchObject({ activeIndex: -1, stage: 2, title: "正在合成视频", completed: 2 });
});

test("selected parts keep exporting active and leave unselected parts idle", () => {
    const current = job({ selectionMode: true, selectedParts: [1] });
    expect(replacementProgress(current).activeIndex).toBe(1);
    expect(replacementPartStatus(current, 0)).toMatchObject({ active: false, label: "待生成" });
    Object.assign(current.parts![1], { input: "input.mp4", generated: "generated.mp4", validated: true });
    expect(replacementPartStatus(current, 1)).toMatchObject({ active: true, label: "整理结果中" });
    current.parts![1].result = "export.mp4";
    expect(replacementPartStatus(current, 1)).toMatchObject({ active: false, completed: true, label: "已完成" });
});

test("preview postprocessing never marks the next segment as running", () => {
    const current = job({ previewRequired: true });
    Object.assign(current.parts![0], { input: "input.mp4", generated: "generated.mp4", validated: true });
    expect(replacementProgress(current)).toMatchObject({ activeIndex: 0, stage: 2 });
    expect(replacementPartStatus(current, 1)).toMatchObject({ active: false, label: "待生成" });
    current.status = "preview";
    current.previewReady = true;
    current.previewResult = "preview.mp4";
    expect(replacementProgress(current).processing).toBe(false);
    expect(replacementPartStatus(current, 0).completed).toBe(true);
});

test("planning, pause, ready and completion never animate stale submitted parts", () => {
    expect(replacementProgress(job({ status: "planning", parts: null }))).toMatchObject({ processing: true, activeIndex: -1, stage: 0 });
    for (const status of ["paused", "ready", "completed"] as const) {
        const current = job({ status });
        current.parts![0].submitted = true;
        expect(replacementProgress(current).processing).toBe(false);
        expect(replacementPartStatus(current, 0).active).toBe(false);
    }
    const paused = job({ status: "paused" });
    paused.parts![0].submitted = true;
    expect(replacementPartStatus(paused, 0).label).toBe("已暂停，可恢复查询");
});
