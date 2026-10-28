import { useEffect, useRef, useState } from "react";
import { Button, Input, theme } from "antd";
import { Link2, X } from "lucide-react";
import { useUserStore } from "@/stores/use-user-store";
import { videoImportPlatformName } from "@/lib/video-import";
import type { VideoImportSource } from "@/types/video-workbench";
import type { UploadedFile } from "@/services/file-storage";
import { VideoReferenceRetention } from "./video-reference-retention";

export function VideoLinkImport({ disabled, onImport, source, media, completed, showRetention = true }: {
    disabled?: boolean;
    onImport: (text: string, signal: AbortSignal) => Promise<boolean>;
    source?: VideoImportSource;
    media?: UploadedFile;
    completed?: boolean;
    showRetention?: boolean;
}) {
    const { token } = theme.useToken();
    const session = useUserStore((state) => state.token);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => {
        request.current?.abort();
        request.current = null;
    }, []);
    useEffect(() => {
        request.current?.abort();
    }, [session]);
    const extract = async () => {
        if (disabled || request.current || !text.trim()) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError("");
        try {
            if (await onImport(text, controller.signal)) {
                controller.signal.throwIfAborted();
                setText("");
            }
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "视频提取失败，原素材已保留");
        } finally {
            if (request.current === controller) {
                request.current = null;
                setBusy(false);
            }
        }
    };
    return (
        <div className="mt-2 min-w-0 space-y-1" data-video-link-import>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input
                    className="min-w-0 flex-1 basis-40"
                    aria-label="视频分享链接"
                    placeholder="粘贴视频分享链接或分享文案"
                    prefix={<Link2 size={14} />}
                    value={text}
                    allowClear
                    disabled={disabled || busy || !session}
                    onChange={(event) => { setText(event.target.value); setError(""); }}
                    onPressEnter={() => void extract()}
                />
                <Button icon={<Link2 size={14} />} loading={busy} disabled={disabled || !session || !text.trim()} onClick={() => void extract()}>提取视频</Button>
                {busy && <Button type="text" icon={<X size={14} />} aria-label="取消视频提取" onClick={() => request.current?.abort()}>取消</Button>}
            </div>
            {!session && <div className="text-xs" style={{ color: token.colorTextSecondary }}>请登录后提取视频</div>}
            {busy && <div role="status" className="text-xs" style={{ color: token.colorTextSecondary }}>正在提取并检查视频…</div>}
            {error && <div role="alert" className="break-words text-xs" style={{ color: token.colorError }}>{error}</div>}
            <div className="text-xs" style={{ color: token.colorTextSecondary }}>原视频上限 300MB；生成时按模型要求准备参考片段。</div>
            <div className="text-xs" style={{ color: token.colorTextSecondary }}>链接将发送至第三方解析服务；仅提取公开可访问的视频。</div>
            {source && <div className="break-words text-xs" title={source.sourceUrl} style={{ color: token.colorTextSecondary }}>{videoImportPlatformName(source.platform)}{source.author ? ` · ${source.author}` : ""}{source.title ? ` · ${source.title}` : ""}</div>}
            {showRetention && <VideoReferenceRetention media={media} completed={completed} disabled={disabled || busy} onReimport={onImport} />}
        </div>
    );
}
