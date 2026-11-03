import { useState, type ReactNode } from "react";
import { Alert, App, Button, Empty, Segmented, Spin, theme } from "antd";
import { FileText } from "lucide-react";
import { VideoTaskDetails } from "./video-task-details";

export type VideoHistoryItem = {
    id: string; title: string; kind: string; status: string; updatedAt: number;
    source: string; archived: boolean; hasResult: boolean; processing: boolean;
    onView?: () => void; onContinue?: () => void; onArchive: (archived: boolean) => void | Promise<void>;
    details: ReactNode | ((close: () => void) => ReactNode);
};

export function VideoTaskHistory({ items, disabled, loading, error, onReload }: {
    items: VideoHistoryItem[]; disabled: boolean; loading?: boolean; error?: string; onReload?: () => void;
}) {
    const { token } = theme.useToken(), { message } = App.useApp();
    const [filter, setFilter] = useState<"recent" | "archived">("recent");
    const [selected, setSelected] = useState<string>();
    const [archiving, setArchiving] = useState(false);
    const current = items.find((item) => item.id === selected);
    const visible = items.filter((item) => item.archived === (filter === "archived"));
    const close = () => setSelected(undefined);
    const archive = async (item: VideoHistoryItem) => {
        setArchiving(true);
        try {
            await item.onArchive(!item.archived);
            close();
            message.success(item.archived ? "已取消归档" : "已归档，可在已归档列表找回");
        } catch (error) { message.error(error instanceof Error ? error.message : "归档操作失败"); }
        finally { setArchiving(false); }
    };
    const muted = { color: token.colorTextSecondary };
    return <div className="min-w-0 space-y-3" data-testid="video-task-history">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented aria-label="历史任务筛选" value={filter} onChange={setFilter} options={[{ label: "任务列表", value: "recent" }, { label: "已归档", value: "archived" }]} />
            <span className="text-xs" style={muted}>{visible.length} 个任务{loading ? " · 正在读取在线任务" : ""}</span>
        </div>
        {error && <Alert type="warning" title={error} action={onReload && <Button size="small" onClick={onReload}>重新读取</Button>} />}
        {loading && !items.length ? <div className="p-8 text-center"><Spin /></div> : !visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === "archived" ? "暂无已归档任务" : "暂无历史任务"} />}
        {visible.map((item) => <article key={item.id} className="min-w-0 space-y-2 border-b py-3" style={{ borderColor: token.colorBorderSecondary }} data-testid="video-history-task">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <strong className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">{item.title}</strong>
                <span className="text-xs" style={muted}>{new Date(item.updatedAt).toLocaleString()}</span>
            </div>
            <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs" style={muted}>
                <span>{item.kind}</span><span>{item.status}</span>
                {item.hasResult && item.status !== "已完成" && item.status !== "已有结果" && <span>已有结果</span>}
                <span>{item.source}</span>
            </div>
            <div className="flex flex-wrap gap-2">
                {item.onView && <Button size="small" disabled={disabled || archiving} onClick={item.onView}>查看结果</Button>}
                {!item.archived && item.onContinue && <Button size="small" disabled={disabled || archiving} onClick={item.onContinue}>继续任务</Button>}
                <Button size="small" icon={<FileText size={14} />} disabled={archiving} onClick={() => setSelected(item.id)}>任务详情</Button>
            </div>
        </article>)}
        <VideoTaskDetails open={Boolean(current)} onClose={close}>
            {current && <>
                <div className="space-y-1"><div className="text-sm font-medium">{current.title}</div><div className="text-xs" style={muted}>{current.kind} · {current.status} · {current.source}</div></div>
                {typeof current.details === "function" ? current.details(close) : current.details}
                <div className="flex flex-wrap gap-2">
                    {current.onView && <Button size="small" disabled={disabled || archiving} onClick={() => { current.onView?.(); close(); }}>查看结果</Button>}
                    {!current.archived && current.onContinue && <Button size="small" disabled={disabled || archiving} onClick={() => { current.onContinue?.(); close(); }}>继续任务</Button>}
                    <Button size="small" disabled={disabled || current.processing} loading={archiving} onClick={() => void archive(current)}>{current.archived ? "取消归档" : "归档任务"}</Button>
                </div>
            </>}
        </VideoTaskDetails>
    </div>;
}
