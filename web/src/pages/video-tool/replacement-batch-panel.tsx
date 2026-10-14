import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Select, theme } from "antd";
import { useConfigStore, resolveEffectiveConfig, modelOptionName, selectableModelsByCapability } from "@/stores/use-config-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useUserStore } from "@/stores/use-user-store";
import { emptyVideoDraft } from "@/types/video-workbench";
import { videoProfile } from "@/lib/video-capabilities";
import { uploadReplicateReference } from "@/services/api/replicate";
import { storeWorkerResult, uploadWorkerMedia } from "@/services/api/video-worker";
import { VIDEO_ACTIVE_POLL_INTERVAL_MS } from "@/services/api/video";
import { createReplacementJob, listReplacementJobs, pauseReplacementJob, quoteReplacementPart, repriceReplacementJob, retryReplacementPart, reviewReplacementJob, startReplacementJob, type ReplacementJob } from "@/services/api/replacement-jobs";
import { contentReplacementPrompt } from "./content-replace-prompt";
import { replacementDurationSummary } from "./replacement-summary";
import { ReplacementCaptionEditor } from "./replacement-caption-editor";

const worker = { url: "/api/v1/video-worker", token: "" };
const wanReplace = "wan-video/wan-2.2-animate-replace";
const preferred = ["wan30-720p", "grok-imagine-video-1.5-preview", "seedance-2.0-mini", "h3video-768", "h3video-2k"];
const labels = { planning: "分析中", ready: "待确认费用", running: "处理中", paused: "已暂停", completed: "已合成" };

