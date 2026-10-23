import { theme } from "antd";
import { Check, Circle, LoaderCircle } from "lucide-react";
import type { ReplacementJob } from "@/services/api/replacement-jobs";
import { publicServiceText } from "@/services/api/replicate";
import { replacementProgress } from "./replacement-progress";

export function ReplacementProgress({ job }: { job: ReplacementJob }) {
    const { token } = theme.useToken();
    const progress = replacementProgress(job);
    const stages = ["准备片段", "模型生成", "整理结果"];
    return <div className="flex min-h-64 w-full flex-1 items-center justify-center px-3 py-8" role="status" aria-live="polite" aria-label="视频处理进度">
        <div className="flex w-full max-w-sm flex-col items-center gap-5">
            <LoaderCircle size={42} className="animate-spin motion-reduce:animate-none" style={{ color: token.colorPrimary }} aria-hidden />
            <div className="space-y-2 text-center">
                <div className="text-base font-medium">{progress.title}</div>
                <div className="break-words text-xs" style={{ color: token.colorTextSecondary }}>{publicServiceText(job.step)}</div>
            </div>
            {job.status === "running" && <ol className="grid w-full grid-cols-3 gap-2 text-xs" aria-label="当前处理阶段">
                {stages.map((label, index) => <li key={label} className="flex min-w-0 flex-col items-center gap-2 text-center" aria-current={index === progress.stage ? "step" : undefined}
                    style={{ color: index === progress.stage ? token.colorPrimary : index < progress.stage ? token.colorText : token.colorTextTertiary }}>
                    <div className={`h-1 w-full rounded-full ${index === progress.stage ? "animate-pulse motion-reduce:animate-none" : ""}`}
                        style={{ background: index <= progress.stage ? token.colorPrimary : token.colorFillSecondary }} />
                    <span className="flex items-center justify-center gap-1">
                        {index < progress.stage ? <Check size={13} aria-hidden /> : index === progress.stage ? <LoaderCircle size={13} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <Circle size={13} className="shrink-0" aria-hidden />}
                        {label}
                    </span>
                </li>)}
            </ol>}
            <div className="space-y-1 text-center text-xs" style={{ color: token.colorTextSecondary }}>
                {progress.total > 0 && <div className="tabular-nums">已生成 {progress.completed} / {progress.total} 段</div>}
                <div>完成后将自动显示结果</div>
            </div>
        </div>
    </div>;
}
