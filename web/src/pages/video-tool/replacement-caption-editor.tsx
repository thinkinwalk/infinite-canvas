import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Input, InputNumber, Modal, Select, theme } from "antd";
import { recognizeReplacementCaptions, renderReplacementCaptions, saveReplacementCaptions, type ReplacementCaption, type ReplacementJob } from "@/services/api/replacement-jobs";

const fonts = [
    { value: "Noto Sans CJK SC", label: "思源黑体" },
    { value: "Noto Serif CJK SC", label: "思源宋体" },
];

function srtTime(seconds: number) {
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor(milliseconds / 60000) % 60;
    const remainder = Math.floor(milliseconds / 1000) % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")},${String(milliseconds % 1000).padStart(3, "0")}`;
}

export function ReplacementCaptionEditor({ job, videoUrl, onClose, onRefresh, onRendered }: {
    job: ReplacementJob;
    videoUrl?: string;
    onClose: () => void;
    onRefresh: () => Promise<void>;
    onRendered: (id: string) => void;
}) {
    const { message, modal } = App.useApp();
    const { token } = theme.useToken();
    const [segments, setSegments] = useState<ReplacementCaption[]>(() => job.captionSegments || []);
    const [revision, setRevision] = useState(job.captionRevision || 0);
    const [size, setSize] = useState(job.subtitleSize || 42);
    const [color, setColor] = useState(job.subtitleColor || "#ffffff");
    const [bottom, setBottom] = useState(Math.round((job.subtitleBottom ?? 0.08) * 100));
    const [font, setFont] = useState(job.subtitleFont || "Noto Sans CJK SC");
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [playhead, setPlayhead] = useState(0);
    const [view, setView] = useState({ width: 0, height: 0, sourceWidth: 720 });
    const video = useRef<HTMLVideoElement>(null);
    const submitting = useRef(false);
    const locked = busy || job.captionStatus === "recognizing" || job.captionStatus === "rendering";
    useEffect(() => {
        if (dirty || (job.captionRevision || 0) <= revision) return;
        setSegments(job.captionSegments || []);
        setRevision(job.captionRevision);
        setSize(job.subtitleSize || 42);
        setColor(job.subtitleColor || "#ffffff");
        setBottom(Math.round((job.subtitleBottom ?? 0.08) * 100));
        setFont(job.subtitleFont || "Noto Sans CJK SC");
    }, [job.captionRevision, dirty, revision]);
    useEffect(() => {
        if (!video.current) return;
        const element = video.current;
        const update = () => setView({ width: element.clientWidth, height: element.clientHeight, sourceWidth: element.videoWidth || 720 });
        const observer = new ResizeObserver(update);
        observer.observe(element);
        update();
        return () => observer.disconnect();
    }, [videoUrl]);
    const changeSegments = (value: ReplacementCaption[]) => { setSegments(value); setDirty(true); };
    const changeStyle = (change: () => void) => { change(); setDirty(true); };
    const duration = Math.max(0, ...(job.parts?.map((part) => part.end) || []));
    const active = segments.find((item) => item.start <= playhead && playhead < item.end);
    const previewScale = view.sourceWidth ? view.width / view.sourceWidth : 1;
    const save = async () => {
        const updated = await saveReplacementCaptions(job.id, { revision, segments, size, color, bottom: bottom / 100, font });
        setRevision(updated.captionRevision);
        setDirty(false);
        await onRefresh();
        return updated;
    };
    const run = async (render: boolean) => {
        if (submitting.current || locked) return;
        submitting.current = true;
        setBusy(true);
        try {
            let savedRevision = revision;
            if (dirty) savedRevision = (await save()).captionRevision;
            else if (!render) { message.info("字幕已保存"); return; }
            if (render) {
                await renderReplacementCaptions(job.id, savedRevision);
                onRendered(job.id);
                message.success("正在生成带字幕版；无字幕原版已保留，不会重新调用人物模型");
                await onRefresh();
            } else message.success("字幕草稿已保存");
        } catch (error) { message.error(error instanceof Error ? error.message : "字幕处理失败"); }
        finally { submitting.current = false; setBusy(false); }
    };
    const recognize = () => modal.confirm({
        title: "重新识别原音轨？",
        content: "识别结果会覆盖当前字幕草稿，保存过的文字也会被替换。需要保留请先下载 SRT。无字幕视频不会改变。",
        onOk: async () => {
            if (submitting.current) return;
            submitting.current = true; setBusy(true);
            try { const updated = await recognizeReplacementCaptions(job.id, revision); setSegments(updated.captionSegments || []); setDirty(false); setRevision(updated.captionRevision); await onRefresh(); message.info("正在识别原音轨"); }
            catch (error) { message.error(error instanceof Error ? error.message : "识别失败"); throw error; }
            finally { submitting.current = false; setBusy(false); }
        },
    });
    const close = () => {
        if (!dirty) { onClose(); return; }
        modal.confirm({ title: "放弃尚未保存的字幕修改？", content: "当前文字和样式改动还没有保存。", okText: "放弃修改", cancelText: "继续编辑", onOk: onClose });
    };
    const downloadSrt = () => {
        if (segments.some((segment, index) => !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < (segments[index - 1]?.end || 0) || segment.end <= segment.start || segment.end > duration || !segment.text.trim())) {
            message.error("请先修正空字幕、重叠或超出原视频的时间，再下载 SRT");
            return;
        }
        const value = segments.map((segment, index) => `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text.trim()}\n`).join("\n");
        const address = URL.createObjectURL(new Blob(["\ufeff", value], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = address;
        link.download = `${job.id}.srt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(address), 0);
    };
    return <Modal open title="校对字幕并预览" width={900} onCancel={close} footer={null} destroyOnHidden>
        <div className="space-y-3">
            <Alert type="info" showIcon title="视频已先生成无字幕版；这里修改字幕不会重新调用收费人物模型。识别稿可能有错别字，请对照原声校对。" />
            {job.captionError && <Alert type="warning" showIcon title={job.captionError} />}
            {job.captionStatus === "recognizing" && <Alert type="info" showIcon title="正在识别原音轨，完成后字幕稿会自动出现" />}
            {job.captionStatus === "rendering" && <Alert type="info" showIcon title="正在合成带字幕版，可关闭窗口等待；无字幕版可继续查看" />}
            {dirty && job.captionRevision > revision && <Alert type="warning" showIcon title="其他页面已更新字幕。请复制当前修改并刷新，避免覆盖新版。" />}
            {videoUrl ? <div className="flex justify-center rounded-lg p-2" style={{ background: token.colorBgLayout }}>
                <div className="relative inline-block max-w-full">
                    <video ref={video} src={videoUrl} controls className="block max-h-[40vh] max-w-full" onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setView({ width: event.currentTarget.clientWidth, height: event.currentTarget.clientHeight, sourceWidth: event.currentTarget.videoWidth || 720 })} />
                    {active && <div className="pointer-events-none absolute text-center" style={{ left: 20 * previewScale, right: 20 * previewScale, bottom: view.height * bottom / 100, color, fontFamily: font, fontSize: size * previewScale, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.25, textShadow: "0 1px 2px black, 0 -1px 2px black, 1px 0 2px black, -1px 0 2px black" }}>{active.text}</div>}
                </div>
            </div> : <Alert type="warning" title="正在加载无字幕视频预览" />}
            <p className="m-0 text-xs" style={{ color: token.colorTextSecondary }}>预览会随播放时间显示当前字幕；字体描边与实际输出可能有细微差别，请以生成的带字幕版为准。</p>
            <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>字体</span><Select disabled={locked} aria-label="字幕字体" value={font} options={fonts} className="w-32" onChange={(value) => changeStyle(() => setFont(value))} />
                <span>字号</span><InputNumber aria-label="字幕字号" value={size} min={1} className="w-20" onChange={(value) => changeStyle(() => setSize(value || 42))} />
                <span>颜色</span><input aria-label="字幕颜色" type="color" value={color} onChange={(event) => changeStyle(() => setColor(event.target.value))} />
                <span>距底部</span><InputNumber aria-label="字幕距底部百分比" value={bottom} min={0} max={99} className="w-20" onChange={(value) => changeStyle(() => setBottom(value ?? 8))} /><span>%</span>
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                {segments.map((segment, index) => <div key={index} className="flex flex-wrap items-center gap-2">
                    <InputNumber aria-label={`第 ${index + 1} 条开始时间`} value={segment.start} step={0.01} min={0} className="w-24" onChange={(value) => changeSegments(segments.map((item, i) => i === index ? { ...item, start: value ?? 0 } : item))} />
                    <span>—</span>
                    <InputNumber aria-label={`第 ${index + 1} 条结束时间`} value={segment.end} step={0.01} min={0} className="w-24" onChange={(value) => changeSegments(segments.map((item, i) => i === index ? { ...item, end: value ?? 0 } : item))} />
                    <Input aria-label={`第 ${index + 1} 条字幕`} value={segment.text} className="min-w-40 flex-1" onChange={(event) => changeSegments(segments.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} onFocus={() => { if (video.current) { video.current.currentTime = segment.start; setPlayhead(segment.start); } }} />
                    <Button size="small" danger onClick={() => changeSegments(segments.filter((_, i) => i !== index))}>删除</Button>
                </div>)}
            </div>
            <div className="flex flex-wrap gap-2">
                <Button onClick={() => { const start = Math.min(playhead, Math.max(0, duration - 0.01)); const end = Math.min(duration, start + 2); changeSegments([...segments, { start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), text: "新字幕" }].sort((a, b) => a.start - b.start)); }}>在当前时间添加</Button>
                <Button onClick={recognize} disabled={busy || job.captionStatus === "recognizing" || job.captionStatus === "rendering"}>重新识别原音轨</Button>
                <Button onClick={downloadSrt} disabled={!segments.length}>下载 SRT（可导入剪映）</Button>
                <Button loading={busy} disabled={!dirty || job.captionStatus === "recognizing" || job.captionStatus === "rendering"} onClick={() => void run(false)}>保存草稿</Button>
                <Button type="primary" loading={busy} disabled={!segments.length || job.captionStatus === "recognizing" || job.captionStatus === "rendering" || (!dirty && job.captionStatus === "completed")} onClick={() => void run(true)}>保存并生成带字幕版</Button>
            </div>
            </fieldset>
        </div>
    </Modal>;
}
