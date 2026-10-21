import { useRef, useState } from "react";
import { Alert, Button, theme } from "antd";
import { Maximize, Pause, Play } from "lucide-react";

// 原片按计划范围播放，无需先切出文件，也不调用生成服务。
export function ReplacementSegmentPlayer({ url, start, end, label }: { url: string; start: number; end: number; label: string }) {
    const { token } = theme.useToken();
    const container = useRef<HTMLDivElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const [position, setPosition] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    const length = end - start;
    const toggle = () => {
        const player = video.current;
        if (!player) return;
        if (!player.paused) { player.pause(); return; }
        if (player.currentTime < start || player.currentTime >= Math.min(end, player.duration)) player.currentTime = start;
        void player.play().catch(() => setPlaying(false));
    };
    return <div ref={container} className="flex min-w-0 flex-col justify-center gap-3" style={{ background: token.colorBgContainer, color: token.colorText }} aria-label={label}>
        <video ref={video} src={url} preload="metadata" playsInline className="max-h-[55vh] w-full rounded-lg object-contain" aria-label={label}
            onLoadedMetadata={(event) => { event.currentTarget.currentTime = start; setReady(true); }}
            onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
            onSeeking={(event) => {
                const player = event.currentTarget;
                const bounded = Math.max(start, Math.min(end, player.currentTime));
                if (player.currentTime !== bounded) player.currentTime = bounded;
            }}
            onTimeUpdate={(event) => {
                const player = event.currentTarget;
                const stop = Math.min(end, player.duration);
                if (player.currentTime >= stop) { player.pause(); if (player.currentTime > stop) player.currentTime = stop; }
                setPosition(Math.max(0, Math.min(length, player.currentTime - start)));
            }}
            onError={() => setFailed(true)} />
        {failed ? <Alert type="warning" title="片段无法播放，请重新载入任务，或检查原视频编码。" /> : <div className="flex items-center gap-2">
            <Button aria-label={playing ? `暂停${label}` : `播放${label}`} disabled={!ready} onClick={toggle} icon={playing ? <Pause size={15} /> : <Play size={15} />} />
            <input type="range" aria-label={`${label}播放进度`} min={0} max={length} step="any" value={position} disabled={!ready} className="min-w-0 flex-1"
                onChange={(event) => { const value = Number(event.target.value); if (video.current) video.current.currentTime = start + value; setPosition(value); }} />
            <span className="shrink-0 text-xs tabular-nums">{position.toFixed(2)} / {length.toFixed(2)} 秒</span>
            <Button aria-label={`全屏查看${label}`} icon={<Maximize size={15} />} onClick={() => void container.current?.requestFullscreen?.().catch(() => {})} />
        </div>}
    </div>;
}
