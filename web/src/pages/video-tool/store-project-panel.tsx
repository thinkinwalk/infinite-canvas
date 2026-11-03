import { useState } from "react";
import { App, Button, Drawer, Empty, Input, Modal, Select, Space, Tooltip, theme } from "antd";
import { ListTodo, Pencil, Plus } from "lucide-react";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { canResumeStoreTask, resumeStoreTask, stopStoreTask } from "./store-task-runtime";
import { StoreTaskProgress } from "./store-task-progress";
import type { VideoRecord } from "@/types/video-workbench";

export const storeRecordStatus = (record: VideoRecord) => record.status === "completed" ? "已完成"
    : record.status === "failed" ? "生成失败"
    : record.storeQueryState === "paused" ? "查询已暂停"
    : record.storeQueryState === "interrupted" || record.status === "interrupted" ? "待核对 / 恢复查询"
    : "处理中";

export function StoreProjectPanel({ disabled }: { disabled: boolean }) {
    const state = useVideoWorkbenchStore();
    const project = state.storeProjects[state.activeStoreProjectId];
    const config = useEffectiveConfig();
    const { token } = theme.useToken();
    const { message, modal } = App.useApp();
    const [tasksOpen, setTasksOpen] = useState(false);
    const [editing, setEditing] = useState<"new" | "rename" | null>(null);
    const [name, setName] = useState("");
    const [saving, setSaving] = useState(false);
    const [filter, setFilter] = useState<string>("all");
    const projects = Object.values(state.storeProjects).sort((a, b) => b.createdAt - a.createdAt);
    const records = state.records.filter((r) => r.tool === "store-explore");
    const activeCount = records.filter((r) => ["running", "interrupted"].includes(r.status)).length;
    const labels: Record<string, string> = { video: "视频", script: "拍摄方案", analyze: "素材分析", speech: "旁白", subtitles: "字幕", compose: "成片", keyframe: "首帧", "material-match": "匹配素材", "material-select": "精选素材" };
    return (
        <>
            <div className="order-3 flex w-full min-w-0 items-center gap-1 sm:order-none sm:w-auto">
                <Select
                    aria-label="探店项目"
                    className="min-w-0 flex-1 sm:!w-52 sm:flex-none"
                    showSearch
                    virtual={false}
                    optionFilterProp="label"
                    disabled={disabled}
                    value={project?.id}
                    options={projects.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={state.selectStoreProject}
                />
                <Tooltip title="新建探店">
                    <Button aria-label="新建探店" type="text" icon={<Plus size={17} />} disabled={disabled} onClick={() => { setName(""); setEditing("new"); }} />
                </Tooltip>
                <Tooltip title="重命名项目">
                    <Button aria-label="重命名项目" type="text" icon={<Pencil size={15} />} disabled={disabled || !project} onClick={() => { setName(project.name); setEditing("rename"); }} />
                </Tooltip>
                <Tooltip title="生成任务">
                    <Button aria-label="生成任务" type="text" icon={<ListTodo size={16} />} onClick={() => setTasksOpen(true)}><span className="hidden sm:inline">生成任务</span>{activeCount ? <span>{activeCount}</span> : null}</Button>
                </Tooltip>
            </div>
            <Modal
                title={editing === "new" ? "新建探店项目" : "重命名项目"}
                open={Boolean(editing)}
                okText={editing === "new" ? "新建" : "保存"}
                cancelText="取消"
                confirmLoading={saving}
                onCancel={() => { if (!saving) setEditing(null); }}
                onOk={async () => {
                    if (saving) return;
                    setSaving(true);
                    try {
                        if (editing === "new") await state.createStoreProject(name);
                        else if (project && name.trim()) state.renameStoreProject(project.id, name);
                        setEditing(null);
                    } catch (error) { message.error(error instanceof Error ? error.message : "保存失败"); }
                    finally { setSaving(false); }
                }}
            >
                <Input aria-label="项目名称" placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} />
            </Modal>
            <Drawer title="生成任务" open={tasksOpen} onClose={() => setTasksOpen(false)} size={640} styles={{ wrapper: { maxWidth: "100vw" } }}>
                <Select aria-label="筛选任务项目" virtual={false} className="mb-3 w-full" value={filter} onChange={setFilter} options={[{ value: "all", label: "全部探店项目" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
                {!records.length && <Empty description="暂无生成任务" />}
                {records.filter((r) => filter === "all" || r.storeProjectId === filter).map((r) => (
                    <article key={r.id} className="space-y-2 border-b py-4" style={{ borderColor: token.colorBorderSecondary }} data-testid="store-task-row">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <strong className="min-w-0 break-words text-sm">{state.storeProjects[r.storeProjectId || ""]?.name || "探店项目"} · {labels[r.stage] || r.stage}</strong>
                            <span className="text-xs" style={{ color: token.colorTextSecondary }}>{storeRecordStatus(r)}</span>
                        </div>
                        <p className="break-words text-xs" style={{ color: token.colorTextSecondary }}>
                            {r.stage === "video" ? `${r.storeOrigin?.modelLabel || r.storeExploreInput?.storeSettings?.videoModel || r.modelTask?.model || ""} · ` : ""}{new Date(r.createdAt).toLocaleString()}
                        </p>
                        {(r.modelTask || r.replicateTask || r.workerJob) && <p className="break-all text-xs select-all" style={{ color: token.colorTextSecondary }}>任务号：{r.modelTask?.id || r.replicateTask?.id || r.workerJob?.id}</p>}
                        {state.storeQuerying[r.id] ? <StoreTaskProgress record={r} onStop={() => stopStoreTask(r.id)} /> : r.step && <p className="text-xs" style={{ color: token.colorTextSecondary }}>{r.step}</p>}
                        {r.error && <p className="break-words text-xs" style={{ color: token.colorWarningText }}>{r.error}</p>}
                        <Space wrap>
                            {r.storeExploreInput && <Button size="small" onClick={() => modal.info({
                                title: "提交时的输入", width: 800,
                                content: <div className="max-h-[65vh] space-y-3 overflow-auto">
                                    <p>{r.storeOrigin?.modelLabel || r.storeExploreInput!.storeSettings?.videoModel} · {r.storeExploreInput!.storeSettings?.videoSeconds} 秒 · {r.storeExploreInput!.storeSettings?.vquality}p</p>
                                    <p className="whitespace-pre-wrap break-words">{r.storeExploreInput!.storeFacts}</p>
                                    <p className="whitespace-pre-wrap break-words">{r.storeExploreInput!.instructions}</p>
                                    <p className="whitespace-pre-wrap break-words">{r.storeExploreInput!.script}</p>
                                </div>,
                            })}>输入快照</Button>}
                            <Button size="small" disabled={disabled} onClick={() => { if (r.storeProjectId) state.selectStoreProject(r.storeProjectId); setTasksOpen(false); }}>打开项目</Button>
                            {(r.result || r.text || r.draftPatch?.subtitles) && <Button size="small" disabled={disabled} onClick={() => {
                                state.setStorePreviewRecord(r.id);
                                if (r.storeProjectId) state.selectStoreProject(r.storeProjectId);
                                setTasksOpen(false);
                            }}>查看结果</Button>}
                            {["running", "interrupted"].includes(r.status) && canResumeStoreTask(r) && !state.storeQuerying[r.id] && <Button size="small" onClick={() => void resumeStoreTask(r, config)}>恢复查询</Button>}
                        </Space>
                    </article>
                ))}
            </Drawer>
        </>
    );
}
