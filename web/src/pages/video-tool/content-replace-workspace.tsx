import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, App, Button, Collapse, Empty, Input, Modal, Segmented, Select, Space, Spin, Switch, Tabs, Tag, Upload, theme } from "antd";
import { ArrowLeft, Download, FolderPlus, Grid2X2, Image as ImageIcon, RefreshCw, Sparkles, Video, X } from "lucide-react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { ModelPicker } from "@/components/model-picker";
import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { videoReferenceError } from "@/lib/video-capabilities";
import { getReplicateModels, publicServiceText, reconcileReplicateTask, REPLICATE_MODEL_NAMES, type ReplicateOperation, type ReplicateQuote } from "@/services/api/replicate";
import { getWorkerCapabilities, workbenchMediaBlob } from "@/services/api/video-worker";
import type { UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { MediaRole, SubtitleRegion, VideoDraft, VideoRecord, WorkerCapabilities } from "@/types/video-workbench";
import { restoreWorkbenchFile, useVideoWorkbench } from "./use-video-workbench";

const replacementNames = { person: "人物", product: "商品", background: "背景" };
const recordNames = { running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待暂停" };

export default function ContentReplaceWorkspace() {
    const wb = useVideoWorkbench("content-replace");
    const { draft: d, busy } = wb;
    const { token } = theme.useToken();
    const { message, modal } = App.useApp();
    const location = useLocation();
    const config = useEffectiveConfig();
    const openConfig = useConfigStore((s) => s.openConfigDialog);
    const updateConfig = useConfigStore((s) => s.updateConfig);
    const themeMode = useThemeStore((s) => s.theme);
    const platformToken = useUserStore((s) => s.token);
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
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [assetRole, setAssetRole] = useState<{ role: MediaRole; accept: string } | null>(null);
    const [uploading, setUploading] = useState(false);
    const uploadingRef = useRef(false);
    const [uploadErrors, setUploadErrors] = useState<Partial<Record<MediaRole, string>>>({});
    const [quoting, setQuoting] = useState(false);
    const [quote, setQuote] = useState<{ key: string; value: ReplicateQuote } | null>(null);
    const [quoteError, setQuoteError] = useState("");
    const quoteController = useRef<AbortController | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const [historyPreview, setHistoryPreview] = useState<{ record: VideoRecord; result: UploadedFile; source?: UploadedFile } | null>(null);
    const [drawRegions, setDrawRegions] = useState(false);
    const [drawing, setDrawing] = useState<SubtitleRegion | null>(null);
    const anchor = useRef<{ x: number; y: number } | null>(null);
    const person = d.replacement === "person";
    const cloud = d.route === "replicate";
    const locked = busy || uploading;
    const reference = d.media.find((m) => m.role === "reference" && m.kind === "video");
    const imageRole = d.replacement === "background" ? "background" : "model";
    const image = d.media.find((m) => m.role === imageRole && m.kind === "image");
    const operation: ReplicateOperation = person ? "replace-person" : d.maskedEdit ? "masked-edit" : "video-edit";
    const model = models.find((m) => m.operation === operation);
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask));
    const inputKey = JSON.stringify([
        d.route,
        d.replacement,
        d.maskedEdit,
        d.replicateResolution,
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
    const result = historyPreview?.result || d.final || d.edited || d.video;
    const previewSource = historyPreview ? historyPreview.source : reference;
    const surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };
    const muted = { color: token.colorTextSecondary };

    useEffect(() => {
        if (!wb.hydrated || appliedSearch.current === location.search) return;
        appliedSearch.current = location.search;
        const query = new URLSearchParams(location.search);
        const replacement = query.get("replacement");
        if (replacement === "person" || replacement === "product" || replacement === "background") wb.edit({ replacement, route: "replicate", maskedEdit: query.get("masked") === "1" }, "video");
    }, [wb.hydrated, location.search]);
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
        if (!wb.hydrated || d.route !== "worker") return;
        let disposed = false;
        setCapabilities(null);
        setServiceError("");
        setChecking(true);
        void getWorkerCapabilities(wb.worker)
            .then((value) => {
                if (!disposed) setCapabilities(value);
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
    }, [wb.hydrated, d.route, wb.worker.url, wb.worker.token, platformToken, serviceRevision]);
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

    let unavailable = "";
    if (cloud) unavailable = !platformToken ? "登录后使用平台智能处理" : modelsLoading ? "正在读取服务状态" : !model?.available ? publicServiceText(model?.reason || modelError || "当前平台服务暂不可用") : "";
    else if (d.route === "worker") {
        const capability = capabilities?.find((c) => c.name === (person ? "replace-person" : "replace-product"));
        unavailable = checking ? "正在检查处理服务" : !capability?.available ? serviceError || capability?.reason || "当前处理服务尚未配置替换能力" : "";
    } else unavailable = !config.videoModel ? "请在高级设置中选择视频模型" : videoReferenceError(config, config.videoModel, 1, 1, 0);
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
    const blocked = unavailable || missing || (pending ? "已有已提交任务，请先恢复查询结果" : "");
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
        if (busy || uploadingRef.current) return;
        uploadingRef.current = true;
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
        return (
            <section className="min-w-0" data-material-role={role}>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs" style={muted}>
                        {role === "reference" ? "视频" : accept === "image/*" ? "单张图片" : "图片 / 视频"}
                    </span>
                </div>
                {media && (
                    <div className="mb-2 space-y-2">
                        {media.kind === "image" ? <img src={media.url} alt={media.name} className="max-h-40 w-full rounded-lg object-contain" /> : <video src={media.url} controls preload="metadata" className="max-h-44 w-full rounded-lg" />}
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs" title={media.name}>
                                {media.name}
                            </span>
                            <Button type="text" size="small" disabled={locked} icon={<X size={14} />} aria-label={`移除${label}`} onClick={() => wb.removeMedia(media.id)} />
                        </div>
                        <div className="text-xs" style={muted}>
                            {[formatBytes(media.bytes), media.width && media.height ? `${media.width}×${media.height}` : "", media.durationMs ? formatDuration(media.durationMs) : ""].filter(Boolean).join(" · ")}
                        </div>
                    </div>
                )}
                <Upload.Dragger
                    height={112}
                    accept={accept}
                    multiple={false}
                    showUploadList={false}
                    disabled={locked}
                    beforeUpload={(file, files) => {
                        if (files.length > 1) setUploadErrors((errors) => ({ ...errors, [role]: "请每次选择一份素材，替换图仅使用单张图片" }));
                        else void addFile(file, role, accept);
                        return Upload.LIST_IGNORE;
                    }}
                    style={{ background: token.colorFillQuaternary }}
                >
                    <div className="flex items-center justify-center gap-2 px-2 text-sm" style={muted}>
                        {uploading ? <Spin size="small" /> : accept === "image/*" ? <ImageIcon size={19} /> : <Video size={19} />}
                        <span>{media ? "点击或拖拽替换素材" : "点击或拖拽上传"}</span>
                    </div>
                    <div className="mt-1 px-3 text-xs" style={muted}>
                        {hint}
                    </div>
                </Upload.Dragger>
                <Button type="text" className="mt-1" size="small" disabled={locked} onClick={() => setAssetRole({ role, accept })}>
                    从我的素材选择
                </Button>
                {uploadErrors[role] && (
                    <div role="alert" className="mt-1 text-xs" style={{ color: token.colorError }}>
                        {uploadErrors[role]}
                    </div>
                )}
            </section>
        );
    };
    const showRecord = async (record: VideoRecord) => {
        if (!record.result) return;
        try {
            const result = await restoreWorkbenchFile(record.result);
            const source = record.replacementInput?.media.find((m) => m.role === "reference");
            setHistoryPreview({ record, result, source: source ? await restoreWorkbenchFile(source) : undefined });
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
    const submit = (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs" style={muted}>
                <span>{cloud ? (currentQuote ? `预计 ${currentQuote.credits.toLocaleString()} 算力点` : "准备素材后查看本次费用") : d.route === "worker" ? "使用当前处理服务" : "按所选模型渠道计费"}</span>
                {cloud && platformToken && (
                    <Button size="small" type="link" loading={quoting} disabled={Boolean(blocked) || locked} onClick={() => void prepareQuote()}>
                        查看本次费用
                    </Button>
                )}
            </div>
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
                <span className="hidden text-sm sm:block" style={muted}>
                    上传原片与参考图，替换人物、商品或背景
                </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="replacement-scroll">
                <div className="mx-auto grid min-h-full max-w-[1800px] gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[380px_minmax(0,1fr)]">
                    <section className="flex min-h-0 flex-col rounded-xl border" style={surface} aria-label="素材与设置">
                        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="replacement-input-scroll">
                            <Segmented
                                block
                                value={d.replacement}
                                disabled={locked}
                                options={Object.entries(replacementNames).map(([value, label]) => ({ value, label: `换${label}` }))}
                                onChange={(replacement) => wb.edit({ replacement: replacement as VideoDraft["replacement"] }, "video")}
                            />
                            {materialField("reference", "video/*", "原视频（必填）", cloud && !person && !d.maskedEdit ? "当前模型支持 2–10 秒原视频" : "保留动作与镜头，上传后可预览")}
                            {materialField(imageRole, "image/*", `${replacementNames[d.replacement]}参考图（必填）`, person ? "人物清晰，尽量匹配原片景别" : d.replacement === "product" ? "上传清晰、完整的商品图片" : "上传希望替换成的背景图片")}
                            {(!cloud || !person) && (
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
                            <div className="space-y-2 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
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
                            </div>
                            <Collapse
                                size="small"
                                items={[
                                    {
                                        key: "advanced",
                                        label: "高级设置",
                                        children: (
                                            <div className="space-y-4">
                                                <Select
                                                    className="w-full"
                                                    aria-label="处理方式"
                                                    disabled={locked}
                                                    value={d.route}
                                                    options={[
                                                        { value: "replicate", label: "平台智能处理（推荐）" },
                                                        { value: "model", label: "已配置的视频模型" },
                                                        { value: "worker", label: "增强处理服务" },
                                                    ]}
                                                    onChange={(route) => wb.edit({ route }, "video")}
                                                />
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
                                                        {d.replacement !== "background" && materialField("background", "image/*", "背景参考图（可选）", "仅增强处理服务使用此额外背景")}
                                                        {!person && (
                                                            <>
                                                                {materialField("mask", "image/*,video/*", "编辑掩膜（可选）", "移动主体建议使用动态掩膜，白色区域改动")}
                                                                <div className="flex items-center gap-2">
                                                                    <Switch aria-label="框选编辑区域" disabled={locked || !reference} checked={drawRegions} onChange={setDrawRegions} />
                                                                    <span>框选固定区域</span>
                                                                    <Button type="text" size="small" disabled={locked || !d.regions.length} onClick={() => wb.edit({ regions: [] }, "video")}>
                                                                        清空
                                                                    </Button>
                                                                </div>
                                                                {reference && (
                                                                    <div className="relative overflow-hidden rounded">
                                                                        <video className="block h-auto w-full" controls src={reference.url} />
                                                                        <div
                                                                            className="absolute inset-0"
                                                                            style={{ pointerEvents: drawRegions && !locked ? "auto" : "none", cursor: "crosshair" }}
                                                                            onPointerDown={(event) => {
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
                                                                                if (drawing?.width && drawing.height) wb.edit({ regions: [...d.regions, drawing] }, "video");
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
                                                                    已选 {d.regions.length} 个固定区域；固定框会覆盖整个视频，不能跟随移动主体。
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                        </div>
                        <div className="hidden shrink-0 border-t p-4 lg:block" style={{ borderColor: token.colorBorderSecondary }}>
                            {submit}
                        </div>
                    </section>
                    <section className="flex min-h-0 min-w-0 flex-col rounded-xl border lg:overflow-y-auto" style={surface} aria-label="作品区">
                        <div className="px-4 pt-2">
                            <Tabs
                                activeKey={tab}
                                onChange={setTab}
                                items={[
                                    { key: "current", label: "当前结果" },
                                    { key: "history", label: `本浏览器作品${wb.records.length ? ` (${wb.records.length})` : ""}` },
                                    { key: "guide", label: "使用说明" },
                                ]}
                            />
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
                            {!busy && pending && (
                                <Alert
                                    type="info"
                                    showIcon
                                    title="已有任务可恢复查询"
                                    description={
                                        <Button
                                            size="small"
                                            onClick={() => {
                                                setHistoryPreview(null);
                                                setTab("current");
                                                void wb.resume(pending);
                                            }}
                                        >
                                            恢复任务结果
                                        </Button>
                                    }
                                />
                            )}
                            {!busy && active?.error && <Alert type={active.status === "failed" ? "error" : "warning"} showIcon title="最近一次任务反馈" description={publicServiceText(active.error)} />}
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
                                    <div className="grid flex-1 gap-4 xl:grid-cols-2">
                                        <div className="flex min-w-0 flex-col gap-3 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                            <div className="text-sm font-medium">原视频</div>
                                            {previewSource ? (
                                                <video key={previewSource.storageKey || previewSource.url} src={previewSource.url} controls preload="metadata" className="my-auto max-h-[60vh] w-full rounded-lg object-contain" />
                                            ) : (
                                                <div className="flex min-h-48 flex-1 items-center justify-center">
                                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={historyPreview ? "此记录未保存原片" : "上传后立即预览原视频"} />
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex min-w-0 flex-col gap-3 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                            <div className="text-sm font-medium">替换结果</div>
                                            {result ? (
                                                <video key={result.storageKey || result.url} src={result.url} controls preload="metadata" onError={() => setPreviewError(true)} className="my-auto max-h-[60vh] w-full rounded-lg object-contain" />
                                            ) : (
                                                <div className="flex min-h-48 flex-1 items-center justify-center">
                                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="处理完成后在这里对照结果" />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {previewError && <Alert type="warning" showIcon title="当前浏览器无法播放此编码" description="文件仍可下载，请从任务记录核对作品。" />}
                                    {result ? (
                                        <Space wrap>
                                            <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                                下载视频
                                            </Button>
                                            {!historyPreview && (
                                                <>
                                                    <Button icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset()}>
                                                        保存素材
                                                    </Button>
                                                    <Button icon={<Grid2X2 size={15} />} onClick={() => void wb.toCanvas()}>
                                                        加入新画布
                                                    </Button>
                                                </>
                                            )}
                                        </Space>
                                    ) : (
                                        <div className="text-xs" style={muted}>
                                            先选替换对象，再上传原视频与对应参考图。作品与草稿保存在当前浏览器。
                                        </div>
                                    )}
                                </>
                            )}
                            {tab === "history" &&
                                (wb.records.length ? (
                                    wb.records.map((record) => (
                                        <article key={record.id} className="space-y-3 rounded-lg border p-4" style={{ borderColor: token.colorBorderSecondary }}>
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <span>{record.replacementInput ? `换${replacementNames[record.replacementInput.replacement]}` : "内容替换任务"}</span>
                                                <Tag color={record.status === "completed" ? "success" : record.status === "failed" ? "error" : "processing"}>{recordNames[record.status]}</Tag>
                                            </div>
                                            <div className="text-xs" style={muted}>
                                                {new Date(record.createdAt).toLocaleString()} · {record.step || "等待处理"}
                                            </div>
                                            {record.replacementInput && (
                                                <div className="truncate text-xs" style={muted}>
                                                    {record.replacementInput.media.find((m) => m.role === "reference")?.name}
                                                </div>
                                            )}
                                            {record.error && <Alert type="warning" title={record.error} />}
                                            <Space wrap>
                                                {record.result && (
                                                    <>
                                                        <Button size="small" onClick={() => void showRecord(record)}>
                                                            查看作品
                                                        </Button>
                                                        <Button size="small" onClick={() => void wb.download(record.result!)}>
                                                            下载视频
                                                        </Button>
                                                    </>
                                                )}
                                                {record.status !== "completed" && (record.replicateTask || record.modelTask || record.workerJob) && (
                                                    <Button
                                                        size="small"
                                                        disabled={locked}
                                                        onClick={() => {
                                                            setHistoryPreview(null);
                                                            setTab("current");
                                                            void wb.resume(record);
                                                        }}
                                                    >
                                                        恢复查询
                                                    </Button>
                                                )}
                                                {administrator && record.replicateTask && record.status === "interrupted" && (
                                                    <Button size="small" disabled={locked} onClick={() => reconcile(record)}>
                                                        核对平台任务
                                                    </Button>
                                                )}
                                            </Space>
                                        </article>
                                    ))
                                ) : (
                                    <Empty description="本浏览器尚无内容替换记录" />
                                ))}
                            {tab === "guide" && (
                                <div className="space-y-5 text-sm">
                                    <h2 className="text-base font-medium">如何替换{replacementNames[d.replacement]}</h2>
                                    <ol className="list-decimal space-y-3 pl-5">
                                        <li>上传清晰的原视频和{replacementNames[d.replacement]}参考图。</li>
                                        <li>{person ? "人物替换使用单张人物图，平台服务可选 480p / 720p 并合并原音轨。" : "商品和背景编辑需填写具体要求；平台编辑服务使用 2–10 秒原视频、720p 和原音轨。"}</li>
                                        <li>查看本次费用，提交前在确认弹窗核对处理方式、时长与算力点。</li>
                                        <li>处理后对照原片，检查边缘、动作和主体一致性，再下载或保存。</li>
                                    </ol>
                                    <div className="space-y-2" style={muted}>
                                        <p>替换效果受素材、动作和模型影响；商品细节与镜头切换需逐段检查。</p>
                                        <p>停止等待只停止本地查询，已提交任务仍可能运行；恢复查询不会新建任务。取消任务以服务端最终状态为准。</p>
                                        <p>当前作品和草稿保存在本浏览器，不会自动同步到其他浏览器。</p>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
            <div className="shrink-0 border-t p-3 lg:hidden" style={surface}>
                {submit}
            </div>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
            <Modal title="视频模型参数" open={settingsOpen} onCancel={() => setSettingsOpen(false)} footer={null}>
                <VideoSettingsPanel config={config} onConfigChange={updateConfig} theme={canvasThemes[themeMode]} className="space-y-4" />
            </Modal>
        </main>
    );
}

