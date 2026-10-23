import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Spin, Tag, Tooltip, theme } from "antd";
import { ArrowRight, ChevronDown, Download, FolderPlus, Link2, Pencil, Play, RefreshCw, Scissors, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { saveAs } from "file-saver";
import { VideoReferenceRetention } from "@/components/video-reference-retention";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { clipExtraction, extractionTargetError, extractionTargets, hasExtractionTargetDraft, type ExtractionTarget } from "@/lib/video-extraction";
import { videoImportPlatformName } from "@/lib/video-import";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { readVideoReferenceRetention, subscribeVideoReferenceRetention, updateVideoReferenceRetention, videoReferenceRetentionRevision } from "@/services/video-reference-retention";
import { useAssetStore } from "@/stores/use-asset-store";
import { useVideoExtractionStore, type VideoExtractionClip } from "@/stores/use-video-extraction-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { extractVideoToHistory, type ExtractionStage } from "./extract-video";
import { readExtractedVideo, sendExtractionToWorkbench } from "./extraction-actions";
import { saveExtractionClip } from "./extraction-clips";
import { ExtractionProgress } from "./extraction-progress";
import { ExtractionPlayer } from "./extraction-player";

export default function VideoExtractPage() {
    const { token: colors } = theme.useToken();
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const session = useUserStore((state) => state.token);
    const userId = useUserStore((state) => state.user?.id || "");
    const history = useVideoExtractionStore();
    const assets = useAssetStore((state) => state.assets);
    const [text, setText] = useState("");
    const [selected, setSelected] = useState("");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [preview, setPreview] = useState({ id: "", url: "", error: "" });
    const [stage, setStage] = useState<ExtractionStage>("extract");
    const [editing, setEditing] = useState<VideoExtractionClip>();
    const [clipPreview, setClipPreview] = useState({ id: "", url: "", title: "", error: "" });
    const [editorVersion, setEditorVersion] = useState(0);
    const editor = useRef<HTMLDivElement>(null);
    const handoffDialog = useRef<{ destroy: () => void } | null>(null);
    const request = useRef<AbortController | null>(null);
    const revision = useSyncExternalStore(subscribeVideoReferenceRetention, videoReferenceRetentionRevision);
    const records = session && history.owner === userId ? history.records : [];
    const current = records.find((record) => record.id === selected) || records[0];
    const source = current?.media.source;
    const saved = Boolean(current && assets.some((asset) => asset.kind === "video" && asset.metadata?.extractionId === current.id));

    useEffect(() => {
        request.current?.abort();
        setSelected("");
        setError("");
        setEditing(undefined);
        setClipPreview({ id: "", url: "", title: "", error: "" });
        void useVideoExtractionStore.getState().load(session ? userId : "");
        return () => { request.current?.abort(); handoffDialog.current?.destroy(); };
    }, [session, userId]);

    useEffect(() => { setEditing(undefined); setClipPreview({ id: "", url: "", title: "", error: "" }); }, [current?.id]);

    useEffect(() => {
        let disposed = false;
        setPreview((previous) => previous.id === current?.id ? previous : { id: "", url: "", error: "" });
        if (current) void (async () => {
            const reference = current.media.referenceId && await readVideoReferenceRetention(current.media.referenceId);
            const blob = reference && !reference.cleanedAt && await getMediaBlob(current.media.storageKey);
            if (!blob) throw new Error("视频已清理或本地文件不可用，请重新提取");
            const url = await resolveMediaUrl(current.media.storageKey);
            if (!disposed) setPreview({ id: current.id, url, error: "" });
        })().catch((failure) => {
            if (!disposed) setPreview({ id: current.id, url: "", error: failure instanceof Error ? failure.message : "视频加载失败" });
        });
        return () => { disposed = true; };
    }, [current, revision]);

    const validate = (controller: AbortController, originalSession: string) => {
        controller.signal.throwIfAborted();
        if (useUserStore.getState().token !== originalSession || useUserStore.getState().user?.id !== userId) throw new Error("登录状态已变化，请重新操作");
    };
    const run = async (action: string, work: (controller: AbortController, originalSession: string) => Promise<void>) => {
        if (request.current || !session || !userId || useUserStore.getState().token !== session) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(action);
        setError("");
        try {
            await work(controller, session);
        } catch (failure) {
            if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "操作失败，请重试");
        } finally {
            if (request.current === controller) { request.current = null; setBusy(""); }
        }
    };
    const extract = (value = text) => run("extract", async (controller, originalSession) => {
        if (!value.trim()) return;
        setStage("extract");
        const record = await extractVideoToHistory(value, controller.signal, (next) => {
            validate(controller, originalSession);
            setStage(next);
        });
        validate(controller, originalSession);
        setSelected(record.id);
        setText("");
    });
    const download = (record = current) => record && run("download", async (controller, originalSession) => {
        const blob = await readExtractedVideo(record, controller.signal, true);
        validate(controller, originalSession);
        saveAs(blob, record.media.name);
    });
    const saveAsset = (record = current) => record && run("save", async (controller, originalSession) => {
        if (!useAssetStore.getState().hydrated) throw new Error("素材库尚未恢复，请稍后重试");
        await readExtractedVideo(record, controller.signal);
        await updateVideoReferenceRetention(record.media.referenceId!, "keep", controller.signal);
        validate(controller, originalSession);
        if (useAssetStore.getState().assets.some((asset) => asset.kind === "video" && asset.metadata?.extractionId === record.id)) { message.info("该视频已在我的资产中"); return; }
        const origin = record.media.source;
        await useAssetStore.getState().addAssetPersisted({
            kind: "video", title: origin?.clip ? record.media.name.replace(/\.mp4$/i, "") : origin?.title || record.media.name, coverUrl: "", tags: [videoImportPlatformName(origin?.platform || "other")],
            source: origin?.sourceUrl, metadata: { extractionId: record.id, videoImport: origin, referenceId: record.media.referenceId },
            data: { ...record.media, width: record.media.width || 0, height: record.media.height || 0 },
        });
        validate(controller, originalSession);
        message.success("已保存到我的资产并保留素材");
    });
    const handoff = (tool: ExtractionTarget, record = current) => {
        if (!record || request.current) return;
        const state = useVideoWorkbenchStore.getState();
        const blocked = extractionTargetError(tool, state);
        if (blocked) { setError(blocked); return; }
        const previous = state.drafts[tool];
        const perform = () => run("handoff", async (controller, originalSession) => {
            await sendExtractionToWorkbench(record, tool, previous, controller.signal);
            validate(controller, originalSession);
            navigate(`/video/${tool}`);
        });
        if (hasExtractionTargetDraft(tool, previous)) {
            handoffDialog.current = modal.confirm({
                title: `新建${extractionTargets.find((item) => item.key === tool)?.label}草稿？`,
                content: `将带入「${record.media.name}」，并清空目标工具当前草稿中的素材、设置、分析和结果。历史任务与已保存资产保留。`,
                okText: "新建草稿", cancelText: "取消", onOk: perform,
            });
        } else void perform();
    };
    const saveClip = (name: string, range: [number, number]) => current && run("clip", async (controller, originalSession) => {
        await saveExtractionClip(current, name, range, controller.signal, editing);
        validate(controller, originalSession);
        setEditing(undefined);
        setEditorVersion((version) => version + 1);
        message.success(editing ? "片段调整已保存" : "片段已保存");
    });
    const showClip = (clip: VideoExtractionClip) => run("preview", async (controller, originalSession) => {
        await readExtractedVideo(clipExtraction(clip), controller.signal);
        const url = await resolveMediaUrl(clip.media.storageKey);
        validate(controller, originalSession);
        setClipPreview({ id: clip.id, url, title: clip.media.name.replace(/\.mp4$/i, ""), error: "" });
    });
    const removeClip = (clip: VideoExtractionClip) => {
        modal.confirm({
            title: `移除「${clip.media.name.replace(/\.mp4$/i, "")}」？`, content: "已保存资产及已带入制作的片段保留。", okText: "移除", cancelText: "取消",
            onOk: () => run("remove-clip", async (controller, originalSession) => {
                await history.removeClip(userId, current!.id, clip, () => validate(controller, originalSession));
                if (editing?.id === clip.id) setEditing(undefined);
            }),
        });
    };
    const remove = () => current && modal.confirm({
        title: "移除此提取记录？", content: "将移除此视频及其片段记录；已有草稿、资产和素材保留设置不变。", okText: "移除", cancelText: "取消",
        onOk: () => run("remove", async (controller, originalSession) => {
            validate(controller, originalSession);
            await useVideoExtractionStore.getState().remove(userId, current.id);
        }),
    });
    const ready = Boolean(current && preview.id === current.id && preview.url && !preview.error);
    const locked = Boolean(busy) || !session || !userId || !history.hydrated || Boolean(history.error);
    return (
        <main className="h-full min-h-0 flex-1 overflow-y-auto" style={{ background: colors.colorBgLayout, color: colors.colorText }}>
            <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h1 className="flex items-center gap-2 text-xl font-semibold"><Link2 size={22} />视频提取</h1>
                    <Button type="text" icon={<FolderPlus size={16} />} onClick={() => navigate("/assets")}>我的资产</Button>
                </div>
                <section className="space-y-3" aria-label="提取视频">
                    <Input.TextArea aria-label="视频分享链接" placeholder="粘贴视频分享链接或分享文案" autoSize={{ minRows: 3, maxRows: 6 }} value={text} disabled={locked} onChange={(event) => setText(event.target.value)} />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-xs" style={{ color: colors.colorTextSecondary }}>原视频上限 300MB · 链接将发送至第三方解析服务，仅提取公开可访问的视频</div>
                        <div className="flex items-center gap-2">
                            {(busy === "extract" || busy === "clip") && <Button icon={<X size={15} />} onClick={() => request.current?.abort()}>取消{busy === "clip" ? "裁剪" : ""}</Button>}
                            <Button type="primary" icon={<Link2 size={16} />} loading={busy === "extract"} disabled={busy !== "extract" && (locked || !text.trim())} onClick={() => void extract()}>提取视频</Button>
                        </div>
                    </div>
                    {!session && <div className="flex items-center gap-3 text-sm"><span>请登录后提取视频</span><UserStatusActions accountOnly /></div>}
                    {history.error && <Alert type="error" showIcon title={history.error} action={<Button size="small" onClick={() => void history.load(userId)}>重试</Button>} />}
                    {error && <Alert type="error" showIcon title={error} closable onClose={() => setError("")} />}
                    {busy === "clip" && <div role="status" className="flex items-center gap-2 text-sm" style={{ color: colors.colorTextSecondary }}><Spin size="small" />正在裁剪并保存片段…</div>}
                </section>
                <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
                    <section className="min-w-0 space-y-4" aria-label="提取结果">
                        <div ref={editor}>
                            {busy === "extract" ? <div className="flex min-h-80 w-full items-center justify-center rounded-md sm:aspect-video" style={{ background: colors.colorFillAlter }} aria-busy><ExtractionProgress stage={stage} /></div> :
                                ready ? <ExtractionPlayer key={`${current.id}:${editing?.id || "new"}:${editorVersion}`} url={preview.url} durationMs={current.media.durationMs} disabled={locked} busy={busy === "clip"} editing={editing} onSave={(name, range) => void saveClip(name, range)} onCancelEdit={() => busy === "clip" ? request.current?.abort() : setEditing(undefined)} onError={() => setPreview({ id: current.id, url: "", error: "视频播放失败，请重新提取或下载原视频后检查" })} /> :
                                    <div className="flex aspect-video max-h-[60dvh] w-full items-center justify-center rounded-md" style={{ background: colors.colorFillAlter }}>{current && preview.id !== current.id ? <Spin /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={current ? preview.error || "视频不可用" : "暂无提取视频"} />}</div>}
                        </div>
                        {current && <>
                            <div className="space-y-2">
                                <div className="flex min-w-0 items-start gap-2"><Tag>{videoImportPlatformName(source?.platform || "other")}</Tag><h2 className="min-w-0 break-words text-base font-medium">{source?.title || current.media.name}</h2></div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: colors.colorTextSecondary }}>
                                    {source?.author && <span>作者：{source.author}</span>}
                                    <span>{current.media.durationMs ? formatDuration(current.media.durationMs) : "时长未识别"}</span>
                                    <span>原视频 {formatBytes(current.originalBytes)}</span>
                                    {Boolean(current.media.width && current.media.height) && <span>{current.media.width} × {current.media.height}</span>}
                                </div>
                                {source && <div className="break-all text-xs" style={{ color: colors.colorTextTertiary }}>来源：{source.sourceUrl}</div>}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <Button icon={<Download size={15} />} disabled={locked} loading={busy === "download"} onClick={() => void download()}>下载原视频</Button>
                                <Button icon={<FolderPlus size={15} />} disabled={locked || !ready || saved} loading={busy === "save"} onClick={() => void saveAsset()}>{saved ? "已保存到资产" : "保存到我的资产"}</Button>
                                <Dropdown trigger={["click"]} disabled={locked || !ready} menu={{ items: extractionTargets.map((item) => ({ ...item, icon: <ArrowRight size={14} /> })), onClick: ({ key }) => handoff(key as ExtractionTarget) }}>
                                    <Button type="primary" icon={<ArrowRight size={15} />} disabled={locked || !ready} loading={busy === "handoff"}>用于制作<ChevronDown size={14} /></Button>
                                </Dropdown>
                                <Button icon={<RefreshCw size={15} />} disabled={locked || !source} onClick={() => void extract(source?.sourceUrl)}>重新提取</Button>
                                <Button type="text" danger icon={<Trash2 size={15} />} disabled={locked} onClick={remove} aria-label="移除提取记录" title="移除提取记录" />
                            </div>
                            <VideoReferenceRetention key={current.id} media={current.media} disabled={locked || saved || Boolean(current.clips?.some((clip) => assets.some((asset) => asset.metadata?.extractionId === clip.id)))} />
                            <section aria-label="已保存的视频片段" className="space-y-3 border-t pt-4" style={{ borderColor: colors.colorBorderSecondary }}>
                                <h2 className="flex items-center gap-2 text-sm font-medium"><Scissors size={16} />视频片段 <span style={{ color: colors.colorTextSecondary }}>{current.clips?.length || 0}</span></h2>
                                {!current.clips?.length ? <p className="text-sm" style={{ color: colors.colorTextSecondary }}>暂无片段</p> :
                                    <ul className="divide-y" style={{ borderColor: colors.colorBorderSecondary }}>
                                        {current.clips.map((clip) => {
                                            const record = clipExtraction(clip);
                                            const clipSaved = assets.some((asset) => asset.kind === "video" && asset.metadata?.extractionId === clip.id);
                                            return <li key={clip.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-3" style={{ borderColor: colors.colorBorderSecondary }}>
                                                <div className="min-w-0 flex-1 basis-44">
                                                    <div className="break-words text-sm font-medium">{clip.media.name.replace(/\.mp4$/i, "")}</div>
                                                    <div className="mt-1 text-xs tabular-nums" style={{ color: colors.colorTextSecondary }}>{clip.start.toFixed(2)}–{clip.end.toFixed(2)} 秒 · {(clip.end - clip.start).toFixed(2)} 秒 · {formatBytes(clip.media.bytes)}</div>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-1">
                                                    <Tooltip title="预览片段"><Button type="text" icon={<Play size={16} />} aria-label={`预览片段 ${clip.media.name}`} disabled={locked} onClick={() => void showClip(clip)} /></Tooltip>
                                                    <Tooltip title="调整范围或名称"><Button type="text" icon={<Pencil size={16} />} aria-label={`调整片段 ${clip.media.name}`} disabled={locked || !ready} onClick={() => { setEditing(clip); editor.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }} /></Tooltip>
                                                    <Tooltip title="下载片段"><Button type="text" icon={<Download size={16} />} aria-label={`下载片段 ${clip.media.name}`} disabled={locked} onClick={() => void download(record)} /></Tooltip>
                                                    <Tooltip title={clipSaved ? "已保存到我的资产" : "保存到我的资产"}><Button type="text" icon={<FolderPlus size={16} />} aria-label={`保存片段 ${clip.media.name}`} disabled={locked || clipSaved} onClick={() => void saveAsset(record)} /></Tooltip>
                                                    <Dropdown trigger={["click"]} disabled={locked} menu={{ items: extractionTargets.map((item) => ({ ...item, icon: <ArrowRight size={14} /> })), onClick: ({ key }) => handoff(key as ExtractionTarget, record) }}><Button size="small" icon={<ArrowRight size={14} />} disabled={locked}>用于制作<ChevronDown size={13} /></Button></Dropdown>
                                                    <Tooltip title="移除片段"><Button type="text" danger icon={<Trash2 size={15} />} aria-label={`移除片段 ${clip.media.name}`} disabled={locked} onClick={() => removeClip(clip)} /></Tooltip>
                                                </div>
                                            </li>;
                                        })}
                                    </ul>}
                            </section>
                        </>}
                    </section>
                    <aside className="min-w-0 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0" style={{ borderColor: colors.colorBorderSecondary }}>
                        <h2 className="mb-3 text-sm font-medium">提取记录 <span style={{ color: colors.colorTextSecondary }}>{records.length || ""}</span></h2>
                        {!history.hydrated ? <Spin size="small" /> : !records.length ? <p className="text-sm" style={{ color: colors.colorTextSecondary }}>暂无记录</p> :
                            <div className="space-y-1">{records.map((record) => <button key={record.id} type="button" disabled={Boolean(busy)} onClick={() => setSelected(record.id)} className="w-full min-w-0 rounded p-3 text-left transition hover:opacity-80" style={{ background: record.id === current?.id ? colors.controlItemBgActive : "transparent" }} aria-current={record.id === current?.id ? "true" : undefined}>
                                <div className="break-words text-sm">{record.media.source?.title || record.media.name}</div>
                                <div className="mt-1 text-xs" style={{ color: colors.colorTextSecondary }}>{videoImportPlatformName(record.media.source?.platform || "other")} · {formatBytes(record.originalBytes)}</div>
                                <div className="mt-1 text-xs" style={{ color: colors.colorTextTertiary }}>{new Date(record.createdAt).toLocaleString()}</div>
                            </button>)}</div>}
                    </aside>
                </div>
            </div>
            <Modal title={clipPreview.title} open={Boolean(clipPreview.id)} footer={null} destroyOnHidden onCancel={() => setClipPreview({ id: "", title: "", url: "", error: "" })}>
                {clipPreview.error ? <Alert type="error" showIcon title={clipPreview.error} /> : clipPreview.url && <video key={clipPreview.id} src={clipPreview.url} aria-label="片段预览" controls playsInline className="max-h-[65dvh] w-full object-contain" onError={() => setClipPreview((previous) => ({ ...previous, error: "片段无法播放，请重新裁剪或下载检查" }))} />}
            </Modal>
        </main>
    );
}
