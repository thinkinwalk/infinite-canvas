import { useEffect, useRef, useState } from "react";
import { Alert, Button, InputNumber, Modal, Slider } from "antd";
import { trimWorkbenchVideo, workbenchMediaBlob } from "@/services/api/video-worker";
import { readPlayableVideoMeta, type UploadedFile } from "@/services/file-storage";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";

type Material = UploadedFile & { name: string };

export function VideoReferenceTrimmer({ media, disabled, onApply, onBusyChange }: {
    media: Material;
    disabled: boolean;
    onApply: (file: Material) => void;
    onBusyChange: (busy: boolean) => void;
}) {
    const worker = useVideoWorkbenchStore((s) => s.worker);
    const [open, setOpen] = useState(false);
    const [range, setRange] = useState<[number, number]>([0, 30]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    const video = useRef<HTMLVideoElement | null>(null);
    const duration = (media.durationMs || 0) / 1000;
    const invalid = !Number.isFinite(duration) || duration < 1 || duration > 30;
    const validRange = range.every(Number.isFinite) && range[0] >= 0 && range[1] <= duration && range[1] - range[0] >= 1 && range[1] - range[0] <= 30;
    useEffect(() => () => controller.current?.abort(), []);
    useEffect(() => {
        let disposed = false;
        setError("");
        if (!media.durationMs) void workbenchMediaBlob(media).then(readPlayableVideoMeta).then((meta) => {
            if (!disposed && meta.durationMs) onApply({ ...media, ...meta });
        }).catch(() => { if (!disposed) setError("无法读取视频时长，请重新上传可播放的视频"); });
        return () => { disposed = true; };
    }, [media.storageKey, media.url]);

    const trim = async (selection: [number, number]) => {
        if (controller.current || disabled) return;
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true); onBusyChange(true); setError("");
        video.current?.pause();
        try {
            const clipped = await trimWorkbenchVideo(worker, media, selection[0], selection[1], abort.signal);
            abort.signal.throwIfAborted();
            onApply({ ...clipped, name: `${media.name.replace(/\.[^.]+$/, "")}_${selection[0]}-${selection[1]}s.mp4` });
            setOpen(false);
        } catch (cause) {
            if (!abort.signal.aborted) setError(`${cause instanceof Error ? cause.message : "裁剪失败"}。原素材已保留。`);
        } finally {
            controller.current = null;
            setBusy(false); onBusyChange(false);
        }
    };
    const select = (next: [number, number]) => {
        setRange(next);
        if (video.current && Number.isFinite(next[0])) { video.current.pause(); video.current.currentTime = next[0]; }
    };
    return <div className="space-y-2">
        {invalid && <Alert type="warning" showIcon title={duration > 30 ? `参考视频为 ${duration.toFixed(2)} 秒，超过 30 秒，请先裁剪` : duration > 0 ? "参考视频不足 1 秒，请更换素材" : "正在读取参考视频时长"} />}
        <div className="flex flex-wrap gap-2">
            {duration > 30 && <Button size="small" disabled={disabled} loading={busy} onClick={() => void trim([0, 30])}>一键截取前 30 秒</Button>}
            <Button size="small" disabled={disabled || duration < 1} onClick={() => { select([0, Math.min(30, Math.floor(duration * 10) / 10)]); setError(""); setOpen(true); }}>手动裁剪</Button>
        </div>
        <p className="text-xs text-muted-foreground">参考片段须为 1–30 秒，与生成时长分开设置。裁剪保留原文件，不会自动生成视频。</p>
        {error && <Alert type="error" showIcon title={error} />}
        <Modal title="裁剪参考视频" open={open} onCancel={() => { if (!busy) setOpen(false); }} closable={!busy} maskClosable={!busy} footer={<div className="flex justify-end gap-2"><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button type="primary" loading={busy} disabled={!validRange || (disabled && !busy)} onClick={() => void trim(range)}>裁剪并使用片段</Button></div>}>
            <div className="space-y-3">
                <video ref={video} src={media.url} controls className="max-h-64 w-full rounded-lg" onPlay={() => { if (video.current && (video.current.currentTime < range[0] || video.current.currentTime >= range[1])) video.current.currentTime = range[0]; }} onTimeUpdate={() => { if (video.current && video.current.currentTime >= range[1]) video.current.pause(); }} />
                <Slider range min={0} max={Math.floor(duration * 10) / 10} step={0.1} value={range} disabled={busy} onChange={(value) => select(value as [number, number])} />
                <div className="flex flex-wrap items-center gap-2">
                    <span>开始秒数</span><InputNumber aria-label="裁剪开始秒数" min={0} max={duration} step={0.1} value={range[0]} disabled={busy} onChange={(value) => select([value ?? 0, range[1]])} />
                    <span>结束秒数</span><InputNumber aria-label="裁剪结束秒数" min={0} max={duration} step={0.1} value={range[1]} disabled={busy} onChange={(value) => select([range[0], value ?? 0])} />
                </div>
                <p>所选片段：{Math.max(0, range[1] - range[0]).toFixed(2)} 秒（须为 1–30 秒）</p>
                <Button disabled={busy || !validRange} onClick={() => { if (video.current) { video.current.currentTime = range[0]; void video.current.play(); } }}>预览所选片段</Button>
                {error && <Alert type="error" title={error} />}
            </div>
        </Modal>
    </div>;
}