export function ReplacementBatchPanel({ subtitleBlocked }: { subtitleBlocked: string }) {
    const draft = useVideoWorkbenchStore((s) => s.drafts["content-replace"]);
    const d = { ...emptyVideoDraft("content-replace"), ...draft };
    const token = useUserStore((s) => s.token);
    const hydrated = useVideoWorkbenchStore((s) => s.hydrated);
    const savedConfig = useConfigStore((s) => s.config);
    const publicSettings = useConfigStore((s) => s.publicSettings);
    const config = resolveEffectiveConfig({ ...savedConfig, channelMode: "remote" }, publicSettings);
    const { token: colors } = theme.useToken();
    const { modal, message } = App.useApp();
    const [model, setModel] = useState("");
    const [seconds, setSeconds] = useState("");
    const [resolution, setResolution] = useState("");
    const [jobs, setJobs] = useState<ReplacementJob[]>([]);
    const [captionEditorJobId, setCaptionEditorJobId] = useState("");
    const [previewChoice, setPreviewChoice] = useState<{ jobId: string; result: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const submitting = useRef(false);
    const attemptedResult = useRef("");
    const previewRevision = useRef(0);
    const pendingRequest = useRef<{ key: string; id: string; source?: string; image?: string } | undefined>(undefined);
    const candidates = selectableModelsByCapability(config, "video")
        .filter((name) => name.startsWith("remote::") && preferred.includes(modelOptionName(name).toLowerCase()))
        .filter((name) => { const p = videoProfile({ ...config, channelMode: "remote" }, name); return p.maxVideos > 0 && p.maxImages > 0; })
        .sort((a, b) => preferred.indexOf(modelOptionName(a).toLowerCase()) - preferred.indexOf(modelOptionName(b).toLowerCase()));
    const selected = candidates.includes(model) || model === wanReplace ? model : candidates[0] || wanReplace;
    const profile = videoProfile({ ...config, channelMode: "remote" }, selected);
    // Existing reference-video input range for Wan30; output duration is separate.
    const durations = selected === wanReplace ? ["10"] : profile.seconds.filter((v) => Number(v) > 0.5 && (modelOptionName(selected).toLowerCase() !== "wan30-720p" || Number(v) <= 15)).sort((a, b) => Number(b) - Number(a));
    const sizes = selected === wanReplace ? ["720", "480"] : profile.resolutions;
    const duration = durations.includes(seconds) ? seconds : durations[0];
    const size = sizes.includes(resolution) ? resolution : sizes[0];
    const source = d.media.find((m) => m.role === "reference" && m.kind === "video");
    const image = d.media.find((m) => m.role === "model" && m.kind === "image");
    const refresh = async () => setJobs((await listReplacementJobs()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    useEffect(() => {
        if (!token) { setJobs([]); return; }
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
    const currentJob = jobs.find((job) => job.id === d.replacementJobId);
    const captionEditorJob = jobs.find((job) => job.id === captionEditorJobId);
    const selectedResult = currentJob ? (previewChoice?.jobId === currentJob.id ? previewChoice.result : currentJob.captionResult || currentJob.result) : undefined;
    useEffect(() => {
        if (!hydrated || !currentJob || !selectedResult || !token || captionEditorJobId) return;
        const key = `${token}:${currentJob.id}:${selectedResult}`;
        if (attemptedResult.current === key || (d.replacementResultKey === selectedResult && d.final)) return;
        attemptedResult.current = key;
        void showResult(currentJob, true, selectedResult);
    }, [hydrated, token, currentJob?.id, selectedResult, captionEditorJobId, d.replacementResultKey, d.final]);
    useEffect(() => () => { previewRevision.current++; }, [token]);
    const prepare = async () => {
        if (submitting.current || subtitleBlocked || !source || !image || !duration || !size) return;
        submitting.current = true; setBusy(true); setError("");
        try {
            const key = JSON.stringify([source, image, selected, size, duration, d.instructions, d.replaceSubtitles, d.subtitleSize, d.subtitleColor]);
            if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: crypto.randomUUID() };
            const pending = pendingRequest.current;
            pending.source ||= await uploadWorkerMedia(worker, source);
            pending.image ||= await uploadReplicateReference(image);
            const created = await createReplacementJob({ id: pending.id, source: pending.source, image: pending.image,
                model: modelOptionName(selected), resolution: size.replace(/p$/i, ""), seconds: duration,
                prompt: contentReplacementPrompt("person", d.instructions, d.replaceSubtitles), subtitles: d.replaceSubtitles,
                subtitleSize: d.subtitleSize, subtitleColor: d.subtitleColor });
            useVideoWorkbenchStore.getState().patchDraft("content-replace", { replacementJobId: created.id, replacementResultKey: undefined, replacementSource: undefined, final: null });
            setPreviewChoice(null);
            pendingRequest.current = undefined;
            await refresh();
        } catch (e) { setError(e instanceof Error ? e.message : "整片分析失败"); }
        finally { submitting.current = false; setBusy(false); }
    };
    const start = (job: ReplacementJob) => modal.confirm({
        title: job.planned ? "确认整片处理费用" : "恢复视频分析",
        content: job.planned ? `${job.model}，${replacementDurationSummary(job)}，模型累计预算 ${job.credits} 算力点（含历史重做预算）。${job.subtitles ? job.subtitleOutput === "editable" ? "先清理原片字幕，生成后交付保留原音轨的无字幕视频；语音识别稿可在线校对，再另行生成带字幕版。" : "按原任务记录清理并重做字幕。" : "未启用字幕修复，原字幕可能被模型重画。"}按段扣费，恢复复用已有任务；不自动重试或切换模型。字幕处理与存储的外部资源费用未计入。` : "继续分析镜头与报价，此步骤不调用收费生成模型。",
        okText: job.status === "ready" ? "开始处理" : "恢复处理",
        onOk: async () => { try { await startReplacementJob(job); setPreviewChoice(null); useVideoWorkbenchStore.getState().patchDraft("content-replace", { replacementJobId: job.id }); await refresh(); } catch (e) { message.error(e instanceof Error ? e.message : "启动失败"); throw e; } },
    });
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
    return <div className="space-y-3" aria-label="后台整片人物替换">
        <p className="m-0 text-sm">Wan30 在所选时长内优先整段处理，超长再按镜头组合分段；其他模型按镜头拆分。关闭页面后后台仍会继续。</p>
        <Select className="w-full" aria-label="整片人物替换模型" value={selected} disabled={busy}
            options={[...candidates.map((v) => ({ value: v, label: modelOptionName(v) })), { value: wanReplace, label: "Replicate · Wan 2.2 人物替换" }]}
            onChange={(v) => { setModel(v); setSeconds(""); setResolution(""); }} />
        <div className="flex gap-2">
            <Select aria-label="整片处理分辨率" value={size} disabled={busy} options={sizes.map((v) => ({ value: v, label: v }))} onChange={setResolution} />
            <Select aria-label="每段模型时长" value={duration} disabled={busy} options={durations.map((v) => ({ value: v, label: `每段最长 ${v} 秒` }))} onChange={setSeconds} />
        </div>
        <p className="m-0 text-xs" style={{ color: colors.colorTextSecondary }}>仅列出渠道已配置视频参考的候选模型，精准换人效果待实测。分析后显示整片报价；连续镜头重叠 0.5 秒，短镜头补齐后裁回原长度。</p>
        <Button block type="primary" loading={busy} disabled={!hydrated || !token || !source || !image || !duration || !size || Boolean(subtitleBlocked)} onClick={() => void prepare()}>分析整片并计算费用</Button>
        {error && <Alert type="warning" showIcon title={error} closable onClose={() => setError("")} />}
        {jobs.map((job) => <div key={job.id} className="space-y-2 border-t pt-3" style={{ borderColor: colors.colorBorderSecondary }}>
            <div className="text-sm">{job.model} · {labels[job.status]}</div>
            <div className="text-xs" style={{ color: colors.colorTextSecondary }}>{job.step} · {job.parts?.filter((p) => p.validated).length || 0}/{job.parts?.length || 0} 段</div>
            {job.planned && <div className="text-xs">模型累计预算 {job.credits} 点 · {job.resolution}<br />{replacementDurationSummary(job)}</div>}
            {job.result && <Alert type={job.reviewed ? "success" : "info"} title={job.reviewed ? "已人工验收" : "合成完成，效果待验收"} description={job.subtitleOutput === "editable" ? "无字幕版已保留，请检查第一帧、转场后人物、口型与接缝；识别稿需校对后再生成带字幕版。" : "请检查第一帧、转场后人物、无人镜头、口型、字幕与接缝。时间轴校验通过不代表人物或文字正确。"} />}
            {job.subtitleOutput === "editable" && job.status === "completed" && <div className="space-y-2 rounded-md p-2" style={{ background: colors.colorFillQuaternary }}>
                <div className="text-sm font-medium">字幕：{job.captionStatus === "recognizing" ? "识别中" : job.captionStatus === "rendering" ? "合成中" : job.captionStatus === "completed" ? "带字幕版已生成" : job.captionStatus === "draft" ? `${job.captionSegments?.length || 0} 条待校对` : job.captionStatus === "failed" ? "处理未完成，可恢复" : "待识别"}</div>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" onClick={() => { setCaptionEditorJobId(job.id); if (d.replacementResultKey !== job.result) void showResult(job, false, job.result); }} disabled={job.captionStatus === "recognizing" || job.captionStatus === "rendering"}>在线校对字幕</Button>
                    {job.result && <Button size="small" disabled={busy} onClick={() => void showResult(job, false, job.result)}>查看无字幕版</Button>}
                    {job.captionResult && <Button size="small" disabled={busy} onClick={() => void showResult(job, false, job.captionResult)}>查看带字幕版</Button>}
                </div>
                {job.captionError && <div className="text-xs" style={{ color: colors.colorWarningText }}>{job.captionError}</div>}
            </div>}
            {job.error && <Alert type="warning" title={job.error} />}
            <div className="flex flex-wrap gap-2">
                {(job.status === "ready" || job.status === "paused") && <Button size="small" onClick={() => start(job)}>{job.status === "ready" ? "确认费用并开始" : "恢复处理"}</Button>}
                {job.status === "paused" && job.planned && <Button size="small" onClick={() => void repriceReplacementJob(job.id).then(refresh).catch((e) => message.error(e.message))}>刷新剩余费用</Button>}
                {job.status === "running" && <Button size="small" onClick={() => void pauseReplacementJob(job.id).then((v) => message.info(v.message)).catch((e) => message.error(e.message))}>暂停后续处理</Button>}
                {job.status === "paused" && job.parts?.some((p) => !p.validated && p.submitted && !!p.taskId) && <Button size="small" onClick={() => retryPart(job, job.parts!.findIndex((p) => !p.validated && p.submitted && !!p.taskId))}>重做问题片段</Button>}
                {job.result && job.subtitleOutput !== "editable" && <Button size="small" disabled={busy} onClick={() => void showResult(job)}>查看完整视频</Button>}
                {job.previousResults?.map((result, index) => <Button key={result} size="small" disabled={busy} onClick={() => void showResult(job, false, result)}>查看历史版本 {index + 1}</Button>)}
                {job.result && !job.reviewed && <Button size="small" onClick={() => modal.confirm({ title: "确认效果验收通过", content: `已对照检查开头与转场人物、无人镜头、口型和接缝${job.subtitleOutput === "editable" ? "；如需带字幕版，也已校对其文案、样式与时间轴" : "、字幕"}？此操作不会生成或收费。`, onOk: async () => { await reviewReplacementJob(job.id); await refresh(); } })}>标记验收通过</Button>}
                {(job.status === "completed" || job.status === "paused") && job.parts?.some((p) => p.taskId) && <Select<number> aria-label={`重做片段 ${job.id}`} placeholder="选择效果不合格的片段重做" value={undefined} className="w-full" options={job.parts.flatMap((p, i) => p.taskId ? [{value:i,label:`第 ${i+1} 段 · ${p.start.toFixed(2)}–${p.end.toFixed(2)} 秒`}] : [])} onChange={(index) => void retryPart(job, index)} />}
            </div>
        </div>)}
        {captionEditorJob && <ReplacementCaptionEditor key={captionEditorJob.id} job={captionEditorJob}
            videoUrl={d.replacementResultKey === captionEditorJob.result ? d.final?.url : undefined}
            onClose={() => setCaptionEditorJobId("")}
            onRefresh={refresh}
            onRendered={() => { setCaptionEditorJobId(""); setPreviewChoice(null); void refresh(); }} />}
    </div>;
}
