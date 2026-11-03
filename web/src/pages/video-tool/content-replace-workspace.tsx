import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, App, Button, Collapse, Descriptions, Empty, Input, Modal, Popover, Segmented, Select, Space, Spin, Switch, Tabs, Tag, Upload, theme, type UploadProps } from "antd";
import { ArrowLeft, ClipboardPaste, Download, FileText, FolderPlus, History, Image as ImageIcon, Info, LoaderCircle, Plus, RefreshCw, Sparkles, Video, X } from "lucide-react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { ModelPicker } from "@/components/model-picker";
import { FeatureModelPicker } from "@/components/feature-model-picker";
import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { VideoReferenceTrimmer } from "@/components/video-reference-trimmer";
import { VideoLinkImport } from "@/components/video-link-import";
import { VideoReferenceRetention } from "@/components/video-reference-retention";
import { canvasThemes } from "@/lib/canvas-theme";
import { hasContentReplacementDraft, hasReplacementRecovery, isLegacyMaskedPersonRecord, isPendingReplacement, RETIRED_HEAD_SWAP_MESSAGE } from "@/lib/content-replacement-state";
import { contentReplacementTaskGroups, replacementHistoryStates } from "@/lib/video-task-history";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { isWan30, videoReferenceDurationError, videoReferenceError } from "@/lib/video-capabilities";
import { getReplicateModels, publicServiceText, readReplicateTask, reconcileReplicateTask, REPLICATE_MODEL_NAMES, type ReplicateOperation, type ReplicateQuote } from "@/services/api/replicate";
import { getWorkerCapabilities, prepareWorkbenchVideo, workbenchMediaBlob } from "@/services/api/video-worker";
import { archiveReplacementJob, isRetiredReplacementJob, type ReplacementJob } from "@/services/api/replacement-jobs";
import { VIDEO_ACTIVE_POLL_INTERVAL_MS } from "@/services/api/video";
import { replaceStoredVideo, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { registerTemporaryReferenceCopy } from "@/services/video-reference-retention";
import { imageToDataUrl } from "@/services/image-storage";
import { useConfigStore } from "@/stores/use-config-store";
import { useVideoCreationConfig } from "@/hooks/use-video-creation-config";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useReplacementJobsStore } from "@/stores/use-replacement-jobs-store";
import { emptyVideoDraft, type MediaRole, type SubtitleRegion, type VideoDraft, type VideoRecord, type WorkerCapabilities } from "@/types/video-workbench";
import { restoreWorkbenchFile, useVideoWorkbench } from "./use-video-workbench";

import { ReplacementBatchPanel } from "./replacement-batch-panel";
import { VideoTaskDetails, videoResultRecord } from "./video-task-details";
import { VideoTaskHistory, type VideoHistoryItem } from "./video-task-history";

