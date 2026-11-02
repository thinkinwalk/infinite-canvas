import type { ReactNode } from "react";
import { Descriptions, Modal } from "antd";
import { formatBytes } from "@/lib/image-utils";
import type { UploadedFile } from "@/services/file-storage";
import type { VideoRecord } from "@/types/video-workbench";

export function videoResultRecord(records: VideoRecord[], result?: UploadedFile | null) {
    if (!result) return undefined;
    return records.find((record) => record.stage !== "draft" && record.result && (
        result.storageKey ? record.result.storageKey === result.storageKey : record.result.url === result.url
    ));
}

export function VideoTaskDetails({ open, onClose, record, result, children }: {
    open: boolean; onClose: () => void; record?: VideoRecord | null; result?: UploadedFile | null; children?: ReactNode;
}) {
    return <Modal title="任务详情" open={open} onCancel={onClose} footer={null} width={640}>
        <div className="flex flex-col gap-5 [overflow-wrap:anywhere]">
            {result && <VideoResultInfo record={record} result={result} />}
            {children}
        </div>
    </Modal>;
}

function VideoResultInfo({ record, result }: { record?: VideoRecord | null; result: UploadedFile }) {
    const settings = record?.viralInput?.viralSettings || record?.viralDraft?.viralSettings;
    const model = record?.modelTask?.model || record?.replacementPipeline?.model || settings?.videoModel;
    const billing = record?.replicateBilling;
    return <Descriptions size="small" column={1} items={[
        { key: "id", label: "任务编号", children: record?.modelTask?.id || record?.replicateTask?.id || record?.workerJob?.id || record?.id || "未记录" },
        { key: "status", label: "任务状态", children: record ? { completed: "已完成", running: "处理中", failed: "失败", interrupted: "查询暂停" }[record.status] : "已有作品" },
        { key: "created", label: "创建时间", children: record ? new Date(record.createdAt).toLocaleString() : "未记录" },
        { key: "model", label: "生成模型", children: model || "未记录" },
        { key: "size", label: "作品尺寸", children: result.width && result.height ? `${result.width} × ${result.height}` : settings?.size || "未记录" },
        { key: "duration", label: "作品时长", children: result.durationMs ? `${(result.durationMs / 1000).toFixed(2)} 秒` : "未记录" },
        { key: "bytes", label: "文件大小", children: formatBytes(result.bytes) },
        { key: "billing", label: "计费记录", children: billing ? `${billing.credits.toLocaleString()} 算力点${billing.refunded ? "（已返还）" : ""}` : "此记录未保存费用，以使用日志为准" },
    ]} />;
}
