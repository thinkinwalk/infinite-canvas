import { useEffect, useState } from "react";
import { theme } from "antd";
import { Check, Circle, LoaderCircle } from "lucide-react";
import type { ExtractionStage } from "./extract-video";

const stages = [
    { key: "extract", label: "解析链接与下载原视频" },
    { key: "prepare", label: "检查格式与准备播放" },
    { key: "save", label: "保存提取记录" },
] as const;

export function ExtractionProgress({ stage }: { stage: ExtractionStage }) {
    const { token } = theme.useToken();
    const [startedAt] = useState(Date.now);
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [startedAt]);
    const active = stages.findIndex((item) => item.key === stage);
    return <div className="flex w-full max-w-md flex-col items-center gap-5 px-5 py-6" role="status" aria-live="polite">
        <LoaderCircle size={36} className="animate-spin motion-reduce:animate-none" style={{ color: token.colorPrimary }} aria-hidden />
        <div className="text-center">
            <div className="text-base font-medium">{stages[active].label}</div>
            <div className="mt-1 text-xs tabular-nums" style={{ color: token.colorTextSecondary }} aria-live="off">已用时 {elapsed} 秒</div>
        </div>
        <ol className="w-full space-y-3 text-sm">
            {stages.map((item, index) => <li key={item.key} className="flex items-center gap-3" style={{ color: index <= active ? token.colorText : token.colorTextTertiary }} aria-current={index === active ? "step" : undefined}>
                {index < active ? <Check size={16} style={{ color: token.colorSuccess }} /> : index === active ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" style={{ color: token.colorPrimary }} /> : <Circle size={16} />}
                {item.label}
            </li>)}
        </ol>
    </div>;
}