const replacementNames = { person: "人物", product: "商品", background: "背景" };
const recordNames = { running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待暂停" };
const longVideoPreviewThresholdMs = 15_000;

export default function ContentReplaceWorkspace() {
    const wb = useVideoWorkbench("content-replace");
    const { draft: d, busy } = wb;
    const initialized = useRef(false), [ready, setReady] = useState(false);
    const { token } = theme.useToken();
    const { message, modal } = App.useApp();
    const location = useLocation();
    const config = useVideoCreationConfig();
    const openConfig = useConfigStore((s) => s.openConfigDialog);
    const updateConfig = useConfigStore((s) => s.updateConfig);
    const themeMode = useThemeStore((s) => s.theme);
    const platformToken = useUserStore((s) => s.token);
    const onlineHistory = useReplacementJobsStore();
    const jobs = onlineHistory.session === (platformToken || "") ? onlineHistory.jobs : [];
    const archivedTasks = useVideoWorkbenchStore((state) => state.archivedTasks);
    const administrator = useUserStore((s) => s.user?.role === "admin");
    const appliedSearch = useRef<string | null>(null);
    const [models, setModels] = useState<ReplicateQuote[]>([]);
    const [modelError, setModelError] = useState("");
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelRevision, setModelRevision] = useState(0);
    const [capabilities, setCapabilities] = useState<WorkerCapabilities[] | null>(null);
    const [serviceError, setServiceError] = useState("");
    const [checking, setChecking] = useState(false);
    const [serviceRevision, setServiceRevision] = useState(0);
    const [tab, setTab] = useState("current");
    const [batchWorkspace, setBatchWorkspace] = useState<HTMLDivElement | null>(null);
    const [batchRevision, setBatchRevision] = useState(0);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [assetRole, setAssetRole] = useState<{ role: MediaRole; accept: string } | null>(null);
    const [referenceImportOpen, setReferenceImportOpen] = useState(false);
    const [referenceImportTab, setReferenceImportTab] = useState("upload");
    const [uploading, setUploading] = useState(false);
    const [trimming, setTrimming] = useState(false);
    const uploadingRef = useRef(false);
    const [uploadErrors, setUploadErrors] = useState<Partial<Record<MediaRole, string>>>({});
    const [quoting, setQuoting] = useState(false);
    const [quote, setQuote] = useState<{ key: string; value: ReplicateQuote } | null>(null);
    const [quoteError, setQuoteError] = useState("");
    const quoteController = useRef<AbortController | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const [sourcePreviewError, setSourcePreviewError] = useState(false);
    const [processingHelpOpen, setProcessingHelpOpen] = useState(false);
    const [repairingSource, setRepairingSource] = useState(false);
    const [historyPreview, setHistoryPreview] = useState<{ record: VideoRecord; result: UploadedFile; source?: UploadedFile } | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [openingHistory, setOpeningHistory] = useState(false);
    const [drawRegions, setDrawRegions] = useState(false);
    const [drawing, setDrawing] = useState<SubtitleRegion | null>(null);
    const anchor = useRef<{ x: number; y: number } | null>(null);
    const selectionVideo = useRef<HTMLVideoElement | null>(null);
    const selectionTime = useRef(0);
    const person = d.replacement === "person";
    const cloud = d.route === "replicate";
    const reference = d.media.find((m) => m.role === "reference" && m.kind === "video");
    // 旧换脸草稿只用于查看和恢复，不再提供新生成入口。
    const headSwap = person && d.replacementModel === "headswap";
    const longVideo = Boolean(reference?.durationMs && reference.durationMs > longVideoPreviewThresholdMs);
    // 人物替换统一持久化，短视频整段生成，长视频按模型能力分段。
    const wholeVideo = person && cloud && (Boolean(d.replacementJobId) || !headSwap || longVideo);
    const showSegmentHint = wholeVideo && longVideo;
    const showBatchWorkspace = wholeVideo && Boolean(d.replacementJobId) && !historyPreview;
    const locked = busy || wb.importing || uploading || repairingSource || trimming || openingHistory;
    const imageRole = d.replacement === "background" ? "background" : "model";
    const image = d.media.find((m) => m.role === imageRole && m.kind === "image");
    const operation: ReplicateOperation = person ? (headSwap ? "head-swap" : "replace-person") : d.maskedEdit ? "masked-edit" : "video-edit";
    const model = models.find((m) => m.operation === operation);
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const taskGroups = contentReplacementTaskGroups(wb.records, jobs, d);
    const inputKey = JSON.stringify([
        d.route,
        d.replacement,
        d.replacementModel,
        d.maskedEdit,
        d.replicateResolution,
        d.replaceSubtitles,
        d.regenerateSubtitles,
        d.regions,
        d.replacementSeedTime,
        cloud && person ? "" : d.instructions,
        d.media.map((m) => [m.id, m.storageKey, m.role, m.durationMs]),
        config.videoModel,
        config.size,
        config.videoSeconds,
        config.vquality,
    ]);
    const currentInputKey = useRef(inputKey);
    currentInputKey.current = inputKey;
    const currentQuote = quote?.key === inputKey ? quote.value : null;
    const result = historyPreview?.result || (showBatchWorkspace ? d.final : d.final || d.edited || d.video);
    const resultRecord = historyPreview?.record || videoResultRecord(wb.records, result);
    const previewSource = historyPreview ? historyPreview.source : d.replacementSource || reference;
    const surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };
    const muted = { color: token.colorTextSecondary };

    useEffect(() => {
        const store = useReplacementJobsStore.getState();
        store.reset(platformToken || "");
        if (!platformToken) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const controller = new AbortController();
        const poll = async () => {
            await store.refresh(controller.signal);
            if (!disposed) timer = setTimeout(poll, VIDEO_ACTIVE_POLL_INTERVAL_MS);
        };
        void poll();
        return () => { disposed = true; controller.abort(); clearTimeout(timer); };
    }, [platformToken]);

    useEffect(() => {
        if (!wb.hydrated || initialized.current) return;
        initialized.current = true;
        const state = useVideoWorkbenchStore.getState();
        if (state.storageError || state.busyTools["content-replace"]) {
            if (!state.storageError && !state.drafts["content-replace"]?.replacementTaskId)
                state.patchDraft("content-replace", { replacementTaskId: crypto.randomUUID() });
            setReady(true);
            return;
        }
        void state.openContentReplacementTask().catch((error) => message.error(error instanceof Error ? error.message : "任务初始化失败")).finally(() => setReady(true));
    }, [wb.hydrated]);

    const createTask = () => {
        const create = () => useVideoWorkbenchStore.getState().openContentReplacementTask();
        if (hasContentReplacementDraft(d)) modal.confirm({
            title: "新建任务？",
            content: "当前内容会保存到历史任务，可随时继续。",
            okText: "新建任务",
            cancelText: "取消",
            onOk: create,
        });
        else void create().catch((error) => message.error(error instanceof Error ? error.message : "新建任务失败"));
    };

    const restoreDraft = async (record: VideoRecord) => {
        if (!record.replacementDraft && !record.replacementInput) return;
        const saved = record.replacementDraft || { ...emptyVideoDraft("content-replace"), ...record.replacementInput, replacementTaskId: record.replacementInput?.replacementTaskId || record.id, activeRecord: record.id };
        const media = await Promise.all(saved.media.map(async (item) => ({ ...item, ...(await restoreWorkbenchFile(item)) })));
        const frames = await Promise.all(saved.frames.map(restoreWorkbenchFile));
        const outputs: Partial<VideoDraft> = {};
        for (const key of ["speech", "voicePreview", "video", "edited", "final", "cover", "replacementSource"] as const) {
            const file = saved[key];
            if (file) outputs[key] = await restoreWorkbenchFile(file);
        }
        if (useUserStore.getState().token !== platformToken) throw new Error("登录状态已变化，请重新打开任务");
        await useVideoWorkbenchStore.getState().openContentReplacementTask({ ...saved, ...outputs, media, frames });
        setHistoryPreview(null);
        setTab("current");
    };

    const openOnlineJob = async (job: ReplacementJob) => {
        if (locked) return;
        setOpeningHistory(true);
        try {
            const saved = wb.records.find((record) => record.replacementDraft?.replacementJobId === job.id || record.replacementDraft?.replacementJobIds?.includes(job.id))?.replacementDraft;
            const media = saved ? await Promise.all(saved.media.map(async (item) => ({ ...item, ...(await restoreWorkbenchFile(item).catch(() => item)) }))) : [];
            if (useUserStore.getState().token !== platformToken) throw new Error("登录状态已变化，请重新打开任务");
            await useVideoWorkbenchStore.getState().openContentReplacementTask({
                ...emptyVideoDraft("content-replace"), ...saved, replacement: "person", route: "replicate",
                media,
                replacementModel: isRetiredReplacementJob(job) ? "headswap" : "wan",
                replacementTaskId: saved?.replacementTaskId || job.id, replacementJobId: job.id,
                replacementJobIds: [...new Set([...(saved?.replacementJobIds || []), ...(saved?.replacementJobId ? [saved.replacementJobId] : []), job.id])],
                replacementResultKey: undefined, replacementSource: undefined, activeRecord: undefined,
                video: null, edited: null, final: null,
            });
            setHistoryPreview(null);
            setDetailsOpen(false);
            setBatchRevision((value) => value + 1);
            setTab("current");
        } catch (error) { message.error(error instanceof Error ? error.message : "任务打开失败"); }
        finally { setOpeningHistory(false); }
    };

    const continueLocalTask = async (record: VideoRecord, resume = false) => {
        if (locked) return;
        setOpeningHistory(true);
        try {
            await restoreDraft(record);
            if (resume) await wb.resume(record);
        } catch (error) { message.error(error instanceof Error ? error.message : "任务恢复失败"); }
        finally { setOpeningHistory(false); }
    };

    const archiveHistoryTask = async (group: (typeof taskGroups)[number], archived: boolean) => {
        if (useUserStore.getState().token !== platformToken) throw new Error("登录状态已变化，请重新操作");
        for (const job of group.jobs) {
            const updated = await archiveReplacementJob(job.id, archived);
            if (useUserStore.getState().token !== platformToken) throw new Error("登录状态已变化，请重新操作");
            useReplacementJobsStore.getState().update(updated, platformToken || "");
        }
        useVideoWorkbenchStore.getState().setTaskArchived(group.keys, archived);
        if (useVideoWorkbenchStore.getState().storageError) throw new Error("归档保存失败，请检查浏览器存储后重试");
    };

    useEffect(() => {
        if (!wb.hydrated || appliedSearch.current === location.search) return;
        appliedSearch.current = location.search;
        const query = new URLSearchParams(location.search);
        const replacement = query.get("replacement");
        if (replacement === "person" || replacement === "product" || replacement === "background") wb.edit({ replacement, route: "replicate", maskedEdit: query.get("masked") === "1", ...(replacement === "person" ? { replacementModel: "wan" as const } : {}) }, "video");
    }, [wb.hydrated, location.search]);
    useEffect(() => {
        if (!wb.hydrated || administrator || d.route === "replicate") return;
        wb.edit({ route: "replicate" }, "video");
    }, [wb.hydrated, administrator, d.route]);
    useEffect(() => {
        const controller = new AbortController();
        setModels([]);
        setModelError("");
        if (!platformToken || !cloud) {
            setModelsLoading(false);
            return;
        }
        setModelsLoading(true);
        void getReplicateModels(controller.signal)
            .then((value) => {
                if (!controller.signal.aborted) setModels(value);
            })
            .catch((error) => {
                if (!controller.signal.aborted) setModelError(publicServiceText(error instanceof Error ? error.message : "读取模型状态失败"));
            })
            .finally(() => {
                if (!controller.signal.aborted) setModelsLoading(false);
            });
        return () => controller.abort();
    }, [platformToken, cloud, modelRevision]);
    useEffect(() => {
        const refresh = () => {
            setQuote(null);
            setModelRevision((v) => v + 1);
            setServiceRevision((v) => v + 1);
        };
        const visible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", visible);
        return () => {
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", visible);
        };
    }, []);
    useEffect(() => {
        if (!wb.hydrated || (d.route !== "worker" && !(d.replaceSubtitles && d.regenerateSubtitles))) {
            setCapabilities(null);
            setServiceError("");
            setChecking(false);
            return;
        }
        let disposed = false;
        setCapabilities(null);
        setServiceError("");
        setChecking(true);
        void getWorkerCapabilities(wb.worker)
            .then((value) => {
                if (!disposed) {
                    setCapabilities(value);
                }
            })
            .catch((error) => {
                if (!disposed) setServiceError(publicServiceText(error instanceof Error ? error.message : "处理服务未连接"));
            })
            .finally(() => {
                if (!disposed) setChecking(false);
            });
        return () => {
            disposed = true;
        };
    }, [wb.hydrated, d.route, d.replaceSubtitles, d.regenerateSubtitles, person, wholeVideo, wb.worker.url, wb.worker.token, platformToken, serviceRevision]);
    useEffect(() => {
        quoteController.current?.abort();
        quoteController.current = null;
        setQuote(null);
        setQuoteError("");
        setQuoting(false);
        setHistoryPreview(null);
        return () => quoteController.current?.abort();
    }, [inputKey, platformToken]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);
    useEffect(() => {
        if (d.replacementJobId || d.replacementResultKey) { setHistoryPreview(null); setTab("current"); }
    }, [d.replacementJobId, d.replacementResultKey, d.final?.storageKey]);
    useEffect(() => setSourcePreviewError(false), [reference?.storageKey, reference?.url]);
    useEffect(() => {
        setReferenceImportOpen(false);
        if (!reference?.id) setReferenceImportTab("upload");
    }, [reference?.id]);
    useEffect(() => setProcessingHelpOpen(showSegmentHint), [reference?.id, showSegmentHint]);
    useEffect(() => {
        if (!platformToken || active?.status !== "failed" || !active.replicateTask || active.replicateBilling) return;
        let disposed = false;
        void readReplicateTask(active.replicateTask.id)
            .then((task) => {
                if (!disposed) useVideoWorkbenchStore.getState().patchRecord(active.id, { replicateBilling: { credits: task.credits, refunded: task.refunded } });
            })
            .catch(() => {});
        return () => {
            disposed = true;
        };
    }, [platformToken, active?.id, active?.status, active?.replicateTask?.id, active?.replicateBilling]);

    let unavailable = "";
    if (cloud) {
        unavailable = !platformToken
            ? "登录后使用平台智能处理"
            : modelsLoading
              ? "正在读取服务状态"
              : !model?.available
                  ? publicServiceText(model?.reason || modelError || "当前平台服务暂不可用")
                  : "";
    }
    else if (d.route === "worker") {
        const capability = capabilities?.find((c) => c.name === (person ? "replace-person" : "replace-product"));
        unavailable = checking ? "正在检查处理服务" : !capability?.available ? serviceError || capability?.reason || "当前处理服务尚未配置替换能力" : "";
        if (!unavailable && d.replacement === "product" && !d.media.some((m) => m.role === "mask") && !capabilities?.some((c) => c.name === "track-product" && c.available)) unavailable = "商品自动跟踪尚未就绪，请管理员配置跟踪服务";
    } else unavailable = !config.videoModel ? "请在高级设置中选择视频模型" : videoReferenceError(config, config.videoModel, 1, 1, 0) || videoReferenceDurationError(config.videoModel, reference ? [reference] : [], config);
    const subtitleCapabilities = ["replacement-finish", "replacement-transcribe"];
    const subtitleCapability = subtitleCapabilities.map((name) => capabilities?.find((item) => item.name === name)).find((item) => !item?.available);
    const subtitleUnavailable = !d.replaceSubtitles || person && wholeVideo && !d.regenerateSubtitles ? ""
        : person && wholeVideo ? checking || !capabilities && !serviceError ? "正在检查字幕识别与合成服务"
        : serviceError || (subtitleCapabilities.every((name) => capabilities?.some((item) => item.name === name && item.available)) ? "" : subtitleCapability?.reason || "字幕识别与合成服务尚未启用")
        : d.route !== "model" || !isWan30(config.videoModel) ? "当前模型不能在替换内容时同时去除原字幕，请关闭「去除原字幕」后继续。"
        : !d.regenerateSubtitles ? ""
        : checking || !capabilities && !serviceError ? "正在检查字幕识别与合成服务"
        : serviceError || (subtitleCapabilities.every((name) => capabilities?.some((item) => item.name === name && item.available)) ? "" : subtitleCapability?.reason || "字幕识别与合成服务尚未启用");
    const missing = !wb.hydrated
        ? "正在恢复本浏览器草稿"
        : uploading
          ? "素材正在保存，请稍候"
          : !reference
            ? "请上传原视频"
            : !image
              ? `请上传${replacementNames[d.replacement]}参考图`
              : !person && !d.instructions.trim()
                ? "请填写具体替换要求"
                : cloud && !person && d.maskedEdit && !d.media.some((m) => m.role === "mask")
                  ? "请上传编辑掩膜"
                  : cloud && !person && !d.maskedEdit && reference.durationMs && (reference.durationMs < 2000 || reference.durationMs > 10000)
                    ? "当前视频编辑模型要求原视频为 2–10 秒，请先裁剪"
                    : "";
    const regionMissing = d.route === "worker" && !person && !d.media.some((m) => m.role === "mask") && d.regions.length !== 1
        ? d.replacement === "product" ? "请在高级设置中暂停视频并框选一个目标商品，系统将自动跟踪" : "请框选需要替换的背景区域" : "";
    const blocked = (headSwap ? RETIRED_HEAD_SWAP_MESSAGE : "") || (trimming ? "参考视频正在裁剪，请稍候" : "") || unavailable || missing || regionMissing || subtitleUnavailable;
    const prepareQuote = async () => {
        if (blocked || busy || quoteController.current) return;
        const key = inputKey;
        const controller = new AbortController();
        quoteController.current = controller;
        setQuoting(true);
        setQuoteError("");
        try {
            const value = await wb.quoteReplacement(controller.signal);
            if (!controller.signal.aborted && currentInputKey.current === key) setQuote({ key, value });
        } catch (error) {
            if (!controller.signal.aborted && currentInputKey.current === key) setQuoteError(publicServiceText(error instanceof Error ? error.message : "读取费用失败"));
        } finally {
            if (quoteController.current === controller) {
                quoteController.current = null;
                setQuoting(false);
            }
        }
    };
    const addFile = async (file: File, role: MediaRole, accept: string) => {
        if (locked || uploadingRef.current) return;
        uploadingRef.current = true;
        wb.patch({ activeRecord: undefined });
        setUploading(true);
        setUploadErrors((errors) => ({ ...errors, [role]: "" }));
        try {
            const added = await wb.addFiles([file], role, accept);
            if (typeof added === "string") setUploadErrors((errors) => ({ ...errors, [role]: added }));
            return Array.isArray(added);
        } finally {
            uploadingRef.current = false;
            setUploading(false);
        }
    };
    const pasteImage = async (role: MediaRole, accept: string) => {
        try {
            const items = await navigator.clipboard.read();
            const image = (await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type)))))[0];
            if (!image) throw new Error("剪切板里没有可读取的图片");
            const extension = image.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
            await addFile(new File([image], `clipboard-image.${extension}`, { type: image.type || "image/png" }), role, accept);
        } catch (error) {
            const detail = publicServiceText(error instanceof Error ? error.message : "剪切板读取失败");
            setUploadErrors((errors) => ({ ...errors, [role]: detail }));
            message.error(detail);
        }
    };
    const repairSource = async () => {
        if (!reference || locked) return;
        setRepairingSource(true);
        try {
            const blob = await prepareWorkbenchVideo(wb.worker, await workbenchMediaBlob(reference), reference.name, undefined, reference);
            const repaired = reference.referenceId
                ? await registerTemporaryReferenceCopy(reference.referenceId, await uploadMediaFile(blob, "video-compatible"))
                : await replaceStoredVideo(reference.storageKey, blob);
            const state = useVideoWorkbenchStore.getState();
            wb.patch({ media: (state.drafts["content-replace"]?.media || []).map((media) => media.storageKey === reference.storageKey ? { ...media, ...repaired } : media) });
            for (const record of state.records) {
                if (record.replacementInput?.media.some((media) => media.storageKey === reference.storageKey))
                    state.patchRecord(record.id, { replacementInput: { ...record.replacementInput, media: record.replacementInput.media.map((media) => media.storageKey === reference.storageKey ? { ...media, ...repaired } : media) } });
            }
            setSourcePreviewError(false);
            message.success("原视频已转换，可以继续预览和内容替换");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "转换失败，原素材已保留"));
        } finally {
            setRepairingSource(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!assetRole) return;
        const { role, accept } = assetRole;
        try {
            if (payload.kind === "text" || !accept.includes(`${payload.kind}/`)) throw new Error("请选择该位置支持的素材类型");
            const blob =
                payload.kind === "image"
                    ? await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob()
                    : await workbenchMediaBlob({ url: payload.url, storageKey: payload.storageKey || "", mimeType: "video/mp4", bytes: 0 });
            if (await addFile(new File([blob], payload.title, { type: blob.type }), role, accept)) setAssetRole(null);
        } catch (error) {
            const detail = publicServiceText(error instanceof Error ? error.message : "读取素材失败");
            setUploadErrors((errors) => ({ ...errors, [role]: detail }));
            message.error(detail);
        }
    };
    const materialField = (role: MediaRole, accept: string, label: string, hint: string) => {
        const media = d.media.find((m) => m.role === role);
        const videoInput = role === "reference" && accept === "video/*";
        const uploadProps: UploadProps = {
            accept,
            multiple: false,
            showUploadList: false,
            disabled: locked,
            beforeUpload: (file, files) => {
                if (files.length > 1) setUploadErrors((errors) => ({ ...errors, [role]: "请每次选择一份素材，替换图仅使用单张图片" }));
                else void addFile(file, role, accept);
                return Upload.LIST_IGNORE;
            },
        };
        const upload = <div className="space-y-1">
            {(videoInput || !media) && <Upload.Dragger
                {...uploadProps}
                height={112}
                style={{ background: token.colorFillQuaternary }}
            >
                <div className="flex items-center justify-center gap-2 px-2 text-sm" style={muted}>
                    {uploading ? <Spin size="small" /> : accept === "image/*" ? <ImageIcon size={19} /> : <Video size={19} />}
                    <span>{uploading ? "正在检查并处理素材" : videoInput ? "点击或拖拽上传视频" : "点击或拖拽上传"}</span>
                </div>
                <div className="mt-1 px-3 text-xs" style={muted}>{hint}</div>
            </Upload.Dragger>}
            <Button type="text" size="small" disabled={locked} onClick={() => setAssetRole({ role, accept })}>
                {media ? "从我的素材更换" : "从我的素材选择"}
            </Button>
            {videoInput && <div className="text-xs" style={muted}>原视频上限 300MB；生成时按模型要求准备参考片段。</div>}
            {uploadErrors[role] && <div role="alert" className="text-xs" style={{ color: token.colorError }}>{uploadErrors[role]}</div>}
        </div>;
        return (
            <section className="min-w-0" data-material-role={role}>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-medium">{label}</span>
                    <div className="flex shrink-0 items-center gap-2 text-xs" style={muted}>
                        {accept === "image/*" && <Button type="text" size="small" disabled={locked} icon={<ClipboardPaste size={13} />} onClick={() => void pasteImage(role, accept)}>从剪切板粘贴</Button>}
                        {cloud && person && role === "reference" && (
                            <Popover
                                title={<div className="flex items-center justify-between gap-3">
                                    <span>{showSegmentHint ? "长视频分段说明" : "人物替换处理说明"}</span>
                                    <Button type="text" size="small" icon={<X size={14} />} aria-label="收起处理说明" onClick={() => setProcessingHelpOpen(false)} />
                                </div>}
                                trigger="click"
                                placement="topRight"
                                open={processingHelpOpen}
                                onOpenChange={setProcessingHelpOpen}
                                content={<div className="max-w-64 space-y-2 text-xs leading-relaxed">
                                    <p className="m-0">视频超过 {longVideoPreviewThresholdMs / 1000} 秒时，系统会分析镜头、规划分段，并展示费用供你确认。</p>
                                    {showSegmentHint && <p className="m-0">当前视频 {((reference?.durationMs || 0) / 1000).toFixed(1)} 秒，将分段处理。</p>}
                                </div>}
                            >
                                <Button type="text" size="small" className="!h-7 !px-1" icon={<Info size={14} />} aria-label={showSegmentHint ? "查看长视频分段说明" : "查看人物替换处理说明"} aria-expanded={processingHelpOpen}>
                                    {showSegmentHint ? "分段提示" : "处理说明"}
                                </Button>
                            </Popover>
                        )}
                        <span>
                            {role === "reference" ? "视频" : accept === "image/*" ? "单张图片" : "图片 / 视频"}
                        </span>
                    </div>
                </div>
                {media && (
                    <div className="space-y-3 rounded-lg border p-3" style={surface}>
                        <div className="flex min-w-0 flex-wrap items-start gap-2">
                            <div className="min-w-0 flex-1 basis-28">
                                <div className="truncate text-xs font-medium" title={media.name}>{media.name}</div>
                                <div className="mt-1 text-xs" style={muted}>
                                    {videoInput ? "已导入" : "已上传"} · {[formatBytes(media.bytes), media.width && media.height ? `${media.width}×${media.height}` : "", media.durationMs ? formatDuration(media.durationMs) : ""].filter(Boolean).join(" · ")}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                {videoInput ? <Button type="text" size="small" disabled={locked} icon={<RefreshCw size={13} />} aria-expanded={referenceImportOpen} onClick={() => setReferenceImportOpen((value) => !value)}>
                                    {referenceImportOpen ? "收起导入入口" : "更换原视频"}
                                </Button> : <Upload {...uploadProps}>
                                    <Button size="small" disabled={locked} icon={<RefreshCw size={13} />} aria-label={`更换${label}`}>更换</Button>
                                </Upload>}
                                <Button type="text" danger size="small" disabled={locked} icon={<X size={13} />} aria-label={`移除${label}`} onClick={() => {
                                    wb.removeMedia(media.id);
                                    setUploadErrors((errors) => ({ ...errors, [role]: "" }));
                                }}>移除</Button>
                            </div>
                        </div>
                        {media.kind === "image" ? <img src={media.url} alt={media.name} className="max-h-40 w-full rounded-lg object-contain" /> : <video key={media.url} src={media.url} controls preload="metadata" onError={() => { if (role === "reference") setSourcePreviewError(true); }} onLoadedMetadata={(event) => { if (role === "reference" && !event.currentTarget.videoWidth) setSourcePreviewError(true); }} className="max-h-44 w-full rounded-lg" />}
                        {uploading && <div role="status" className="flex items-center gap-2 text-xs" style={muted}><Spin size="small" />正在检查并处理素材</div>}
                        {media.kind === "video" && !(person && wholeVideo) && d.route === "model" && isWan30(config.videoModel) && <VideoReferenceTrimmer media={media} disabled={locked} onBusyChange={setTrimming} onApply={(file) => wb.edit({ media: (useVideoWorkbenchStore.getState().drafts["content-replace"]?.media || []).map((item) => item.id === media.id ? { ...item, ...file } : item) }, "materials")} />}
                    </div>
                )}
                {videoInput ? <>
                    <div hidden={Boolean(media) && !referenceImportOpen}>
                        <Tabs
                            size="small"
                            activeKey={referenceImportTab}
                            onChange={setReferenceImportTab}
                            destroyOnHidden={false}
                            aria-label="原视频导入方式"
                            items={[
                                { key: "upload", label: "上传视频", disabled: locked, children: upload },
                                { key: "link", label: "链接提取", disabled: locked, children: <VideoLinkImport disabled={locked} source={media?.source} showRetention={false} onImport={(text, signal) => wb.importLink(text, role, signal)} /> },
                            ]}
                        />
                    </div>
                    <VideoReferenceRetention key={media?.id} media={media} completed={Boolean(d.final || d.edited || d.video)} disabled={locked} onReimport={(text, signal) => wb.importLink(text, role, signal)} />
                </> : upload}
            </section>
        );
    };
    const showRecord = async (record: VideoRecord) => {
        if (!record.result) return;
        try {
            const result = await restoreWorkbenchFile(record.result);
            const source = (record.replacementInput || record.replacementDraft)?.media.find((m) => m.role === "reference");
            setHistoryPreview({ record, result, source: source ? await restoreWorkbenchFile(source).catch(() => undefined) : undefined });
            setTab("current");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "读取历史作品失败"));
        }
    };
    const reconcile = (record: VideoRecord) => {
        let predictionId = "";
        modal.confirm({
            title: "核对并关联已有平台任务",
            content: (
                <div className="space-y-3">
                    <p>如果任务状态暂未返回，请填写原任务编号；此操作不会创建新任务。</p>
                    <Input
                        placeholder="原任务编号"
                        onChange={(event) => {
                            predictionId = event.target.value.trim();
                        }}
                    />
                </div>
            ),
            okText: "核对关联",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await reconcileReplicateTask(record.replicateTask!.id, predictionId);
                    message.success("已关联，可恢复查询取得结果");
                } catch (error) {
                    message.error(publicServiceText(error instanceof Error ? error.message : "关联失败"));
                    throw error;
                }
            },
        });
    };
    const point = (event: PointerEvent<HTMLDivElement>) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
    };
    const submit = headSwap ? null : (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs" style={muted}>
                <span>{cloud ? (currentQuote ? `预计 ${currentQuote.credits.toLocaleString()} 算力点` : "准备素材后查看本次费用") : d.route === "worker" ? "使用当前处理服务" : "按所选模型渠道计费"}</span>
                {cloud && platformToken && (
                    <Button size="small" type="link" loading={quoting} disabled={Boolean(blocked) || locked} onClick={() => void prepareQuote()}>
                        查看本次费用
                    </Button>
                )}
            </div>
            {cloud && person && currentQuote && (
                <div className="break-words text-xs leading-relaxed" style={muted}>
                    {currentQuote.usedDefaultDuration ? "未能读取素材时长，使用后台备用时长" : currentQuote.durationSeconds && currentQuote.durationSeconds > 0 ? `素材时长 ${currentQuote.durationSeconds.toFixed(2)} 秒` : "未能读取素材时长"}
                    {currentQuote.calculation ? ` · ${currentQuote.calculation}` : ""}
                </div>
            )}
            {cloud && !platformToken ? (
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">登录后开始替换</span>
                    <UserStatusActions accountOnly />
                </div>
            ) : (
                <Button
                    type="primary"
                    size="large"
                    block
                    icon={<Sparkles size={17} />}
                    loading={busy}
                    disabled={Boolean(blocked || currentQuote?.submissionBlocked || (currentQuote && !currentQuote.available)) || locked || quoting}
                    onClick={() => {
                        setHistoryPreview(null);
                        setTab("current");
                        void wb.run("video");
                    }}
                >
                    开始替换
                </Button>
            )}
            {!busy && (
                <div aria-live="polite" className="text-xs" style={muted}>
                    {publicServiceText(blocked || currentQuote?.submissionBlocked || (currentQuote && !currentQuote.available ? currentQuote.reason : "") || (cloud ? "提交前确认费用，取消不创建收费任务。" : "请核对当前服务与素材后开始处理。"))}
                </div>
            )}
            {quoteError && (
                <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                    {quoteError}
                </div>
            )}
        </div>
    );

    if (!ready) return <div className="p-12 text-center"><Spin /></div>;

    return (
        <main className="flex h-full min-h-0 flex-col" style={{ color: token.colorText }}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <Link to="/video" className="inline-flex items-center gap-1 text-sm" style={muted}>
                        <ArrowLeft size={15} />
                        视频制作
                    </Link>
                    <h1 className="text-lg font-semibold">内容替换</h1>
                </div>
                <div className="flex items-center gap-2">
                    <Button type={tab === "history" ? "primary" : "text"} size="small" icon={<History size={14} />} onClick={() => setTab("history")}>历史任务</Button>
                    <Button type="text" size="small" disabled={locked || Boolean(wb.storageError)} icon={<Plus size={14} />} onClick={createTask}>新建任务</Button>
                </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="replacement-scroll">
                <div className={`mx-auto grid min-h-full gap-5 lg:h-full lg:min-h-0 ${tab === "history" ? "max-w-[1200px] grid-cols-1" : "max-w-[1800px] lg:grid-cols-[380px_minmax(0,1fr)]"}`}>
                    <section className={`${tab === "history" ? "hidden" : "flex"} min-h-0 flex-col rounded-xl border`} style={surface} aria-label="素材与设置">
                        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="replacement-input-scroll">
                            <Segmented
                                block
                                value={d.replacement}
                                disabled={locked}
                                options={Object.entries(replacementNames).map(([value, label]) => ({ value, label: `换${label}` }))}
                                onChange={(replacement) => wb.edit({ replacement: replacement as VideoDraft["replacement"], regions: [], replacementSeedTime: undefined }, "video")}
                            />
                            {person && (headSwap || new URLSearchParams(location.search).get("model") === "headswap") && <Alert type="info" showIcon title={RETIRED_HEAD_SWAP_MESSAGE} />}
                            {materialField("reference", "video/*", "原视频（必填）", cloud && !person && !d.maskedEdit ? "当前模型支持 2–10 秒原视频" : "保留动作与镜头，上传后可预览")}
                            {materialField(imageRole, "image/*", `${replacementNames[d.replacement]}参考图（必填）`, person ? "人物清晰，尽量匹配原片景别" : d.replacement === "product" ? "上传清晰、完整的商品图片" : "上传希望替换成的背景图片")}
                            <div className="space-y-2 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                <div className="flex items-center gap-2">
                                    <Switch aria-label="去除原字幕" disabled={locked} checked={d.replaceSubtitles} onChange={(replaceSubtitles) => wb.edit({ replaceSubtitles }, "video")} />
                                    <span className="text-sm">去除原字幕</span>
                                </div>
                                <p className="m-0 text-xs" style={muted}>{d.replaceSubtitles ? "去掉原视频画面里已有的字幕。支持的模型会在替换内容时一起处理，无需另外操作。" : "不主动去除原视频中的字幕；替换内容时，模型仍可能改动画面里的文字。"}</p>
                                {d.replaceSubtitles && <>
                                    <div className="flex items-center gap-2">
                                        <Switch aria-label="去除后重新生成字幕" disabled={locked} checked={d.regenerateSubtitles === true} onChange={(regenerateSubtitles) => wb.edit({ regenerateSubtitles }, "video")} />
                                        <span className="text-sm">去除后重新生成字幕</span>
                                    </div>
                                    <p className="m-0 text-xs" style={muted}>{person && wholeVideo ? "根据原视频声音重新识别字幕，校对后生成带字幕的视频，也可下载字幕文件（SRT）。" : "根据原视频声音重新识别并添加字幕，识别文字可能需要校对。"}</p>
                                </>}
                                {subtitleUnavailable && <Alert className="mt-2" type="warning" showIcon title={subtitleUnavailable} />}
                            </div>
                            {(!cloud || !person || wholeVideo) && (
                                <label className="block">
                                    <div className="mb-2 font-medium">替换要求{!person ? "（必填）" : "（可选）"}</div>
                                    <Input.TextArea
                                        aria-label="替换要求"
                                        rows={3}
                                        disabled={locked}
                                        value={d.instructions}
                                        placeholder={
                                            person ? "描述人物替换要求与需要保留的内容" : d.replacement === "product" ? "例如：把手中的白色杯子替换成参考图中的蓝色杯子，保留人物动作与镜头。" : "例如：把室内背景替换成花园，保留人物、商品和镜头运动。"
                                        }
                                        onChange={(event) => wb.edit({ instructions: event.target.value }, "video")}
                                    />
                                </label>
                            )}
                            {cloud && !person && d.maskedEdit && materialField("mask", "image/*,video/*", "编辑掩膜（必填）", "白色区域改动，黑色区域保留")}
                            {!(person && wholeVideo) && <div className="space-y-2 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span>{cloud ? REPLICATE_MODEL_NAMES[operation] : d.route === "worker" ? "增强处理服务" : "平台视频服务"}</span>
                                    {cloud && (
                                        <Button
                                            type="text"
                                            size="small"
                                            aria-label="刷新模型状态"
                                            disabled={locked || quoting}
                                            icon={<RefreshCw size={14} />}
                                            loading={modelsLoading}
                                            onClick={() => {
                                                setQuote(null);
                                                setModelRevision((v) => v + 1);
                                            }}
                                        />
                                    )}
                                </div>
                                {cloud && person ? (
                                    <div className="flex items-center gap-2 text-xs" style={muted}>
                                        <Select
                                            aria-label="人物替换分辨率"
                                            size="small"
                                            disabled={locked}
                                            value={d.replicateResolution}
                                            options={[
                                                { value: "480p", label: "480p" },
                                                { value: "720p", label: "720p" },
                                            ]}
                                            onChange={(replicateResolution) => wb.edit({ replicateResolution }, "video")}
                                        />
                                        <span>合并原音轨</span>
                                    </div>
                                ) : cloud && !d.maskedEdit ? (
                                    <div className="text-xs" style={muted}>
                                        720p · 原音轨 · 输出时长跟随原片
                                    </div>
                                ) : null}
                                <div className="text-xs" style={muted}>
                                    {publicServiceText(unavailable || (cloud ? model?.billingDescription || "平台按当前规格计费" : "按当前处理方式执行"))}
                                </div>
                            </div>}
                            {person && wholeVideo && <ReplacementBatchPanel key={`${d.replacementTaskId}:${batchRevision}`} subtitleBlocked={subtitleUnavailable} workspace={batchWorkspace}
                                detailsOpen={detailsOpen && showBatchWorkspace} onDetailsChange={setDetailsOpen}
                                onOpenWorkspace={() => { setTab("current"); setHistoryPreview(null); }} />}
                            {!(person && wholeVideo) && <Collapse
                                size="small"
                                items={[
                                    {
                                        key: "advanced",
                                        label: "高级设置",
                                        children: (
                                            <div className="space-y-4">
                                                {administrator && !person && <Select
                                                    className="w-full"
                                                    aria-label="处理方式"
                                                    disabled={locked}
                                                    value={d.route}
                                                    options={[
                                                        { value: "replicate", label: "平台智能处理（推荐）" },
                                                        { value: "model", label: "自定义模型" },
                                                        { value: "worker", label: "处理服务" },
                                                    ]}
                                                    onChange={(route) => wb.edit({ route }, "video")}
                                                />}
                                                {cloud && !person && (
                                                    <div className="space-y-2">
                                                        <div className="flex items-center gap-2">
                                                            <Switch aria-label="掩膜局部编辑" disabled={locked} checked={d.maskedEdit} onChange={(maskedEdit) => wb.edit({ maskedEdit }, "video")} />
                                                            <span>掩膜局部编辑</span>
                                                        </div>
                                                        <div className="text-xs" style={muted}>
                                                            使用局部精修服务，需要后台启用并上传编辑掩膜。
                                                        </div>
                                                    </div>
                                                )}
                                                {cloud && !person && <FeatureModelPicker capability="video" />}
                                                {d.route === "model" && (
                                                    <div className="space-y-3">
                                                        <ModelPicker config={config} capability="video" value={config.videoModel} onChange={(value) => updateConfig("videoModel", value)} onMissingConfig={() => openConfig(true)} fullWidth />
                                                        <Space wrap>
                                                            <Button disabled={locked} onClick={() => openConfig(true)}>
                                                                模型设置
                                                            </Button>
                                                            <Button disabled={locked} onClick={() => setSettingsOpen(true)}>
                                                                视频参数
                                                            </Button>
                                                        </Space>
                                                        <div className="text-xs" style={muted}>
                                                            所选模型必须支持原视频和参考图片；一般图生视频模型不能直接执行内容替换。
                                                        </div>
                                                    </div>
                                                )}
                                                {d.route === "worker" && (
                                                    <div className="space-y-3">
                                                        <Input disabled={locked} aria-label="处理服务地址" value={wb.worker.url} placeholder="处理服务地址" onChange={(event) => useVideoWorkbenchStore.getState().setWorker({ url: event.target.value })} />
                                                        <Input.Password
                                                            disabled={locked}
                                                            aria-label="处理服务令牌"
                                                            value={wb.worker.token}
                                                            placeholder="服务访问令牌（站内服务无需填写）"
                                                            onChange={(event) => useVideoWorkbenchStore.getState().setWorker({ token: event.target.value })}
                                                        />
                                                        <Button loading={checking} disabled={locked} onClick={() => setServiceRevision((v) => v + 1)}>
                                                            检查连接
                                                        </Button>
                                                        {serviceError && <Alert type="warning" showIcon title={serviceError} />}
                                                        {d.replacement === "product" && materialField("background", "image/*", "背景参考图（可选）", "仅增强处理服务使用此额外背景")}
                                                        {!person && (
                                                            <>
                                                                {materialField("mask", "image/*,video/*", "编辑掩膜（可选）", "移动主体建议使用动态掩膜，白色区域改动")}
                                                                <div className="flex items-center gap-2">
                                                                    <Switch aria-label="框选编辑区域" disabled={locked || !reference} checked={drawRegions} onChange={setDrawRegions} />
                                                                    <span>{d.replacement === "product" ? "框选要跟踪的商品" : "框选固定区域"}</span>
                                                                    <Button type="text" size="small" disabled={locked || !d.regions.length} onClick={() => wb.edit({ regions: [], replacementSeedTime: undefined }, "video")}>
                                                                        清空
                                                                    </Button>
                                                                </div>
                                                                {reference && (
                                                                    <div className="relative overflow-hidden rounded">
                                                                        <video ref={selectionVideo} className="block h-auto w-full" controls={!drawRegions} src={reference.url} />
                                                                        <div
                                                                            className="absolute inset-0"
                                                                            style={{ pointerEvents: drawRegions && !locked ? "auto" : "none", cursor: "crosshair" }}
                                                                            onPointerDown={(event) => {
                                                                                selectionVideo.current?.pause();
                                                                                selectionTime.current = selectionVideo.current?.currentTime || 0;
                                                                                event.currentTarget.setPointerCapture(event.pointerId);
                                                                                anchor.current = point(event);
                                                                                setDrawing({ ...anchor.current, width: 0, height: 0 });
                                                                            }}
                                                                            onPointerMove={(event) => {
                                                                                if (!anchor.current) return;
                                                                                const b = point(event);
                                                                                setDrawing({ x: Math.min(anchor.current.x, b.x), y: Math.min(anchor.current.y, b.y), width: Math.abs(b.x - anchor.current.x), height: Math.abs(b.y - anchor.current.y) });
                                                                            }}
                                                                            onPointerUp={(event) => {
                                                                                if (drawing?.width && drawing.height) wb.edit(d.replacement === "product" ? { regions: [drawing], replacementSeedTime: selectionTime.current } : { regions: [...d.regions, drawing] }, "video");
                                                                                anchor.current = null;
                                                                                setDrawing(null);
                                                                                event.currentTarget.releasePointerCapture(event.pointerId);
                                                                            }}
                                                                            onPointerCancel={() => {
                                                                                anchor.current = null;
                                                                                setDrawing(null);
                                                                            }}
                                                                        >
                                                                            {[...d.regions, ...(drawing ? [drawing] : [])].map((region, i) => (
                                                                                <div
                                                                                    key={i}
                                                                                    className="absolute border-2"
                                                                                    style={{
                                                                                        left: `${region.x * 100}%`,
                                                                                        top: `${region.y * 100}%`,
                                                                                        width: `${region.width * 100}%`,
                                                                                        height: `${region.height * 100}%`,
                                                                                        borderColor: token.colorPrimary,
                                                                                        background: token.colorPrimaryBg,
                                                                                        opacity: 0.55,
                                                                                    }}
                                                                                />
                                                                            ))}
                                                                        </div>
                                                                    </div>
                                                                )}
                                                                <div className="text-xs" style={muted}>
                                                                    {d.replacement === "product" ? `先暂停在商品清晰的画面，再打开框选。已选 ${d.regions.length} 个商品，选取时间 ${(d.replacementSeedTime || 0).toFixed(2)} 秒；系统跟踪整段视频，跟踪失败会在生成前停止。` : `已选 ${d.regions.length} 个固定区域；固定框会覆盖整个视频。`}
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ),
                                    },
                                ]}
                            />}
                        </div>
                        <div className="hidden shrink-0 border-t p-4 lg:block" style={{ borderColor: token.colorBorderSecondary }}>
                            {!(person && wholeVideo) && submit}
                        </div>
                    </section>
                    <section className={`flex min-h-0 min-w-0 flex-col lg:overflow-y-auto ${tab === "history" ? "" : "rounded-xl border"}`} style={tab === "history" ? undefined : surface} aria-label="任务与作品区">
                        <div className="px-4 pt-2">
                            {tab === "history" ? <div className="flex items-center gap-3 pb-3 pt-2"><Button size="small" type="text" icon={<ArrowLeft size={14} />} onClick={() => setTab("current")}>返回当前任务</Button><span className="text-sm font-medium">历史任务</span></div> : <Tabs
                                activeKey={tab}
                                onChange={setTab}
                                items={[
                                    { key: "current", label: "当前任务" },
                                    { key: "guide", label: "使用说明" },
                                ]}
                            />}
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 pt-0 sm:p-5 sm:pt-0">
                            {wb.storageError && <Alert type="error" showIcon title="本地保存异常" description={wb.storageError} />}
                            {busy && (
                                <Alert
                                    type="info"
                                    showIcon
                                    icon={<Spin size="small" />}
                                    title={active?.step || "正在准备替换任务"}
                                    description={
                                        <Space wrap>
                                            <Button size="small" onClick={wb.stop}>
                                                停止等待
                                            </Button>
                                            {(active?.workerJob || active?.replicateTask) && (
                                                <Button size="small" danger onClick={() => void wb.cancel()}>
                                                    取消处理任务
                                                </Button>
                                            )}
                                        </Space>
                                    }
                                />
                            )}
                            {!busy && active?.error && (
                                <Alert
                                    type={active.status === "failed" ? "error" : "warning"}
                                    showIcon
                                    closable
                                    onClose={() => wb.patch({ activeRecord: undefined })}
                                    title="最近一次任务反馈"
                                    description={
                                        <Space wrap>
                                            <span>{publicServiceText(active.error)}</span>
                                            {isPendingReplacement(active) && (
                                                <Button size="small" onClick={() => { setHistoryPreview(null); setTab("current"); void wb.resume(active); }}>
                                                    {active.replacementPipeline || isLegacyMaskedPersonRecord(active) ? "继续处理旧任务" : "恢复任务结果"}
                                                </Button>
                                            )}
                                            {active.status === "failed" && active.replicateBilling && (
                                                <Tag color={active.replicateBilling.refunded ? "success" : "warning"}>
                                                    {active.replicateBilling.refunded
                                                        ? `${active.replicateBilling.credits.toLocaleString()} 算力点已返还`
                                                        : "平台尚未确认返还算力点"}
                                                </Tag>
                                            )}
                                        </Space>
                                    }
                                />
                            )}
                            {tab === "current" && (
                                <>
                                    {historyPreview && (
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                            <span>
                                                历史作品 · {historyPreview.record.replacementInput ? replacementNames[historyPreview.record.replacementInput.replacement] : "内容替换"} · {new Date(historyPreview.record.createdAt).toLocaleString()}
                                            </span>
                                            <Button size="small" type="text" onClick={() => setHistoryPreview(null)}>
                                                返回当前制作
                                            </Button>
                                        </div>
                                    )}
                                    {wholeVideo && !historyPreview && <div ref={setBatchWorkspace} className="space-y-4 empty:hidden" />}
                                    {!showBatchWorkspace && <div className="grid flex-1 gap-4 xl:grid-cols-2">
                                        <div className="flex min-w-0 flex-col gap-3 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                            <div className="text-sm font-medium">原视频</div>
                                            {previewSource?.url ? (
                                                <video key={previewSource.url} src={previewSource.url} controls preload="metadata" onError={() => { if (!historyPreview) setSourcePreviewError(true); }} onLoadedMetadata={(event) => { if (!historyPreview && !event.currentTarget.videoWidth) setSourcePreviewError(true); }} className="my-auto max-h-[60vh] w-full rounded-lg object-contain" />
                                            ) : (
                                                <div className="flex min-h-48 flex-1 items-center justify-center">
                                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={previewSource?.referenceId && !previewSource.url ? "参考原片已清理，生成作品仍保留" : historyPreview ? "此记录未保存原片" : "上传后立即预览原视频"} />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex min-w-0 flex-col gap-3 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                            <div className="text-sm font-medium">替换结果</div>
                                            {result ? (
                                                <video key={result.storageKey || result.url} src={result.url} controls preload="metadata" onError={() => setPreviewError(true)} className="my-auto max-h-[60vh] w-full rounded-lg object-contain" />
                                            ) : busy && !historyPreview ? (
                                                <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-4 px-3 py-8 text-center" role="status" aria-live="polite">
                                                    <LoaderCircle size={42} className="animate-spin motion-reduce:animate-none" style={{ color: token.colorPrimary }} aria-hidden />
                                                    <div className="text-base font-medium">{publicServiceText(active?.step || "正在准备替换任务")}</div>
                                                    <div className="text-xs" style={muted}>完成后将自动显示结果</div>
                                                </div>
                                            ) : (
                                                <div className="flex min-h-48 flex-1 items-center justify-center">
                                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="处理完成后在这里对照结果" />
                                                </div>
                                            )}
                                        </div>
                                    </div>}
                                    {sourcePreviewError && previewSource?.url && !historyPreview && (
                                        <Alert type="warning" showIcon title="原视频编码不兼容" description="可转换为兼容的 MP4 后继续预览；转换失败会保留原素材。" action={<Button size="small" loading={repairingSource} disabled={locked} onClick={() => void repairSource()}>修复视频预览</Button>} />
                                    )}
                                    {previewError && <Alert type="warning" showIcon title="当前浏览器无法播放此编码" description="文件仍可下载，请从历史任务核对作品。" />}
                                    {result ? (
                                        <div role="group" aria-label="成片操作" className="flex flex-wrap gap-2">
                                            <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                                下载视频
                                            </Button>
                                            <Button icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset(result, historyPreview ? { title: "内容替换历史作品", cover: null, tags: "" } : undefined)}>保存素材</Button>
                                            <Button icon={<FileText size={15} />} onClick={() => setDetailsOpen(true)}>任务详情</Button>
                                        </div>
                                    ) : !showBatchWorkspace && (
                                        <div className="text-xs" style={muted}>
                                            先选替换对象，再上传原视频与对应参考图。作品与草稿保存在当前浏览器。
                                        </div>
                                    )}
                                </>
                            )}
                            {tab === "history" && <>
                                <p className="text-xs" style={muted}>本机记录仅保存在此浏览器；账号任务需登录查看。</p>
                                {!platformToken && <div className="text-xs" style={muted}>登录后可同时查看在线人物替换任务。</div>}
                                <VideoTaskHistory disabled={locked || Boolean(wb.storageError)} loading={onlineHistory.loading}
                                    error={onlineHistory.error ? publicServiceText(onlineHistory.error) : undefined} onReload={() => void onlineHistory.refresh()}
                                    items={taskGroups.map<VideoHistoryItem>((group) => {
                                        const local = group.snapshot || group.latest;
                                        const archived = group.jobs.length ? group.jobs.every((job) => job.archived) : group.keys.some((key) => archivedTasks[key]);
                                        return {
                                            id: group.id, title: group.title, kind: group.kind, status: group.status, updatedAt: group.updatedAt,
                                            source: group.jobs.length ? "账号任务" : "仅本机", archived, processing: group.processing, hasResult: group.hasResult,
                                            onView: group.resultJob ? () => void openOnlineJob(group.resultJob!) : group.resultRecord ? () => void showRecord(group.resultRecord!) : undefined,
                                            onContinue: group.job ? () => void openOnlineJob(group.job!) : local && (local.replacementDraft || local.replacementInput) ? () => void continueLocalTask(local) : undefined,
                                            onArchive: (value) => archiveHistoryTask(group, value),
                                            details: (close) => <div className="space-y-4">
                                                {group.jobs.map((job) => <section key={job.id} className="space-y-2">
                                                    <Descriptions size="small" column={1} items={[
                                                        { key: "id", label: "任务编号", children: job.id },
                                                        { key: "status", label: "任务状态", children: replacementHistoryStates[job.status] },
                                                        { key: "model", label: "模型", children: job.modelLabel || job.model },
                                                        { key: "spec", label: "规格", children: `${job.resolution.replace(/p$/i, "")}p · ${job.seconds} 秒` },
                                                        { key: "budget", label: "模型预算", children: `${job.credits} 点，实际扣费与退款以使用日志为准` },
                                                        { key: "progress", label: "进度", children: publicServiceText(job.step) },
                                                    ]} />
                                                    {(job.error || job.captionError) && <Alert type="warning" title={publicServiceText(job.error || job.captionError || "")} />}
                                                    <Button size="small" disabled={locked} onClick={() => { close(); void openOnlineJob(job); }}>打开此任务</Button>
                                                </section>)}
                                                {group.records.filter((record) => record.stage !== "draft").map((record) => <section key={record.id} className="space-y-2 border-t pt-3" style={{ borderColor: token.colorBorderSecondary }}>
                                                    <div className="text-sm">{recordNames[record.status]} · {record.step || "处理记录"}</div>
                                                    <div className="text-xs" style={muted}>{new Date(record.createdAt).toLocaleString()}</div>
                                                    {record.error && <div className="text-xs" style={{ color: token.colorWarningText }}>{publicServiceText(record.error)}{record.replicateBilling ? ` · ${record.replicateBilling.refunded ? `${record.replicateBilling.credits} 点已返还` : "平台尚未确认退款"}` : ""}</div>}
                                                    <Space wrap>
                                                        {record.result && <Button size="small" disabled={locked} onClick={() => { close(); void showRecord(record); }}>查看此结果</Button>}
                                                        {!archived && record.status !== "completed" && hasReplacementRecovery(record) && <Button size="small" disabled={locked} onClick={() => { close(); void continueLocalTask(record, true); }}>恢复查询</Button>}
                                                        {administrator && record.replicateTask && record.status === "interrupted" && <Button size="small" disabled={locked} onClick={() => { close(); reconcile(record); }}>核对平台任务</Button>}
                                                    </Space>
                                                </section>)}
                                                {!group.jobs.length && !group.records.some((record) => record.stage !== "draft") && <div className="text-sm" style={muted}>草稿已保存，尚未提交生成。</div>}
                                            </div>,
                                        };
                                    })} />
                            </>}
                            {tab === "guide" && (
                                <div className="space-y-5 text-sm">
                                    <h2 className="text-base font-medium">如何替换{replacementNames[d.replacement]}</h2>
                                    <ol className="list-decimal space-y-3 pl-5">
                                        <li>上传清晰的原视频和{replacementNames[d.replacement]}参考图。</li>
                                        <li>{person ? "人物替换上传原视频和单张人物参考图，无需框选人物或提前拆分；系统按需分析镜头与分段，确认费用后处理，并保留原音轨。" : "商品和背景编辑需填写具体要求；平台编辑服务使用 2–10 秒原视频、720p 和原音轨。"}</li>
                                        <li>查看本次费用，提交前在确认弹窗核对处理方式、时长与算力点。</li>
                                        <li>处理后对照原片，检查边缘、动作和主体一致性，再下载或保存。</li>
                                    </ol>
                                    <div className="space-y-2" style={muted}>
                                        <p>替换效果受素材、动作和模型影响，背景也可能变化；商品细节与镜头切换需逐段检查。</p>
                                        <p>停止等待只停止本地查询，已提交任务仍可能运行；恢复查询沿用原任务。继续处理旧任务涉及后续收费步骤时仍需确认费用；取消以服务端最终状态为准。</p>
                                        <p>当前作品和草稿保存在本浏览器，不会自动同步到其他浏览器。</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
            {tab !== "history" && <div className="shrink-0 border-t p-3 lg:hidden" style={surface}>
                {!(person && wholeVideo) && submit}
            </div>}
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
            {result && !showBatchWorkspace && <VideoTaskDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} record={resultRecord} result={result} />}
            <Modal title="视频模型参数" open={settingsOpen} onCancel={() => setSettingsOpen(false)} footer={null}>
                <VideoSettingsPanel config={config} onConfigChange={updateConfig} theme={canvasThemes[themeMode]} className="space-y-4" />
            </Modal>
        </main>
    );
}

