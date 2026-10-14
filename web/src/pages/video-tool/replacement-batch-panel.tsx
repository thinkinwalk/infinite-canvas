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
import { createReplacementJob, listReplacementJobs, pauseReplacementJob, quoteReplacementPart, repriceReplacementJob, retryReplacementPart, startReplacementJob, type ReplacementJob } from "@/services/api/replacement-jobs";
import { contentReplacementPrompt } from "./content-replace-prompt";

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
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const submitting = useRef(false);
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
    const prepare = async () => {
        if (submitting.current || subtitleBlocked || !source || !image || !duration || !size) return;
        submitting.current = true; setBusy(true); setError("");
        try {
            const key = JSON.stringify([source, image, selected, size, duration, d.instructions, d.replaceSubtitles, d.subtitleSize, d.subtitleColor]);
            if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: crypto.randomUUID() };
            const pending = pendingRequest.current;
            pending.source ||= await uploadWorkerMedia(worker, source);
            pending.image ||= await uploadReplicateReference(image);
            await createReplacementJob({ id: pending.id, source: pending.source, image: pending.image,
                model: modelOptionName(selected), resolution: size.replace(/p$/i, ""), seconds: duration,
                prompt: contentReplacementPrompt("person", d.instructions, d.replaceSubtitles), subtitles: d.replaceSubtitles,
                subtitleSize: d.subtitleSize, subtitleColor: d.subtitleColor });
            pendingRequest.current = undefined;
            await refresh();
        } catch (e) { setError(e instanceof Error ? e.message : "整片分析失败"); }
        finally { submitting.current = false; setBusy(false); }
    };
    const start = (job: ReplacementJob) => modal.confirm({
        title: job.planned ? "确认整片处理费用" : "恢复视频分析",
        content: job.planned ? `${job.model}，${job.parts?.length || 0} 段，整片模型费用合计 ${job.credits} 算力点（包含重叠和补齐时长）。按段扣费，恢复时复用已有任务；不自动重试失败生成或切换模型。此处是模型费用；字幕处理与存储的外部资源费用未计入。` : "继续分析镜头与报价，此步骤不调用收费生成模型。",
        okText: job.status === "ready" ? "开始处理" : "恢复处理",
        onOk: async () => { try { await startReplacementJob(job); await refresh(); } catch (e) { message.error(e instanceof Error ? e.message : "启动失败"); throw e; } },
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
    const showResult = async (job: ReplacementJob) => {
        if (!job.result) return;
        setBusy(true);
        try {
            const final = await storeWorkerResult(worker, job.result);
            useVideoWorkbenchStore.getState().patchDraft("content-replace", { final });
            message.success("已载入整片结果，请检查人物、字幕和接缝");
        } catch (e) { message.error(e instanceof Error ? e.message : "读取结果失败"); }
        finally { setBusy(false); }
    };
    return <div className="space-y-3" aria-label="后台整片人物替换">
        <p className="m-0 text-sm">自动按镜头拆分，逐段处理后合成完整视频。关闭页面后后台仍会继续。</p>
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
            {job.planned && <div className="text-xs">整片模型预算 {job.credits} 点 · {job.resolution} · 每段最长 {job.seconds} 秒</div>}
            {job.error && <Alert type="warning" title={job.error} />}
            <div className="flex flex-wrap gap-2">
                {(job.status === "ready" || job.status === "paused") && <Button size="small" onClick={() => start(job)}>{job.status === "ready" ? "确认费用并开始" : "恢复处理"}</Button>}
                {job.status === "paused" && job.planned && <Button size="small" onClick={() => void repriceReplacementJob(job.id).then(refresh).catch((e) => message.error(e.message))}>刷新剩余费用</Button>}
                {job.status === "running" && <Button size="small" onClick={() => void pauseReplacementJob(job.id).then((v) => message.info(v.message)).catch((e) => message.error(e.message))}>暂停后续处理</Button>}
                {job.status === "paused" && job.parts?.some((p) => !p.validated && p.submitted && !!p.taskId) && <Button size="small" onClick={() => retryPart(job, job.parts!.findIndex((p) => !p.validated && p.submitted && !!p.taskId))}>重做问题片段</Button>}
                {job.result && <Button size="small" disabled={busy} onClick={() => void showResult(job)}>查看完整视频</Button>}
            </div>
        </div>)}
    </div>;
}
