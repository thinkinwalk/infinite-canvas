import type { ReplacementJob } from "@/services/api/replacement-jobs";

export function replacementProgress(job: ReplacementJob) {
    const parts = job.parts || [];
    const processing = job.status === "running" || job.status === "planning";
    const preview = job.previewRequired && !job.previewApproved;
    const indices = job.selectionMode ? job.selectedParts || [] : preview ? [0] : parts.map((_, index) => index);
    const activeIndex = job.status === "running" ? indices.find((index) => {
        const part = parts[index];
        return part && (!part.validated || (job.selectionMode ? !part.result : preview && !job.previewReady));
    }) ?? -1 : -1;
    const part = parts[activeIndex];
    const stage = job.status === "planning" || part && !part.submitted && !part.generated ? 0 : part && !part.generated ? 1 : 2;
    const title = job.status === "planning" ? "正在分析视频与分段"
        : activeIndex < 0 ? "正在合成视频"
        : stage === 0 ? `正在准备第 ${activeIndex + 1} 段`
        : stage === 1 ? `正在生成第 ${activeIndex + 1} 段`
        : `正在整理第 ${activeIndex + 1} 段结果`;
    return { processing, activeIndex, stage, title, completed: parts.filter((part) => part.validated).length, total: parts.length };
}

export function replacementPartStatus(job: ReplacementJob, index: number) {
    const part = job.parts![index];
    const progress = replacementProgress(job);
    const completed = Boolean(part.result || (index === 0 && job.previewReady && job.previewResult));
    const active = progress.processing && progress.activeIndex === index;
    const label = completed ? "已完成"
        : active ? progress.stage === 0 ? "准备片段中" : progress.stage === 1 ? "模型生成中" : "整理结果中"
        : part.validated ? "已生成，待整理"
        : job.status === "paused" && part.submitted ? "已暂停，可恢复查询"
        : part.submitted ? "已提交，待恢复查询"
        : job.status === "running" && (job.selectionMode ? job.selectedParts?.includes(index) : !job.previewRequired || job.previewApproved || index === 0) ? "等待处理"
        : part.input ? "已切出，待生成" : "待生成";
    return { active, completed, label };
}
