import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, App, Button, Checkbox, Collapse, Dropdown, Empty, Modal, Segmented, Select, theme } from "antd";
import { useConfigStore, resolveEffectiveConfig, modelOptionName, selectableModelsByCapability } from "@/stores/use-config-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useUserStore } from "@/stores/use-user-store";
import { emptyVideoDraft } from "@/types/video-workbench";
import { isWan30, videoProfile } from "@/lib/video-capabilities";
import { publicServiceText, uploadReplicateReference } from "@/services/api/replicate";
import { storeWorkerResult, uploadWorkerMedia } from "@/services/api/video-worker";
import { VIDEO_ACTIVE_POLL_INTERVAL_MS } from "@/services/api/video";
import { archiveReplacementJob, createReplacementJob, generateReplacementParts, listReplacementJobs, pauseReplacementJob, quoteReplacementPart, repriceReplacementJob, retryReplacementPart, reviewReplacementJob, startReplacementJob, type ReplacementJob } from "@/services/api/replacement-jobs";
import { contentReplacementPrompt } from "./content-replace-prompt";
import { replacementDurationSummary } from "./replacement-summary";
import { ReplacementCaptionEditor } from "./replacement-caption-editor";
import { ReplacementSegmentPlayer } from "./replacement-segment-player";
import { useVideoWorkbench } from "./use-video-workbench";
import { UserStatusActions } from "@/components/layout/user-status-actions";

const worker = { url: "/api/v1/video-worker", token: "" };
const wanReplace = "wan-video/wan-2.2-animate-replace";
const headSwapModel = "wavespeed-ai/video-head-swap";
const preferred = ["wan30-720p", "grok-imagine-video-1.5-preview", "seedance-2.0-mini", "h3video-768", "h3video-2k"];
const labels = { planning: "分析中", ready: "待确认费用", preview: "预览待确认", running: "处理中", paused: "已暂停", completed: "已合成" };
const modelLabel = (name: string) => name === headSwapModel ? "智能换脸" : name === wanReplace ? "Wan 2.2 整人替换" : modelOptionName(name);
const jobStep = (job: ReplacementJob) => job.planned && job.status === "ready" && !job.parts?.some((part) => part.submitted || part.input)
    ? "分段计划已就绪，尚未切出视频或开始生成" : job.step;

