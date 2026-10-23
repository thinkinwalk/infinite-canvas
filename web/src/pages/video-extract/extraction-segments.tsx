import { useRef, useState } from "react";
import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Progress, Select, Spin, Tag, Tooltip, theme } from "antd";
import { Check, Combine, Play, Scissors, Sparkles, Split, X } from "lucide-react";
import { moveSegmentBoundary, segmentationModels, segmentPlanError, splitOrMergeSegment, type SegmentPlan } from "@/lib/video-segmentation";
import { planWorkbenchSegments, resolveWorkerUrl } from "@/services/api/video-worker";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useVideoExtractionStore, type VideoExtraction } from "@/stores/use-video-extraction-store";
import { readExtractedVideo } from "./extraction-actions";
import { saveExtractionClip } from "./extraction-clips";

type Run = (action: string, work: (controller: AbortController, session: string) => Promise<void>) => Promise<void>;
const boundaryLabels = { scene: "镜头切换", silence: "音频停顿", duration: "按时长", end: "视频结尾", manual: "手动调整" };

export function ExtractionSegments({ record, url, disabled, busy, run, onCancel }: {
    record: VideoExtraction; url: string; disabled: boolean; busy: string; run: Run; onCancel: () => void;
}) {
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const owner = useUserStore((state) => state.user?.id || "");
    const models = segmentationModels(config);
    const saved = record.segmentPlan;
    const [model, setModel] = useState(saved?.model ?? (models.find((item) => item.value === config.videoModel)?.value || ""));
    const [custom, setCustom] = useState({ min: saved?.minSeconds || 1, max: saved?.maxSeconds || 30 });
    const [target, setTarget] = useState(saved?.targetSeconds || Math.min(models.find((item) => item.value === model)?.max || 30, Math.max(models.find((item) => item.value === model)?.min || 1, 15)));
    const [step, setStep] = useState("");
    const [completed, setCompleted] = useState(0);
    const [total, setTotal] = useState(0);
    const [editRevision, setEditRevision] = useState(0);
    const [preview, setPreview] = useState<{ start: number; end: number; name: string }>();
    const player = useRef<HTMLVideoElement>(null);
    const selectedModel = models.find((item) => item.value === model);
    const min = selectedModel?.min ?? custom.min;
    const max = selectedModel?.max ?? custom.max;
    const boundsError = model && !selectedModel ? "目标模型已停用或未配置参考视频时长，请重新选择" : !(1 <= min && min <= target && target <= max && max <= 30) ? "请检查最短、目标和最长时长" : "";
    const stale = saved && (saved.model !== model || saved.minSeconds !== min || saved.maxSeconds !== max || saved.targetSeconds !== target);
    const planError = saved ? segmentPlanError(saved) : "";
    const pending = saved?.parts.filter((part) => part.selected && !part.savedClipId) || [];
    const working = busy === "segment-plan" || busy === "segment-save";

    const validateSession = (controller: AbortController, originalSession: string) => {
        controller.signal.throwIfAborted();
        if (useUserStore.getState().token !== originalSession || useUserStore.getState().user?.id !== owner) throw new Error("登录状态已变化，请重新操作");
    };
    const persist = async (plan: SegmentPlan, controller: AbortController, session: string, previous?: SegmentPlan) => {
        await useVideoExtractionStore.getState().savePlan(owner, record.id, plan, () => validateSession(controller, session), previous);
    };
    const edit = (change: (plan: SegmentPlan) => SegmentPlan) => run("segment-edit", async (controller, session) => {
        const plan = useVideoExtractionStore.getState().records.find((item) => item.id === record.id)?.segmentPlan;
        if (!plan) throw new Error("分段方案不存在，请重新分析");
        const next = change(plan);
        const error = segmentPlanError(next);
        if (error) throw new Error(error);
        await persist(next, controller, session, plan);
    }).finally(() => setEditRevision((revision) => revision + 1));
    const analyze = () => run("segment-plan", async (controller, session) => {
        setStep("准备原视频");
        await readExtractedVideo(record, controller.signal);
        validateSession(controller, session);
        const result = await planWorkbenchSegments(useVideoWorkbenchStore.getState().worker, record.media,
            { minSeconds: min, maxSeconds: max, targetSeconds: target }, controller.signal, setStep);
        validateSession(controller, session);
        const plan = { ...result, model };
        const error = segmentPlanError(plan);
        if (error) throw new Error(error);
        await persist(plan, controller, session, saved);
        message.success(`已生成 ${plan.parts.length} 个片段方案`);
    });
    const save = () => run("segment-save", async (controller, session) => {
        if (!saved || boundsError || stale || planError) throw new Error("分段规格已变化或无效，请重新分析");
        if (saved.workerUrl !== resolveWorkerUrl(useVideoWorkbenchStore.getState().worker)) throw new Error("处理服务地址已变化，请重新分析");
        setCompleted(0);
        setTotal(pending.length);
        for (const [index, part] of pending.entries()) {
            validateSession(controller, session);
            if (saved.model) {
                const latest = segmentationModels(useConfigStore.getState().config).find((item) => item.value === saved.model);
                if (!latest || latest.min !== saved.minSeconds || latest.max !== saved.maxSeconds) throw new Error("目标模型能力已变化，请重新分析，已保存片段保留");
            }
            setStep(`正在裁剪 ${index + 1}/${pending.length}：${part.name}`);
            await saveExtractionClip(record, part.name, [part.start, part.end], controller.signal, undefined, {
                ...saved, onProgress: (next) => setStep(`${next} ${index + 1}/${pending.length}：${part.name}`),
            });
            setCompleted(index + 1);
        }
        message.success("选中片段已保存");
    });
    return <section aria-label="自动分段" className="space-y-3 border-b pb-4" style={{ borderColor: token.colorBorderSecondary }}>
        <h3 className="flex items-center gap-2 text-sm font-medium"><Sparkles size={16} />自动分段</h3>
        <div className="flex min-w-0 flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs">目标模型
                <Select aria-label="自动分段目标模型" className="w-60 max-w-full" value={model} disabled={disabled}
                    options={[{ value: "", label: "自定义分段" }, ...models]} onChange={(value) => {
                        setModel(value);
                        const next = models.find((item) => item.value === value);
                        if (next) setTarget(Math.min(next.max, Math.max(next.min, target)));
                    }} />
            </label>
            <label className="flex flex-col gap-1 text-xs">最短（秒）<InputNumber aria-label="自动分段最短秒数" min={1} max={max} step={0.01} value={min} disabled={disabled || Boolean(model)} onChange={(value) => value !== null && setCustom({ ...custom, min: value })} /></label>
            <label className="flex flex-col gap-1 text-xs">最长（秒）<InputNumber aria-label="自动分段最长秒数" min={min} max={30} step={0.01} value={max} disabled={disabled || Boolean(model)} onChange={(value) => value !== null && setCustom({ ...custom, max: value })} /></label>
            <label className="flex flex-col gap-1 text-xs">目标片长（秒）<InputNumber aria-label="自动分段目标秒数" min={min} max={max} step={0.01} value={target} disabled={disabled} onChange={(value) => value !== null && setTarget(value)} /></label>
            <Button icon={<Sparkles size={15} />} loading={busy === "segment-plan"} disabled={disabled || Boolean(boundsError)} onClick={() => void analyze()}>{saved ? "重新分析" : "一键自动分段"}</Button>
            {working && <Button icon={<X size={15} />} onClick={onCancel}>取消</Button>}
        </div>
        {boundsError && <Alert type="warning" showIcon title={boundsError} />}
        {working && <div role="status" className="space-y-2 text-sm">
            <div className="flex items-center gap-2"><Spin size="small" />{step}</div>
            {busy === "segment-save" && <Progress percent={total ? Math.round(completed / total * 100) : 0} size="small" />}
        </div>}
        {saved && <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: token.colorTextSecondary }}>
                <span>{saved.parts.length} 段 · 共 {saved.duration.toFixed(2)} 秒 · {saved.minSeconds}–{saved.maxSeconds} 秒/段</span>
                <Checkbox disabled={disabled} checked={saved.parts.every((part) => part.selected || part.savedClipId)}
                    indeterminate={saved.parts.some((part) => part.selected) && !saved.parts.every((part) => part.selected || part.savedClipId)}
                    onChange={(event) => void edit((plan) => ({ ...plan, parts: plan.parts.map((part) => ({ ...part, selected: event.target.checked })) }))}>全选</Checkbox>
            </div>
            {(stale || planError) && <Alert type="warning" showIcon title={planError || "分段规格已变化，请重新分析后保存"} />}
            <ol className="divide-y" style={{ borderColor: token.colorBorderSecondary }}>
                {saved.parts.map((part, index) => <li key={`${index}:${part.start}:${part.end}:${part.name}:${editRevision}`} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                    <Checkbox aria-label={`选择自动片段 ${index + 1}`} checked={part.selected} disabled={disabled || Boolean(part.savedClipId)}
                        onChange={(event) => void edit((plan) => ({ ...plan, parts: plan.parts.map((item, i) => i === index ? { ...item, selected: event.target.checked } : item) }))} />
                    <span className="w-6 text-xs tabular-nums">{index + 1}</span>
                    <Input aria-label={`自动片段 ${index + 1} 名称`} className="!w-36 max-w-full" defaultValue={part.name} disabled={disabled || Boolean(part.savedClipId)}
                        onBlur={(event) => { const name = event.target.value.trim(); if (name !== part.name) void edit((plan) => ({ ...plan, parts: plan.parts.map((item, i) => i === index ? { ...item, name } : item) })); }} />
                    <span className="text-xs tabular-nums">{part.start.toFixed(3)}–{part.end.toFixed(3)} 秒 · {(part.end - part.start).toFixed(3)} 秒</span>
                    <Tag>{boundaryLabels[part.boundary]}</Tag>
                    {part.savedClipId ? <Tag icon={<Check size={12} />}>已保存</Tag> : null}
                    <div className="ml-auto flex flex-wrap items-center gap-1">
                        {index < saved.parts.length - 1 && <label className="flex items-center gap-1 text-xs">分界点
                            <InputNumber aria-label={`自动片段 ${index + 1} 分界点`} defaultValue={part.end} precision={3} step={0.01}
                                disabled={disabled || Boolean(part.savedClipId || saved.parts[index + 1].savedClipId)}
                                onBlur={(event) => { const end = Number(event.target.value); if (end !== part.end) void edit((plan) => moveSegmentBoundary(plan, index, end)); }} />
                        </label>}
                        <Tooltip title="试看片段"><Button aria-label={`试看自动片段 ${index + 1}`} type="text" icon={<Play size={15} />} disabled={disabled} onClick={() => setPreview(part)} /></Tooltip>
                        <Tooltip title="拆分"><Button aria-label={`拆分自动片段 ${index + 1}`} type="text" icon={<Split size={15} />} disabled={disabled || Boolean(part.savedClipId) || Math.round((part.end - part.start) * 1000) < Math.ceil(saved.minSeconds * 1000) * 2} onClick={() => void edit((plan) => splitOrMergeSegment(plan, index))} /></Tooltip>
                        {index < saved.parts.length - 1 && <Tooltip title="与下一段合并"><Button aria-label={`合并自动片段 ${index + 1}`} type="text" icon={<Combine size={15} />} disabled={disabled || Boolean(part.savedClipId || saved.parts[index + 1].savedClipId) || Math.round((saved.parts[index + 1].end - part.start) * 1000) > Math.floor(saved.maxSeconds * 1000)} onClick={() => void edit((plan) => splitOrMergeSegment(plan, index, true))} /></Tooltip>}
                    </div>
                </li>)}
            </ol>
            <Button type="primary" icon={<Scissors size={15} />} disabled={disabled || !pending.length || Boolean(boundsError || stale || planError)} loading={busy === "segment-save"} onClick={() => void save()}>保存选中片段{pending.length ? `（${pending.length}）` : ""}</Button>
        </>}
        <Modal title={preview?.name} open={Boolean(preview)} footer={null} destroyOnHidden onCancel={() => { player.current?.pause(); setPreview(undefined); }}>
            {preview && <video key={`${preview.start}:${preview.end}`} ref={player} src={url} controls playsInline preload="metadata" className="max-h-[60dvh] w-full object-contain" aria-label="自动片段试看"
                onLoadedMetadata={(event) => { event.currentTarget.currentTime = preview.start; }}
                onPlay={(event) => { if (event.currentTarget.currentTime < preview.start || event.currentTarget.currentTime >= preview.end) event.currentTarget.currentTime = preview.start; }}
                onSeeking={(event) => { if (event.currentTarget.currentTime < preview.start || event.currentTarget.currentTime > preview.end) event.currentTarget.currentTime = preview.start; }}
                onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= preview.end) event.currentTarget.pause(); }} />}
        </Modal>
    </section>;
}
