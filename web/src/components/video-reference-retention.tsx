import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Switch, theme } from "antd";
import { Check, RefreshCw } from "lucide-react";
import { readVideoReferenceRetention, referenceExpiresAt, subscribeVideoReferenceRetention, updateVideoReferenceRetention, videoReferenceRetentionRevision } from "@/services/video-reference-retention";
import type { TemporaryVideoReference } from "@/lib/video-reference-retention";
import type { UploadedFile } from "@/services/file-storage";

export function VideoReferenceRetention({ media, disabled, completed, onReimport }: {
    media?: Pick<UploadedFile, "referenceId">;
    disabled?: boolean;
    completed?: boolean;
    onReimport?: (text: string, signal: AbortSignal) => Promise<boolean>;
}) {
    const { token } = theme.useToken();
    const revision = useSyncExternalStore(subscribeVideoReferenceRetention, videoReferenceRetentionRevision);
    const [reference, setReference] = useState<TemporaryVideoReference | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let disposed = false;
        setReference((value) => value?.id === media?.referenceId ? value : null);
        if (media?.referenceId) void readVideoReferenceRetention(media.referenceId).then((value) => { if (!disposed) setReference(value); }).catch(() => { if (!disposed) setError("参考素材记录读取失败"); });
        return () => { disposed = true; };
    }, [media?.referenceId, revision]);
    if (!reference) return null;
    const action = async (kind: "review" | "keep" | "temporary" | "reimport") => {
        setBusy(true);
        setError("");
        try {
            if (kind === "reimport") {
                if (reference.source && onReimport) await onReimport(reference.source.sourceUrl, new AbortController().signal);
            } else await updateVideoReferenceRetention(reference.id, kind);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "参考素材操作失败");
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="space-y-1 text-xs" data-reference-retention>
            {reference.cleanedAt ? (
                <div className="flex flex-wrap items-center gap-2">
                    <span style={{ color: token.colorTextSecondary }}>参考视频已清理{reference.source?.title ? ` · ${reference.source.title}` : ""}</span>
                    {reference.source && onReimport && <Button size="small" type="text" icon={<RefreshCw size={13} />} loading={busy} disabled={disabled} onClick={() => void action("reimport")}>重新提取</Button>}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <Switch size="small" aria-label="长期保留参考视频" checked={reference.keep} disabled={disabled || busy} onChange={(keep) => void action(keep ? "keep" : "temporary")} />
                        <span>保留素材</span>
                        {completed && !reference.keep && !reference.reviewedAt && <Button size="small" type="text" icon={<Check size={13} />} loading={busy} disabled={disabled} onClick={() => void action("review")}>完成对比</Button>}
                    </div>
                    <div style={{ color: token.colorTextSecondary }}>
                        {reference.keep ? "已长期保留" : reference.reviewedAt ? `${new Date(referenceExpiresAt(reference)).toLocaleString()} 后清理参考视频` : "闲置 7 天后清理参考视频；生成作品保留"}
                    </div>
                </>
            )}
            {error && <div role="alert" style={{ color: token.colorError }}>{error}</div>}
        </div>
    );
}