export function ReplacementBatchPanel({ subtitleBlocked, workspace, onOpenWorkspace }: { subtitleBlocked: string; workspace: HTMLElement | null; onOpenWorkspace: () => void }) {
    const wb = useVideoWorkbench("content-replace");
    const draft = useVideoWorkbenchStore((s) => s.drafts["content-replace"]);
    const d = { ...emptyVideoDraft("content-replace"), ...draft };
    const headSwap = d.replacementModel === "headswap";
    const token = useUserStore((s) => s.token);
    const hydrated = useVideoWorkbenchStore((s) => s.hydrated);
    const savedConfig = useConfigStore((s) => s.config);
    const publicSettings = useConfigStore((s) => s.publicSettings);
    const config = resolveEffectiveConfig({ ...savedConfig, channelMode: "remote" }, publicSettings);
    const { token: colors } = theme.useToken();
    const { modal, message } = App.useApp();
    const [model, setModel] = useState("");
    const [resolution, setResolution] = useState("");
    const [jobs, setJobs] = useState<ReplacementJob[]>([]);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyTab, setHistoryTab] = useState<"recent" | "archived">("recent");
    const [archiving, setArchiving] = useState("");
    const [captionEditorJobId, setCaptionEditorJobId] = useState("");
    const [previewChoice, setPreviewChoice] = useState<{ jobId: string; result: string } | null>(null);
    const [previewMedia, setPreviewMedia] = useState<Awaited<ReturnType<typeof storeWorkerResult>> | null>(null);
    const [segmentMedia, setSegmentMedia] = useState<Awaited<ReturnType<typeof storeWorkerResult>> | null>(null);
    const [segmentLoadError, setSegmentLoadError] = useState("");
    const [segmentReload, setSegmentReload] = useState(0);
    const [previewLoadError, setPreviewLoadError] = useState("");
    const [previewReload, setPreviewReload] = useState(0);
    const [segment, setSegment] = useState(0);
    const [selectedParts, setSelectedParts] = useState<number[]>([]);
    const [view, setView] = useState<"segments" | "full">("segments");
    const [sourceLoadError, setSourceLoadError] = useState("");
    const [sourceReload, setSourceReload] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const submitting = useRef(false);
    const selectionLoaded = useRef("");
    const attemptedResult = useRef("");
    const previewRevision = useRef(0);
    const pendingRequest = useRef<{ key: string; id: string; source?: string; image?: string } | undefined>(undefined);
    const candidates = selectableModelsByCapability(config, "video")
        .filter((name) => name.startsWith("remote::") && preferred.includes(modelOptionName(name).toLowerCase()))
        .filter((name) => { const p = videoProfile({ ...config, channelMode: "remote" }, name); return p.maxVideos > 0 && p.maxImages > 0; })
        .sort((a, b) => preferred.indexOf(modelOptionName(a).toLowerCase()) - preferred.indexOf(modelOptionName(b).toLowerCase()));
    const selected = headSwap ? headSwapModel : candidates.includes(model) || model === wanReplace ? model : candidates[0] || wanReplace;
    const subtitleError = subtitleBlocked || (d.replaceSubtitles && !isWan30(selected) ? "当前模型不支持联合去字幕，请关闭「去除原字幕」，或先使用云端硬字幕去除工具处理原片。" : "");
    const profile = videoProfile({ ...config, channelMode: "remote" }, selected);
    const durations = selected === headSwapModel ? ["15"] : selected === wanReplace ? ["10"] : profile.seconds.filter((v) => Number(v) > 0.5 && (!isWan30(selected) || Number(v) <= 30)).sort((a, b) => Number(b) - Number(a));
    const sizes = selected === wanReplace || headSwap ? ["720", "480"] : profile.resolutions;
    const duration = durations[0];
    const size = sizes.includes(resolution) ? resolution : sizes[0];
    const source = d.media.find((m) => m.role === "reference" && m.kind === "video");
    const image = d.media.find((m) => m.role === "model" && m.kind === "image");
    const segmentLimit = Math.min(15, Number(duration));
    const requiresPreview = Boolean(source?.durationMs && source.durationMs > segmentLimit * 1000);
    const refresh = async () => setJobs((await listReplacementJobs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    useEffect(() => {
        setJobs([]);
        setHistoryOpen(false);
        setCaptionEditorJobId("");
        if (!token) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const controller = new AbortController();
        const poll = async () => {
            try {
                const value = await listReplacementJobs(controller.signal);
                if (!disposed) setJobs(value.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
            } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "读取任务失败"); }
            if (!disposed) timer = setTimeout(poll, VIDEO_ACTIVE_POLL_INTERVAL_MS);
        };
        void poll();
        return () => { disposed = true; controller.abort(); clearTimeout(timer); };
    }, [token]);
    const currentJob = jobs.find((job) => job.id === d.replacementJobId && !job.archived);
    const currentArchived = jobs.some((job) => job.id === d.replacementJobId && job.archived);
    useEffect(() => { if (currentArchived) selectJob(); }, [currentArchived]);
    const historyJobs = jobs.filter((job) => Boolean(job.archived) === (historyTab === "archived"));
    const activeCount = jobs.filter((job) => job.status === "running" || job.status === "planning" || job.captionStatus === "recognizing" || job.captionStatus === "rendering").length;
    const captionEditorJob = jobs.find((job) => job.id === captionEditorJobId);
    const selectedResult = currentJob ? (previewChoice?.jobId === currentJob.id ? previewChoice.result : currentJob.captionResult || currentJob.result) : undefined;
    const fullResult = d.replacementResultKey === selectedResult ? d.final : null;
    const previewPath = currentJob?.previewReady ? currentJob.previewResult : undefined;
    const needsPreviewApproval = Boolean(currentJob?.previewRequired && currentJob.previewReady && !currentJob.previewApproved);
    const selectedPart = currentJob?.parts?.[segment];
    const hasPartResult = (job: ReplacementJob, index: number) => Boolean(job.parts?.[index]?.result || (index === 0 && job.previewReady && job.previewResult));
    const selectableParts = currentJob?.parts?.map((part, index) => index).filter((index) => !hasPartResult(currentJob, index)) || [];
    const selectedCredits = currentJob?.parts?.reduce((sum, part, index) => selectedParts.includes(index) && !part.submitted && !part.validated && !hasPartResult(currentJob, index) ? sum + part.credits : sum, 0) || 0;
    const selectedPending = currentJob?.parts?.some((part, index) => selectedParts.includes(index) && (!part.validated || !hasPartResult(currentJob, index))) || false;
    useEffect(() => {
        setSegment(0);
        setView("segments");
        if (selectionLoaded.current === currentJob?.id) return;
        selectionLoaded.current = currentJob?.id || "";
        setSelectedParts(currentJob?.selectionMode
            ? (currentJob.selectedParts || []).filter((index) => !hasPartResult(currentJob, index))
            : currentJob?.parts?.map((part, index) => !hasPartResult(currentJob, index) ? index : -1).filter((index) => index >= 0).slice(0, 1) || []);
    }, [currentJob?.id]);
    useEffect(() => { setSelectedParts((items) => items.filter((index) => currentJob ? !hasPartResult(currentJob, index) : false)); }, [currentJob?.parts, currentJob?.previewReady, currentJob?.previewResult]);
    useEffect(() => { if (selectedResult) setView("full"); }, [selectedResult]);
    useEffect(() => {
        let cancelled = false;
        setSourceLoadError("");
        if (hydrated && token && currentJob && !d.replacementSource && !currentJob.result) {
            const id = currentJob.id;
            void storeWorkerResult(worker, currentJob.source).then((file) => {
                if (!cancelled && useVideoWorkbenchStore.getState().drafts["content-replace"]?.replacementJobId === id)
                    useVideoWorkbenchStore.getState().patchDraft("content-replace", { replacementSource: file });
            }).catch((e) => { if (!cancelled) setSourceLoadError(publicServiceText(e instanceof Error ? e.message : "原片载入失败")); });
        }
        return () => { cancelled = true; };
    }, [hydrated, currentJob?.id, currentJob?.result, d.replacementSource, token, sourceReload]);
    useEffect(() => {
        let cancelled = false;
        setPreviewMedia(null);
        setPreviewLoadError("");
        if (token && previewPath) void storeWorkerResult(worker, previewPath).then((file) => { if (!cancelled) setPreviewMedia(file); }).catch((e) => { if (!cancelled) setPreviewLoadError(publicServiceText(e instanceof Error ? e.message : "预览载入失败")); });
        return () => { cancelled = true; };
    }, [previewPath, token, previewReload]);
    useEffect(() => {
        let cancelled = false;
        setSegmentMedia(null);
        setSegmentLoadError("");
        if (token && selectedPart?.result) void storeWorkerResult(worker, selectedPart.result).then((file) => { if (!cancelled) setSegmentMedia(file); }).catch((e) => { if (!cancelled) setSegmentLoadError(publicServiceText(e instanceof Error ? e.message : "片段结果载入失败")); });
        return () => { cancelled = true; };
    }, [token, selectedPart?.result, segmentReload]);
    useEffect(() => {
        if (!hydrated || !currentJob || !selectedResult || !token || captionEditorJobId) return;
        const key = `${token}:${currentJob.id}:${selectedResult}`;
        if (attemptedResult.current === key || (d.replacementResultKey === selectedResult && d.final)) return;
        attemptedResult.current = key;
        void showResult(currentJob, true, selectedResult);
    }, [hydrated, token, currentJob?.id, selectedResult, captionEditorJobId, d.replacementResultKey, d.final]);
    useEffect(() => () => { previewRevision.current++; }, [token]);
    const selectJob = (job?: ReplacementJob) => {
        previewRevision.current++;
        attemptedResult.current = "";
        setPreviewChoice(null);
        setError("");
        setBusy(false);
        setCaptionEditorJobId("");
        useVideoWorkbenchStore.getState().patchDraft("content-replace", {
            replacementJobId: job?.id, replacementResultKey: undefined, replacementSource: undefined, final: null, edited: null, video: null, activeRecord: undefined,
        });
    };
    const openJob = async (job: ReplacementJob) => {
        selectJob(job);
        setHistoryOpen(false);
        onOpenWorkspace();
        const result = job.captionResult || job.result;
        if (result) { await showResult(job, false, result); return; }
    };
    const setArchived = async (job: ReplacementJob, archived: boolean) => {
        if (archiving) return;
        setArchiving(job.id);
        try {
            const updated = await archiveReplacementJob(job.id, archived);
            setJobs((items) => items.map((item) => item.id === updated.id ? updated : item));
            if (archived && useVideoWorkbenchStore.getState().drafts["content-replace"]?.replacementJobId === job.id) selectJob();
            message.success(archived ? "已归档，可在历史任务的已归档列表中找回" : "已取消归档，可打开任务继续处理");
        } catch (e) { message.error(e instanceof Error ? e.message : "归档操作失败"); }
        finally { setArchiving(""); }
    };
    const canArchive = (job: ReplacementJob) => !["planning", "running"].includes(job.status) && !["recognizing", "rendering"].includes(job.captionStatus || "");
    const prepare = async () => {
        if (submitting.current || subtitleError || !source || !image || !duration || !size) return;
        submitting.current = true; setBusy(true); setError("");
        try {
            const key = JSON.stringify([source, image, selected, size, duration, d.instructions, d.replaceSubtitles, d.regenerateSubtitles, d.subtitleSize, d.subtitleColor]);
            if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: crypto.randomUUID() };
            const pending = pendingRequest.current;
            pending.source ||= await uploadWorkerMedia(worker, source);
            pending.image ||= await uploadReplicateReference(image);
            const created = await createReplacementJob({ id: pending.id, source: pending.source, image: pending.image,
                model: modelOptionName(selected), resolution: size.replace(/p$/i, ""), seconds: duration,
                prompt: contentReplacementPrompt("person", d.instructions, d.replaceSubtitles), subtitles: d.replaceSubtitles, regenerateSubtitles: d.replaceSubtitles && d.regenerateSubtitles === true,
                subtitleSize: d.subtitleSize, subtitleColor: d.subtitleColor, previewRequired: requiresPreview });
            useVideoWorkbenchStore.getState().patchDraft("content-replace", { replacementJobId: created.id, replacementResultKey: undefined, replacementSource: source, final: null });
            onOpenWorkspace();
            setPreviewChoice(null);
            pendingRequest.current = undefined;
            await refresh();
        } catch (e) { setError(e instanceof Error ? e.message : "整片分析失败"); }
        finally { submitting.current = false; setBusy(false); }
    };
    const start = (job: ReplacementJob) => {
        const approvePreview = job.previewRequired && job.previewReady && !job.previewApproved;
        const previewCredits = job.parts?.[0]?.credits || 0;
        const remainingCredits = job.parts?.filter((part) => !part.validated).reduce((sum, part) => sum + part.credits, 0) || 0;
        const content = approvePreview
            ? `继续处理剩余 ${job.parts?.filter((part) => !part.validated).length || 0} 段，预计 ${remainingCredits} 点；整片预计共 ${job.credits} 点。已完成的预览段会直接用于最终合并，不会重做。`
            : job.previewRequired && job.planned && !job.previewReady
              ? `本次只生成第 1 段预览，预计 ${previewCredits} 点；整片预计共 ${job.credits} 点。其余片段要等你确认预览效果后才会生成。`
              : job.planned ? `${modelLabel(job.model)}，${replacementDurationSummary(job)}，整片预计 ${job.credits} 点。按段扣费，不自动重试或切换模型。${job.subtitles ? job.regenerateSubtitles ? "云端同时去除原字幕，字幕稿会在无字幕成片完成后另行识别与校对。" : "云端同时去除原字幕并保留原音轨。" : "未启用去字幕，原字幕可能被模型重画。"}` : "继续分析视频并计算费用，此步骤不调用收费生成模型。";
        modal.confirm({
            title: approvePreview ? "预览效果满意，继续吗？" : job.previewRequired && !job.previewReady ? "先生成一段预览" : job.planned ? "确认本次处理费用" : "恢复视频分析",
            content: `${content} 字幕识别、存储等外部服务费用另计。`,
            okText: approvePreview ? "确认并处理剩余片段" : job.previewRequired && !job.previewReady ? "生成预览" : job.status === "ready" ? "开始处理" : "恢复处理",
            onOk: async () => { try { await startReplacementJob(job, approvePreview); setPreviewChoice(null); useVideoWorkbenchStore.getState().patchDraft("content-replace", { replacementJobId: job.id }); await refresh(); } catch (e) { message.error(e instanceof Error ? e.message : "启动失败"); throw e; } },
        });
    };
    const retryPart = async (job: ReplacementJob, part: number) => {
        try {
        const { credits } = await quoteReplacementPart(job.id, part);
        modal.confirm({
        title: `重做第 ${part + 1} 段`,
        content: `将重新生成这一段，增加 ${credits} 算力点预算；其他成功片段会保留。原任务的退款以账单为准。`,
        okText: "准备重做这一段",
        onOk: async () => { try { await retryReplacementPart(job, part, credits); await refresh(); } catch (e) { message.error(e instanceof Error ? e.message : "重做准备失败"); throw e; } },
        });
        } catch (e) { message.error(e instanceof Error ? e.message : "报价失败"); }
    };
    const generateSelected = async (job: ReplacementJob) => {
        if (!selectedParts.length || (selectedCredits <= 0 && !selectedPending)) return;
        modal.confirm({
            title: `生成所选 ${selectedParts.length} 段`,
            content: `本次预计扣除 ${selectedCredits} 点。只处理勾选的片段，其他片段保持不变；已生成的片段不会重复收费。`,
            okText: "确认生成",
            onOk: async () => { try { await generateReplacementParts(job, selectedParts, selectedCredits); await refresh(); } catch (e) { message.error(e instanceof Error ? e.message : "生成失败"); throw e; } },
        });
    };
    const showResult = async (job: ReplacementJob, automatic = false, result = job.result) => {
        if (!result) return;
        const revision = ++previewRevision.current;
        if (!automatic) {
            setPreviewChoice({ jobId: job.id, result });
            useVideoWorkbenchStore.getState().patchDraft("content-replace", { replacementJobId: job.id });
        }
        attemptedResult.current = `${token}:${job.id}:${result}`;
        setBusy(true);
        try {
            const final = await storeWorkerResult(worker, result);
            const original = await storeWorkerResult(worker, job.source);
            if (revision !== previewRevision.current || useVideoWorkbenchStore.getState().drafts["content-replace"]?.replacementJobId !== job.id) return;
            useVideoWorkbenchStore.getState().patchDraft("content-replace", { final, replacementResultKey: result, replacementSource: original });
            if (!automatic) message.success(result === job.captionResult ? "已载入带字幕版本" : job.subtitleOutput === "editable" && result === job.result ? "已载入无字幕整片，请检查人物与接缝" : "已载入整片结果，请检查人物、字幕与接缝");
        } catch (e) { if (revision === previewRevision.current) setError(`结果载入失败，可点击查看完整视频重试：${e instanceof Error ? e.message : "读取失败"}`); }
        finally { if (revision === previewRevision.current) setBusy(false); }
    };
    return <div className="space-y-3" aria-label="人物替换生成">
        {requiresPreview && (source?.durationMs || 0) <= 15_000 && <Alert showIcon type="info" title={`视频超过当前模型的单段 ${segmentLimit} 秒范围，需要分段。`} description="先查看整片费用，再生成第一段预览。确认效果后才处理其余片段并合并。" />}
        <label className="block space-y-1 text-sm">
            <span>清晰度</span>
            <Select className="w-full" aria-label="清晰度" value={size} disabled={busy || currentJob?.status === "running" || currentJob?.status === "planning"} options={sizes.map((v) => ({ value: v, label: /^\d+p?$/.test(v) ? `${v.replace(/p$/i, "")}p` : v }))} onChange={(value) => { setResolution(value); selectJob(); }} />
        </label>
        {!headSwap && <Collapse size="small" items={[{ key: "model", label: `高级设置 · ${modelLabel(selected)}`, children: <label className="block space-y-2 text-sm">
            <span>生成模型</span>
            <Select className="w-full" aria-label="生成模型" value={selected} disabled={busy || currentJob?.status === "running" || currentJob?.status === "planning"}
                options={[...candidates.map((v) => ({ value: v, label: modelLabel(v) })), { value: wanReplace, label: modelLabel(wanReplace) }]}
                onChange={(v) => { setModel(v); setResolution(""); selectJob(); }} />
            <span className="block text-xs" style={{ color: colors.colorTextSecondary }}>只调用所选模型，系统根据其支持的时长自动分段。</span>
        </label> }]} />}
        {subtitleError && <Alert type="warning" showIcon title={subtitleError} />}
        {!token ? <div className="flex items-center justify-between gap-2 text-sm"><span>登录后查看费用并生成</span><UserStatusActions accountOnly /></div> : <Button block type="primary" loading={busy || currentJob?.status === "planning"} disabled={!hydrated || !source || !image || !duration || !size || Boolean(subtitleError) || currentJob?.status === "running" || currentJob?.status === "planning"} onClick={() => void prepare()}>{requiresPreview ? "分析分段并查看费用" : "查看费用并生成"}</Button>}
        {!source || !image ? <p className="m-0 text-xs" style={{ color: colors.colorTextSecondary }}>{!source ? "请先上传原视频" : "请上传人物参考图"}</p> : (!duration || !size) && <Alert type="warning" title="当前模型尚未配置可用的时长或清晰度，请在高级设置中切换模型。" />}
        {error && <Alert type="warning" showIcon title={publicServiceText(error)} closable onClose={() => setError("")} />}
        <div className="flex items-center justify-between gap-2">
            <span className="text-sm">{currentJob ? "当前任务" : "暂无当前任务"}</span>
            <Button type="text" size="small" onClick={() => setHistoryOpen(true)}>历史任务（{jobs.length}）{activeCount > 0 ? ` · ${activeCount} 项处理中` : ""}</Button>
        </div>
        {!currentJob && <p className="m-0 text-xs" style={{ color: colors.colorTextSecondary }}>上传素材创建新任务，或从历史任务中打开已有任务。</p>}
        {currentJob && <div className="space-y-2 border-t pt-3" style={{ borderColor: colors.colorBorderSecondary }}>
            <div className="text-sm">{modelLabel(currentJob.model)} · {labels[currentJob.status]}</div>
            <div className="text-xs" style={{ color: colors.colorTextSecondary }}>{jobStep(currentJob)}</div>
            <Button block onClick={onOpenWorkspace}>查看分段与预览 →</Button>
        </div>}
        {workspace && createPortal((currentJob ? [currentJob] : []).map((job) => <div key={job.id} className="flex flex-col gap-4" aria-label="分段与效果预览">
            <div className="order-1 text-sm">{modelLabel(job.model)} · {labels[job.status]}</div>
            <div className="order-1"><Dropdown menu={{ items: [{ key: "archive", label: "归档任务", disabled: !canArchive(job), onClick: () => void setArchived(job, true) }, { key: "close", label: "收起当前任务", onClick: () => selectJob() }] }} placement="bottomRight"><Button size="small" type="text">任务操作⌄</Button></Dropdown></div>
            <div className="order-1 text-sm" style={{ color: colors.colorTextSecondary }}>{jobStep(job)} · 已生成 {job.parts?.filter((p) => p.validated).length || 0}/{job.parts?.length || 0} 段</div>
            {job.planned && <>
                <div className="order-1 text-sm">整片模型预算 {job.credits} 点 · {job.resolution.replace(/p$/i, "")}p</div>
                <p className="order-1 m-0 text-xs" style={{ color: colors.colorTextSecondary }}>点片段名称试看原片；勾选框决定生成范围。可只生成一段，也可一次勾选多段。生成时才按需切出文件，不会自动处理未勾选片段。</p>
                <Collapse className="order-1" size="small" items={[{ key: "duration", label: "时长与费用说明", children: <div className="space-y-2 text-xs"><div>{replacementDurationSummary(job)}</div><div>原片片段时长与模型输入时长可能不同：不足输入档位的片段会补齐，最终合并时移除补齐部分。请按每段报价确认费用。</div></div> }]} />
            </>}
            {job.parts && job.parts.length > 0 && <>
                <div className="order-3 flex items-center justify-between gap-2"><div className="text-sm font-medium">分段列表 · {job.parts.length} 段</div><div className="flex gap-1"><Button size="small" type="link" onClick={() => setSelectedParts(selectableParts)}>全选未生成</Button><Button size="small" type="link" onClick={() => setSelectedParts([])}>清空</Button></div></div>
                <div className="order-3 grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 2xl:grid-cols-4" aria-label="选择原片片段">
                    {job.parts.map((part, index) => <div key={index} className="space-y-1 rounded-lg border p-3 text-left text-xs"
                        style={{ borderColor: segment === index && view === "segments" ? colors.colorPrimary : colors.colorBorderSecondary, background: segment === index && view === "segments" ? colors.colorPrimaryBg : colors.colorBgContainer }}
                        ><div className="flex items-start gap-2"><Checkbox checked={selectedParts.includes(index)} disabled={hasPartResult(job, index) || job.status === "running"} onChange={(event) => setSelectedParts((items) => event.target.checked ? [...items, index] : items.filter((item) => item !== index))} /><button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setSegment(index); setView("segments"); }}><div className="text-sm font-medium">第 {index + 1} 段 · {(part.end - part.start).toFixed(2)} 秒{hasPartResult(job, index) ? " · 已完成" : ""}</div>
                        <div>{part.start.toFixed(2)}–{part.end.toFixed(2)} 秒</div>
                        <div style={{ color: colors.colorTextSecondary }}>{part.validated && !part.result ? "已生成，待导出" : part.validated ? "已生成" : part.submitted ? "已提交生成" : part.input ? "已切出，待生成" : "已规划，待生成"} · {part.credits} 点</div>
                        </button></div></div>)}
                </div>
                <div className="order-3 flex flex-wrap items-center justify-between gap-2 rounded-lg p-3" style={{ background: colors.colorFillQuaternary }}><div className="text-sm">已选 {selectedParts.length} 段 · 预计 {selectedCredits} 点</div><Button type="primary" disabled={!selectedParts.length || (selectedCredits <= 0 && !selectedPending) || job.status === "running" || job.status === "planning"} onClick={() => void generateSelected(job)}>{selectedPending && selectedCredits === 0 ? "继续处理所选片段" : "生成所选片段"}</Button></div>
                {fullResult && <div className="order-2"><Segmented value={view} onChange={setView} options={[{ value: "segments", label: "分段对照" }, { value: "full", label: "完整视频" }]} /></div>}
                <div className="order-2 grid gap-4 xl:grid-cols-2">
                    <div className="min-w-0 space-y-3 rounded-lg p-3" style={{ background: colors.colorFillQuaternary }}>
                        <div className="text-sm font-medium">{view === "full" ? "完整原视频" : `第 ${segment + 1} 段 · 原片试看`}</div>
                        {d.replacementSource ? view === "full" ? <video controls preload="metadata" src={d.replacementSource.url} className="max-h-[55vh] w-full rounded-lg" /> : selectedPart && <ReplacementSegmentPlayer key={`${d.replacementSource.url}:${segment}`} url={d.replacementSource.url} start={selectedPart.start} end={selectedPart.end} label={`第 ${segment + 1} 段原片`} />
                            : sourceLoadError ? <Alert type="warning" title={sourceLoadError} action={<Button size="small" onClick={() => setSourceReload((value) => value + 1)}>重新载入原片</Button>} /> : <div className="py-12 text-center text-sm">正在载入原片…</div>}
                    </div>
                    <div className="min-w-0 space-y-3 rounded-lg p-3" style={{ background: colors.colorFillQuaternary }}>
                        <div className="text-sm font-medium">{view === "full" ? "完整替换结果" : `第 ${segment + 1} 段 · 替换效果`}</div>
                        {view === "full" && fullResult ? <video controls preload="metadata" src={fullResult.url} className="max-h-[55vh] w-full rounded-lg" />
                            : selectedPart?.result ? segmentLoadError ? <Alert type="warning" title={segmentLoadError} action={<Button size="small" onClick={() => setSegmentReload((value) => value + 1)}>重新载入片段</Button>} /> : segmentMedia ? <><ReplacementSegmentPlayer key={`${segmentMedia.url}:${segment}`} url={segmentMedia.url} start={0} end={segmentMedia.durationMs ? segmentMedia.durationMs / 1000 : selectedPart.end - selectedPart.start} label={`第 ${segment + 1} 段替换效果`} /><Button size="small" onClick={() => void wb.download(segmentMedia)}>下载当前片段</Button></> : <div className="py-12 text-center text-sm">正在载入片段结果…</div>
                            : selectedPart && fullResult ? <ReplacementSegmentPlayer key={`${fullResult.url}:${segment}`} url={fullResult.url} start={selectedPart.start} end={selectedPart.end} label={`第 ${segment + 1} 段替换效果`} />
                            : segment === 0 && previewMedia && selectedPart ? <ReplacementSegmentPlayer key={previewMedia.url} url={previewMedia.url} start={selectedPart.start - selectedPart.inputStart} end={selectedPart.end - selectedPart.inputStart} label="第一段替换预览" />
                            : segment === 0 && previewPath ? previewLoadError ? <Alert type="warning" title={previewLoadError} action={<Button size="small" onClick={() => setPreviewReload((value) => value + 1)}>重新载入预览</Button>} /> : <div className="py-12 text-center text-sm">正在载入预览…</div>
                            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={segment === 0 ? "确认费用并生成第一段后，在这里查看效果" : "先确认第一段效果，其余片段处理并合并后可在这里对照查看"} />}
                    </div>
                </div>
                {view === "segments" && selectedPart && <div className="order-2 text-xs" style={{ color: colors.colorTextSecondary }}>第 {segment + 1} 段原片 {(selectedPart.end - selectedPart.start).toFixed(2)} 秒 · 模型输入 {selectedPart.seconds} 秒 · 该段报价 {selectedPart.credits} 点。播放器只展示有效片段，合并时去除重叠与补齐部分。</div>}
            </>}
            {job.result && <div className="order-4"><Alert type={job.reviewed ? "success" : "info"} title={job.reviewed ? "已人工验收" : "合成完成，效果待验收"} description={job.subtitleOutput === "editable" ? job.regenerateSubtitles ? "无字幕版已保留，请检查人物、口型与接缝；识别稿需校对后再生成带字幕版。" : "无字幕版已保留，请检查人物、口型与接缝；如需字幕，可手动识别后校对。" : "请检查第一帧、转场后人物、无人镜头、口型、字幕与接缝。时间轴校验通过不代表人物或文字正确。"} /></div>}
            {needsPreviewApproval && !job.selectionMode && <div className="order-4 space-y-2">
                <Alert type="info" showIcon title="第一段预览已完成" description="在上方选择第 1 段，对照原片检查替换效果。确认后才会生成其余片段；不满意时可调整参考图或要求后重新开始。" />
                <Button disabled={busy} onClick={() => selectJob()}>不满意，调整素材或要求</Button>
            </div>}
            {job.subtitleOutput === "editable" && job.status === "completed" && <div className="order-4 space-y-2 rounded-md p-2" style={{ background: colors.colorFillQuaternary }}>
                <div className="text-sm font-medium">字幕：{job.captionStatus === "recognizing" ? "识别中" : job.captionStatus === "rendering" ? "合成中" : job.captionStatus === "completed" ? "带字幕版已生成" : job.captionStatus === "draft" ? `${job.captionSegments?.length || 0} 条待校对` : job.captionStatus === "failed" ? "处理未完成，可恢复" : "待识别"}</div>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" onClick={() => { setCaptionEditorJobId(job.id); if (d.replacementResultKey !== job.result) void showResult(job, false, job.result); }} disabled={job.captionStatus === "recognizing" || job.captionStatus === "rendering"}>在线校对字幕</Button>
                    {job.result && <Button size="small" disabled={busy} onClick={() => void showResult(job, false, job.result)}>查看无字幕版</Button>}
                    {job.captionResult && <Button size="small" disabled={busy} onClick={() => void showResult(job, false, job.captionResult)}>查看带字幕版</Button>}
                </div>
                {job.captionError && <div className="text-xs" style={{ color: colors.colorWarningText }}>{job.captionError}</div>}
            </div>}
            {job.error && <div className="order-4"><Alert type="warning" title={publicServiceText(job.error)} /></div>}
            <div className="order-4 flex flex-wrap gap-2">
                {(!job.planned || !job.parts?.length) && (job.status === "ready" || job.status === "preview" || job.status === "paused") && <Button size="small" type={needsPreviewApproval ? "primary" : "default"} disabled={needsPreviewApproval && !previewMedia} onClick={() => start(job)}>{needsPreviewApproval ? "效果满意，继续处理" : job.previewRequired && !job.previewReady ? "确认费用并生成预览" : job.status === "ready" ? "确认费用并开始" : "恢复处理"}</Button>}
                {job.status === "paused" && job.planned && <Button size="small" onClick={() => void repriceReplacementJob(job.id).then(refresh).catch((e) => message.error(e.message))}>刷新剩余费用</Button>}
                {job.status === "running" && <Button size="small" onClick={() => void pauseReplacementJob(job.id).then((v) => message.info(v.message)).catch((e) => message.error(e.message))}>暂停后续处理</Button>}
                {job.status === "paused" && job.parts?.some((p) => !p.validated && p.submitted && !!p.taskId) && <Button size="small" onClick={() => retryPart(job, job.parts!.findIndex((p) => !p.validated && p.submitted && !!p.taskId))}>重做问题片段</Button>}
                {job.result && job.subtitleOutput !== "editable" && <Button size="small" disabled={busy} onClick={() => void showResult(job)}>查看完整视频</Button>}
                {job.previousResults?.map((result, index) => <Button key={result} size="small" disabled={busy} onClick={() => void showResult(job, false, result)}>查看历史版本 {index + 1}</Button>)}
                {job.result && !job.reviewed && <Button size="small" onClick={() => modal.confirm({ title: "确认效果验收通过", content: `已对照检查开头与转场人物、无人镜头、口型和接缝${job.subtitleOutput === "editable" ? "；如需带字幕版，也已校对其文案、样式与时间轴" : "、字幕"}？此操作不会生成或收费。`, onOk: async () => { await reviewReplacementJob(job.id); await refresh(); } })}>标记验收通过</Button>}
                {(job.status === "completed" || job.status === "preview" || job.status === "paused") && job.parts?.some((p) => p.taskId) && <Select<number> aria-label={`重做片段 ${job.id}`} placeholder="重做不满意的片段（另计费）" value={undefined} className="w-full" options={job.parts.flatMap((p, i) => p.taskId ? [{value:i,label:`第 ${i+1} 段 · ${p.start.toFixed(2)}–${p.end.toFixed(2)} 秒`}] : [])} onChange={(index) => void retryPart(job, index)} />}
            </div>
        </div>), workspace)}
        {workspace && d.replacementJobId && !currentJob && createPortal(<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error ? "任务读取失败，请从历史任务重新打开" : "正在读取分段任务…"} />, workspace)}
        <Modal title="历史任务" open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={640}>
            <p className="text-sm" style={{ color: colors.colorTextSecondary }}>打开任务后可查看结果或继续处理。归档保留视频和进度，可随时取消；打开或取消归档不会自动开始生成。</p>
            <Segmented value={historyTab} onChange={setHistoryTab} options={[
                { label: `任务列表（${jobs.filter((job) => !job.archived).length}）`, value: "recent" },
                { label: `已归档（${jobs.filter((job) => job.archived).length}）`, value: "archived" },
            ]} />
            <div className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto">
                {!historyJobs.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={historyTab === "archived" ? "暂无已归档任务" : "暂无任务"} />}
                {historyJobs.map((job) => <div key={job.id} className="space-y-1 border-b pb-3" style={{ borderColor: colors.colorBorderSecondary }}>
                    <div className="text-sm">{modelLabel(job.model)} · {labels[job.status]}{job.id === currentJob?.id ? " · 当前任务" : ""}</div>
                    <div className="text-xs" style={{ color: colors.colorTextSecondary }}>{new Date(job.createdAt).toLocaleString()} · {job.id.slice(0, 8)}</div>
                    <div className="text-xs">{jobStep(job)} · {job.parts?.filter((p) => p.validated).length || 0}/{job.parts?.length || 0} 段</div>
                    {job.error && <div className="text-xs" style={{ color: colors.colorWarningText }}>任务已暂停，打开任务查看原因</div>}
                    <div className="flex gap-2">
                        {!job.archived && <Button size="small" disabled={busy || Boolean(archiving)} onClick={() => void openJob(job)}>打开任务</Button>}
                        <Button size="small" type="text" loading={archiving === job.id} disabled={busy || Boolean(archiving) || !canArchive(job)} onClick={() => void setArchived(job, !job.archived)}>{job.archived ? "取消归档" : "归档"}</Button>
                    </div>
                </div>)}
            </div>
        </Modal>
        {captionEditorJob && <ReplacementCaptionEditor key={captionEditorJob.id} job={captionEditorJob}
            videoUrl={d.replacementResultKey === captionEditorJob.result ? d.final?.url : undefined}
            onClose={() => setCaptionEditorJobId("")}
            onRefresh={refresh}
            onRendered={() => { setCaptionEditorJobId(""); setPreviewChoice(null); void refresh(); }} />}
    </div>;
}
