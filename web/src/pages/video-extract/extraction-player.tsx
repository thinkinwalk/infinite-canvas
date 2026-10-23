import { useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Slider, Tooltip, theme } from "antd";
import { Pause, Play, Save, Scissors, SkipBack, SkipForward, X } from "lucide-react";
import { extractionClipError } from "@/lib/video-extraction";
import type { VideoExtractionClip } from "@/stores/use-video-extraction-store";

export function ExtractionPlayer({ url, durationMs, disabled, busy, editing, onSave, onCancelEdit, onError }: {
    url: string; durationMs?: number; disabled: boolean; busy: boolean; editing?: VideoExtractionClip;
    onSave: (name: string, range: [number, number]) => void;
    onCancelEdit: () => void; onError: () => void;
}) {
    const { token } = theme.useToken();
    const video = useRef<HTMLVideoElement>(null);
    const [duration, setDuration] = useState(Math.floor((durationMs || 0) / 10) / 100);
    const [range, setRange] = useState<[number, number]>([editing?.start || 0, editing?.end ?? Math.min(30, duration)]);
    const [name, setName] = useState(editing?.media.name.replace(/\.mp4$/i, "") || "");
    const [playingSelection, setPlayingSelection] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const rangeError = extractionClipError(range[0], range[1], duration * 1000);
    const select = (next: [number, number], seek = true) => {
        video.current?.pause();
        setPlayingSelection(false);
        setRange(next);
        if (seek && video.current && Number.isFinite(next[0])) video.current.currentTime = next[0];
    };
    const playSelection = () => {
        const player = video.current;
        if (!player) return;
        if (playing && playingSelection) { player.pause(); return; }
        player.currentTime = range[0];
        setPlayingSelection(true);
        void player.play().catch(() => setPlaying(false));
    };
    return <div className="space-y-4">
        <div className="flex aspect-video max-h-[60dvh] w-full items-center justify-center overflow-hidden rounded-md" style={{ background: token.colorFillAlter }}>
            <video ref={video} src={url} controls playsInline preload="metadata" className="h-full max-h-[60dvh] w-full object-contain" aria-label="原视频"
                onLoadedMetadata={(event) => {
                    const length = Math.floor(event.currentTarget.duration * 100) / 100;
                    if (Number.isFinite(length)) { setDuration(length); if (!editing) setRange([0, Math.min(30, length)]); }
                    if (editing) event.currentTarget.currentTime = editing.start;
                    setLoaded(true);
                }}
                onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
                onSeeking={(event) => { if (playingSelection && (event.currentTarget.currentTime < range[0] || event.currentTarget.currentTime > range[1])) { event.currentTarget.pause(); setPlayingSelection(false); } }}
                onTimeUpdate={(event) => { if (playingSelection && event.currentTarget.currentTime >= range[1]) { event.currentTarget.pause(); setPlayingSelection(false); } }}
                onError={onError} />
        </div>
        <section aria-label="手动选取视频片段" className="space-y-3 border-b pb-4" style={{ borderColor: token.colorBorderSecondary }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-medium"><Scissors size={16} />{editing ? "调整片段" : "选取片段"}</h3>
                <span className="text-xs tabular-nums" style={{ color: token.colorTextSecondary }}>选中 {Math.max(0, range[1] - range[0]).toFixed(2)} 秒 · 单段 1–30 秒</span>
            </div>
            <Slider range min={0} max={duration || 1} step={0.01} value={range} disabled={disabled || !loaded}
                ariaLabelForHandle={["片段起点", "片段终点"]} onChange={(value) => select(value as [number, number])} />
            <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs">起点（秒）<InputNumber aria-label="片段起点秒数" min={0} max={duration} step={0.01} precision={2} value={range[0]} disabled={disabled || !loaded} onChange={(value) => select([value ?? 0, range[1]])} /></label>
                <Tooltip title="当前播放位置设为起点"><Button aria-label="设为起点" icon={<SkipBack size={15} />} disabled={disabled || !loaded} onClick={() => select([Math.min(duration, Math.round((video.current?.currentTime || 0) * 100) / 100), range[1]], false)} /></Tooltip>
                <label className="flex items-center gap-2 text-xs">终点（秒）<InputNumber aria-label="片段终点秒数" min={0} max={duration} step={0.01} precision={2} value={range[1]} disabled={disabled || !loaded} onChange={(value) => select([range[0], value ?? 0], false)} /></label>
                <Tooltip title="当前播放位置设为终点"><Button aria-label="设为终点" icon={<SkipForward size={15} />} disabled={disabled || !loaded} onClick={() => select([range[0], Math.min(duration, Math.round((video.current?.currentTime || 0) * 100) / 100)], false)} /></Tooltip>
                <Button icon={playing && playingSelection ? <Pause size={15} /> : <Play size={15} />} disabled={disabled || !loaded || Boolean(rangeError)} onClick={playSelection}>试看选段</Button>
            </div>
            <div className="flex flex-wrap gap-2">
                <Input aria-label="片段名称" placeholder="片段名称" className="min-w-0 !w-auto flex-1" value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
                {(editing || busy) && <Button icon={<X size={15} />} disabled={disabled && !busy} onClick={onCancelEdit}>{busy ? "取消裁剪" : "取消调整"}</Button>}
                <Button type="primary" icon={<Save size={15} />} loading={busy} disabled={Boolean(rangeError) || !name.trim() || (disabled && !busy) || !loaded} onClick={() => {
                    video.current?.pause();
                    onSave(name, range);
                }}>{editing ? "保存调整" : "保存片段"}</Button>
            </div>
            {rangeError && loaded && <Alert type="warning" showIcon title={rangeError} />}
        </section>
    </div>;
}
