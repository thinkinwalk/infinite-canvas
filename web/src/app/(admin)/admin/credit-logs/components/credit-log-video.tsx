import { DownloadOutlined, PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Flex, Space, Spin, Tag, Tooltip, Typography } from "antd";
import { saveAs } from "file-saver";
import { useEffect, useState } from "react";

import { fetchAdminCreditLogVideo, fetchAdminCreditLogVideoContent, type AdminCreditLog, type AdminCreditLogVideo } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

const statusLabels: Record<string, string> = {
    pending: "排队中",
    submitting: "提交中",
    running: "生成中",
    generated: "已生成，待保存",
    completed: "已完成",
    failed: "生成失败",
    cancelled: "已取消",
    expired: "已过期",
    uncertain: "状态待确认",
};

export function CreditLogVideo({ log }: { log: AdminCreditLog }) {
    const token = useUserStore((state) => state.token);
    const [revision, setRevision] = useState(0);
    const [video, setVideo] = useState<AdminCreditLogVideo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [requested, setRequested] = useState(false);
    const [media, setMedia] = useState<{ url: string; blob: Blob } | null>(null);
    const [mediaError, setMediaError] = useState("");
    const [playbackError, setPlaybackError] = useState("");
    const [mediaLoading, setMediaLoading] = useState(false);

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError("");
        void fetchAdminCreditLogVideo(token, log.id)
            .then((result) => {
                if (active) setVideo(result);
            })
            .catch((cause: unknown) => {
                if (active) setError(cause instanceof Error ? cause.message : "读取视频任务失败");
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, [log.id, token, revision]);

    useEffect(() => {
        if (!requested || !video?.available) return;
        const controller = new AbortController();
        let objectUrl = "";
        setMediaLoading(true);
        setMediaError("");
        setPlaybackError("");
        void fetchAdminCreditLogVideoContent(token, log.id, controller.signal)
            .then((blob) => {
                if (controller.signal.aborted) return;
                objectUrl = URL.createObjectURL(blob);
                setMedia({ url: objectUrl, blob });
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) setMediaError(cause instanceof Error ? cause.message : "视频加载失败");
            })
            .finally(() => {
                if (!controller.signal.aborted) setMediaLoading(false);
            });
        return () => {
            controller.abort();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [requested, video?.available, log.id, token, revision]);

    const refresh = () => {
        setRequested(false);
        setMedia(null);
        setMediaLoading(false);
        setMediaError("");
        setPlaybackError("");
        setRevision((current) => current + 1);
    };

    return (
        <Flex vertical gap={8} style={{ minWidth: 0 }}>
            <Flex align="center" gap={8} wrap>
                <Typography.Text strong>生成视频</Typography.Text>
                {loading ? <Spin size="small" /> : video ? <Tag color={video.status === "completed" ? "green" : ["failed", "cancelled", "expired"].includes(video.status) ? "error" : "processing"}>{statusLabels[video.status] || video.status}</Tag> : null}
                <Tooltip title="刷新任务状态">
                    <Button type="text" size="small" aria-label="刷新视频状态" loading={loading} icon={<ReloadOutlined />} onClick={refresh} />
                </Tooltip>
            </Flex>
            {error ? <Typography.Text type="danger">{error}</Typography.Text> : !loading && !video ? <Typography.Text type="secondary">此记录未关联可查看的视频任务</Typography.Text> : null}
            {video ? (
                <>
                    <Typography.Text copyable={{ text: video.taskId }} style={{ overflowWrap: "anywhere" }}>
                        任务 ID：{video.taskId}
                    </Typography.Text>
                    {video.available ? (
                        <Space wrap>
                            {!media && (
                                <Button
                                    icon={<PlayCircleOutlined />}
                                    loading={mediaLoading}
                                    onClick={() => {
                                        if (mediaError) setRevision((current) => current + 1);
                                        setRequested(true);
                                    }}
                                >
                                    {mediaError ? "重新加载视频" : "加载视频"}
                                </Button>
                            )}
                            {media && (
                                <Button icon={<DownloadOutlined />} onClick={() => saveAs(media.blob, `video-${video.taskId}.${media.blob.type.includes("webm") ? "webm" : "mp4"}`)}>
                                    下载视频
                                </Button>
                            )}
                        </Space>
                    ) : video.status === "completed" ? (
                        <Typography.Text type="secondary">视频文件尚未保存</Typography.Text>
                    ) : ["failed", "cancelled", "expired"].includes(video.status) ? (
                        <Typography.Text type="secondary">该任务没有可播放的视频</Typography.Text>
                    ) : (
                        <Typography.Text type="secondary">任务尚未完成，可稍后刷新查看</Typography.Text>
                    )}
                    {mediaError && <Typography.Text type="danger">{mediaError}</Typography.Text>}
                    {media && (
                        <video controls playsInline preload="metadata" src={media.url} aria-label="生成视频预览" onError={() => setPlaybackError("当前浏览器无法播放此视频，可下载后查看")} style={{ display: "block", width: "100%", maxHeight: 360 }} />
                    )}
                    {playbackError && <Typography.Text type="warning">{playbackError}</Typography.Text>}
                </>
            ) : null}
        </Flex>
    );
}
