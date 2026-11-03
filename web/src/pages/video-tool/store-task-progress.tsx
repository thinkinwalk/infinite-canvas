import { useEffect, useState } from "react";
import { Button, Tooltip, theme } from "antd";
import { LoaderCircle } from "lucide-react";
import type { VideoRecord } from "@/types/video-workbench";

const taskTitles: Record<string, string> = {
    analyze: "正在分析门店素材",
    script: "正在生成拍摄方案",
    "material-match": "正在匹配镜头素材",
    "material-select": "正在精选参考图片",
    keyframe: "正在合成首帧预览",
    video: "正在生成探店视频",
    speech: "正在生成旁白",
    subtitles: "正在识别真实音轨",
    compose: "正在合成当前成片",
};
export const storeTaskTitle = (stage?: string) => taskTitles[stage || ""] || "正在处理探店任务";

export function StoreTaskProgress({ record, onStop }: { record?: VideoRecord; onStop: () => void }) {
    const { token } = theme.useToken();
    const [started] = useState(Date.now);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    const seconds = Math.max(0, Math.floor((now - (record?.createdAt || started)) / 1000));
    const elapsed = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
    const step = record?.step && record.step !== "正在处理" ? record.step : "正在准备任务";
    return (
        <div className="mb-3 shrink-0 border-b py-3" style={{ borderColor: token.colorBorderSecondary }} data-testid="store-task-progress">
            <div className="flex items-start gap-3">
                <LoaderCircle size={20} className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none" style={{ color: token.colorPrimary }} aria-hidden />
                <div className="min-w-0 flex-1">
                    <div role="status" aria-live="polite" aria-atomic="true">
                        <p className="text-sm font-medium">{record?.storeResultPending ? "云端已完成，正在取回视频" : storeTaskTitle(record?.stage)}</p>
                        {record?.stage === "video" && <p className="mt-1 break-words text-xs" style={{ color: token.colorTextSecondary }}>{record.storeOrigin?.modelLabel || record.storeExploreInput?.storeSettings?.videoModel || record.modelTask?.model}</p>}
                        <p className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>{step}</p>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: token.colorTextSecondary }}>
                        <span className="tabular-nums" aria-live="off" title="从本次任务开始计算，包含费用确认时间，不是剩余时间" data-testid="store-task-elapsed">已用时 {elapsed}</span>
                        <span>已提交请求可能继续处理或计费</span>
                    </div>
                </div>
                <Tooltip title={record?.stage === "script" || record?.stage === "analyze" ? "只停止本地等待；文案请求不支持恢复查询，请先核对使用日志再重新发起" : "只停止本地等待，已提交的任务可能继续运行"}>
                    <Button type="text" size="small" onClick={onStop}>停止等待</Button>
                </Tooltip>
            </div>
        </div>
    );
}

export function StorePlanSkeleton() {
    const { token } = theme.useToken();
    return (
        <div aria-label="拍摄方案生成中" aria-busy="true" data-testid="store-plan-skeleton">
            <div aria-hidden className="animate-pulse motion-reduce:animate-none">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="space-y-3 border-b py-5" style={{ borderColor: token.colorBorderSecondary }}>
                        <div className="h-4 w-24 rounded" style={{ background: token.colorFillSecondary }} />
                        <div className="h-3 w-full rounded" style={{ background: token.colorFillTertiary }} />
                        <div className="h-3 w-3/4 rounded" style={{ background: token.colorFillTertiary }} />
                        <div className="h-10 w-14 rounded" style={{ background: token.colorFillTertiary }} />
                    </div>
                ))}
            </div>
        </div>
    );
}
