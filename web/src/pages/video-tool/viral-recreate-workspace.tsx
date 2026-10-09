import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Collapse, Empty, Input, InputNumber, Mentions, Modal, Select, Space, Spin, Switch, Tabs, Upload, theme } from "antd";
import { ArrowLeft, Download, Expand, FolderPlus, Grid2X2, Images, RefreshCw, Sparkles, X } from "lucide-react";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useCopyText } from "@/hooks/use-copy-text";
import { computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { formatBytes } from "@/lib/image-utils";
import { materialMentionError, supportedVideoInputModes, videoInputMode, videoProfile } from "@/lib/video-capabilities";
import { VideoModelOption } from "@/components/video-model-option";
import { publicServiceText, REPLICATE_VIDEO_MODEL, isReplicateVideoModel, reconcileReplicateTask } from "@/services/api/replicate";
import { getWorkerCapabilities, workbenchMediaBlob } from "@/services/api/video-worker";
import type { VideoPrice } from "@/services/api/video";
import { imageToDataUrl } from "@/services/image-storage";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { StoreVideoSettings, VideoRecord } from "@/types/video-workbench";
import { useVideoCreationConfig } from "../video/use-video-creation-config";
import { normalizeStoreSettings, storeVideoSettings } from "./store-explore-request";
import { viralFrameMaterials, viralImageCandidates, viralMaterialLabels, viralReference, viralSource, viralVideoConfig, viralVideoError, viralVideoMaterials } from "./viral-recreate-request";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";

type Role = "reference" | "product" | "model" | "first-frame";
type Editor = "analysis" | "transcript" | "viralFacts" | "viralProductAnalysis" | "instructions" | "script";
const editorNames: Record<Editor, string> = { analysis: "参考结构分析", transcript: "参考音轨文字", viralFacts: "新商品真实资料", viralProductAnalysis: "商品分析", instructions: "改编要求", script: "视频脚本" };
const suggestionFields = {
    analysis: { key: "viralAnalysisSuggestion", stale: "viralAnalysisStale" },
    viralProductAnalysis: { key: "viralProductSuggestion", stale: "viralProductStale" },
    script: { key: "viralScriptSuggestion", stale: "viralScriptStale" },
} as const;
const suggestionInfo = (field: Editor) => (field === "analysis" || field === "viralProductAnalysis" || field === "script" ? suggestionFields[field] : undefined);
const states = { running: "处理中", completed: "已完成", interrupted: "查询暂停", failed: "失败" };

export default function ViralRecreateWorkspace() {
    const wb = useVideoWorkbench("viral-recreate"),
        { draft: d, busy } = wb;
    const config = useVideoCreationConfig(),
        { token } = theme.useToken(),
        { message, modal } = App.useApp(),
        copyText = useCopyText();
    const session = useUserStore((s) => s.token),
        admin = useUserStore((s) => s.user?.role === "admin");
    const modelCosts = useConfigStore((s) => s.publicSettings?.modelChannel.modelCosts);
    const openConfig = useConfigStore((s) => s.openConfigDialog),
        updateConfig = useConfigStore((s) => s.updateConfig),
        loadSettings = useConfigStore((s) => s.loadPublicSettings);
    const [uploading, setUploading] = useState(false),
        uploadLock = useRef(false),
        [errors, setErrors] = useState<Partial<Record<Role, string>>>({});
    const [assetRole, setAssetRole] = useState<Role | null>(null),
        [editor, setEditor] = useState<Editor | null>(null),
        [editingField, setEditingField] = useState<Editor>("analysis"),
        [suggestionView, setSuggestionView] = useState(false),
        [settingsOpen, setSettingsOpen] = useState(false),
        [serviceOpen, setServiceOpen] = useState(false);
    const [serviceStatus, setServiceStatus] = useState(""),
        [checking, setChecking] = useState(false),
        [refreshing, setRefreshing] = useState(false);
    const [tab, setTab] = useState("current"),
        [viewed, setViewed] = useState<VideoRecord | null>(null),
        [previewError, setPreviewError] = useState(false);
    const [price, setPrice] = useState<{ key: string; value: VideoPrice } | null>(null),
        [priceError, setPriceError] = useState(""),
        [quoting, setQuoting] = useState(false),
        quoteController = useRef<AbortController | null>(null);
    const referencePlayer = useRef<HTMLVideoElement | null>(null);
    const cfg = viralVideoConfig(d, config),
        settings = storeVideoSettings(cfg),
        profile = videoProfile(cfg, cfg.videoModel),
        mode = videoInputMode(cfg, cfg.videoModel);
    const wan = cfg.videoModel === REPLICATE_VIDEO_MODEL,
        cloud = isReplicateVideoModel(cfg.videoModel),
        referenceMode = mode === "reference",
        locked = busy || uploading;
    const labels = viralMaterialLabels(d),
        materials = viralVideoMaterials(d, cfg),
        frames = viralFrameMaterials(d),
        reference = viralReference(d);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask || r.workerJob));
    const active = wb.records.find((r) => r.id === d.activeRecord),
        blocked = viralVideoError(d, cfg) || (pending ? "已有任务可恢复，请先查询或确认原任务状态" : "");
    const textBlocked = config.channelMode === "remote" && !session ? "登录后使用平台文案模型" : !config.textModel || !useConfigStore.getState().isAiConfigReady(config, config.textModel) ? "请配置分析 / 文案模型" : "";
    const invalidMentions = materialMentionError(`${d.instructions}\n${d.script}`, labels);
    const priceKey = JSON.stringify([
        d.media.map((m) => [m.id, m.storageKey]),
        frames.map((f) => f.id),
        settings,
        d.viralFirstFrameId,
        d.viralLastFrameId,
        d.viralUseVideo,
        d.script,
        d.instructions,
        d.analysis,
        d.viralFacts,
        d.viralProductAnalysis,
        d.viralAnalysisStale,
        d.viralProductStale,
        config.channelMode,
        config.baseUrl,
        config.videoModels,
        config.models,
        modelCosts,
        session,
    ]);
    const quote = price?.key === priceKey ? price.value : null,
        result = viewed ? viewed.result : d.video;
    const original = viewed ? viralReference({ ...d, media: viewed.viralInput?.media || [] }) : reference;
    const muted = { color: token.colorTextSecondary },
        surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };
    useEffect(() => {
        if (wb.hydrated && !d.viralSettings) wb.patch({ viralSettings: normalizeStoreSettings(storeVideoSettings(config), config) });
    }, [wb.hydrated, d.viralSettings, config]);
    useEffect(() => {
        quoteController.current?.abort();
        setQuoting(false);
        setPriceError("");
        return () => quoteController.current?.abort();
    }, [priceKey]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);
    const changeSettings = (value: Partial<StoreVideoSettings>) => wb.edit({ viralSettings: normalizeStoreSettings({ ...settings, ...value }, config) }, "video");
    const edit = (field: Editor, value: string) =>
        wb.edit(
            {
                [field]: value,
                ...(field === "analysis"
                    ? { viralAnalysisStale: false }
                    : field === "viralProductAnalysis"
                      ? { viralProductStale: false }
                      : field === "script"
                        ? { viralScriptStale: false, viralScriptSuggestion: d.viralScriptSuggestion }
                        : field === "transcript"
                          ? { viralTranscriptSource: viralSource(d), viralAnalysisStale: true, viralAnalysisSuggestion: "" }
                          : {}),
            },
            field === "viralFacts" ? "materials" : field === "script" ? "video" : "script",
        );
    const prepareQuote = async () => {
        const controller = new AbortController();
        quoteController.current?.abort();
        quoteController.current = controller;
        setQuoting(true);
        setPriceError("");
        try {
            const value = await wb.quoteViralVideo(controller.signal);
            if (!controller.signal.aborted) setPrice({ key: priceKey, value });
        } catch (error) {
            if (!controller.signal.aborted) {
                setPrice(null);
                setPriceError(error instanceof Error ? error.message : "报价失败");
            }
        } finally {
            if (!controller.signal.aborted) setQuoting(false);
        }
    };
    const addFiles = async (files: File[], role: Role) => {
        if (locked || uploadLock.current) return false;
        uploadLock.current = true;
        setUploading(true);
        setErrors((e) => ({ ...e, [role]: "" }));
        try {
            const added = await wb.addFiles(files, role, role === "reference" ? "video/*" : "image/*");
            if (typeof added === "string") setErrors((e) => ({ ...e, [role]: added }));
            if (Array.isArray(added) && role === "first-frame") wb.edit({ viralFirstFrameId: added[0]?.id }, "video");
            return Array.isArray(added);
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!assetRole) return;
        try {
            if (assetRole === "reference" ? payload.kind !== "video" : payload.kind !== "image") throw new Error(assetRole === "reference" ? "请选择视频素材" : "请选择图片素材");
            const blob =
                payload.kind === "image"
                    ? await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob()
                    : payload.kind === "video"
                      ? await workbenchMediaBlob({ url: payload.url || "", storageKey: payload.storageKey || "", mimeType: "video/mp4", bytes: 0, kind: "video" })
                      : null;
            if (blob && (await addFiles([new File([blob], payload.title, { type: blob.type || (assetRole === "reference" ? "video/mp4" : "image/png") })], assetRole))) setAssetRole(null);
        } catch (error) {
            setErrors((e) => ({ ...e, [assetRole]: error instanceof Error ? error.message : "素材读取失败" }));
        }
    };
    const materialField = (role: Role, title: string, hint: string) => (
        <section className="space-y-2" data-material-role={role}>
            <div className="flex items-center justify-between gap-2">
                <strong className="font-medium">{title}</strong>
                <span className="text-xs" style={muted}>
                    {d.media.filter((m) => m.role === role).length} {role === "reference" ? "个" : "张"}
                </span>
            </div>
            <div className={role === "reference" ? "space-y-2" : "grid grid-cols-2 gap-2"}>
                {d.media
                    .filter((m) => m.role === role)
                    .map((m) => (
                        <div key={m.id} className="min-w-0 rounded-lg border p-2" style={{ borderColor: token.colorBorderSecondary }}>
                            {m.kind === "video" ? (
                                <video ref={referencePlayer} controls src={m.url} className="max-h-44 w-full rounded object-contain" />
                            ) : (
                                <button type="button" className="w-full" aria-label={`预览${m.name}`} onClick={() => modal.info({ title: m.name, width: 800, content: <img src={m.url} alt={m.name} className="max-h-[65vh] w-full object-contain" /> })}>
                                    <img src={m.url} alt={m.name} className="h-24 w-full object-contain" />
                                </button>
                            )}
                            <div className="flex items-center gap-1">
                                <span className="min-w-0 flex-1 truncate text-xs" title={m.name}>
                                    {labels.find((l) => l.id === m.id)?.label} · {m.name}
                                </span>
                                <Button type="text" size="small" aria-label={`移除${m.name}`} disabled={locked} icon={<X size={13} />} onClick={() => wb.removeMedia(m.id)} />
                            </div>
                            <div className="text-xs" style={muted}>
                                {formatBytes(m.bytes)}
                                {m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}秒` : ""}
                            </div>
                        </div>
                    ))}
            </div>
            <Upload.Dragger
                height={96}
                accept={role === "reference" ? "video/*" : "image/*"}
                multiple={role === "product" || role === "model"}
                showUploadList={false}
                disabled={locked}
                beforeUpload={(file, list) => {
                    if (file === list[0]) void addFiles(role === "reference" || role === "first-frame" ? [file] : list, role);
                    return Upload.LIST_IGNORE;
                }}
            >
                <div className="flex items-center justify-center gap-2">
                    {uploading ? <Spin size="small" /> : <Images size={18} />}点击或拖放上传{role === "reference" ? "视频" : "图片"}
                </div>
                <div className="mt-1 px-2 text-xs" style={muted}>
                    {hint}
                </div>
            </Upload.Dragger>
            <Button type="text" size="small" disabled={locked} onClick={() => setAssetRole(role)}>
                从我的素材选择
            </Button>
            {errors[role] && (
                <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                    {errors[role]}
                </div>
            )}
        </section>
    );
    const textAction = (stage: string, label: string, missing: boolean) => (
        <Button size="small" disabled={locked || Boolean(textBlocked) || missing} icon={<Sparkles size={13} />} onClick={() => void wb.run(stage)}>
            {label}
        </Button>
    );
    const openEditor = (field: Editor, showSuggestion = false) => {
        setEditingField(field);
        setSuggestionView(showSuggestion);
        if (window.matchMedia("(min-width: 1024px)").matches) setTab("editor");
        else setEditor(field);
    };
    const textPreview = (field: Editor, placeholder: string) => (
        <button type="button" aria-label={`查看 / 编辑全文：${editorNames[field]}`} className="block w-full rounded-lg border p-3 text-left" style={surface} onClick={() => openEditor(field)}>
            <span className="line-clamp-6 whitespace-pre-wrap break-words text-sm leading-6" style={d[field] ? undefined : muted}>
                {d[field] || placeholder}
            </span>
            <span className="mt-2 block text-xs" style={muted}>
                {Array.from(d[field] || "").length.toLocaleString()} 字 · 点击编辑全文
            </span>
        </button>
    );
    const heading = (field: Editor, action?: ReactNode) => (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <strong className="font-medium">{editorNames[field]}</strong>
            <Space size={4}>
                {action}
                <Button type="text" size="small" icon={<Expand size={13} />} onClick={() => openEditor(field)}>
                    查看 / 编辑全文
                </Button>
            </Space>
        </div>
    );
    const suggestionActions = (field: Editor) => {
        const info = suggestionInfo(field);
        if (!info || !d[info.key]) return null;
        return (
            <Space wrap>
                <Button
                    disabled={locked}
                    onClick={() => {
                        wb.edit({ [field]: d[info.key], [info.key]: "", [info.stale]: false }, "script");
                        setSuggestionView(false);
                    }}
                >
                    采用新{field === "script" ? "脚本" : "分析"}
                </Button>
                <Button
                    disabled={locked}
                    onClick={() => {
                        wb.patch({ [info.key]: "" });
                        setSuggestionView(false);
                    }}
                >
                    保留原稿
                </Button>
            </Space>
        );
    };
    const suggestion = (field: "analysis" | "viralProductAnalysis" | "script") => {
        const { key, stale } = suggestionFields[field];
        return (
            <>
                {d[stale] && d[field] && (
                    <div className="text-xs" style={{ color: token.colorWarning }}>
                        输入已变化，原稿已保留；请核对或更新
                    </div>
                )}
                {d[key] && (
                    <div className="mt-2 space-y-2">
                        <Button block onClick={() => openEditor(field, true)}>
                            查看新{field === "script" ? "脚本" : "分析"}建议
                        </Button>
                        {suggestionActions(field)}
                    </div>
                )}
            </>
        );
    };
    const editorBody = (field: Editor, fullscreen = false) => {
        const info = suggestionInfo(field),
            suggested = info ? d[info.key] : "",
            viewingSuggestion = suggestionView && Boolean(suggested),
            value = (viewingSuggestion ? suggested : d[field]) || "",
            inputStyle = { height: "100%", fontSize: 16, lineHeight: 1.8, padding: 16, resize: "none" as const },
            disabled = locked || (field === "transcript" && !reference);
        return (
            <div className="flex h-full min-h-0 flex-col gap-3" data-testid={fullscreen ? "viral-fullscreen-editor" : "viral-document-editor"}>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <Select
                        aria-label="选择编辑文案"
                        value={field}
                        className="w-48 max-w-full"
                        options={(Object.keys(editorNames) as Editor[]).map((key) => ({ value: key, label: editorNames[key] }))}
                        onChange={(next: Editor) => {
                            setEditingField(next);
                            setSuggestionView(false);
                            if (fullscreen) setEditor(next);
                        }}
                    />
                    <Space wrap>
                        <Button disabled={!value} onClick={() => copyText(value, "文案已复制")}>
                            复制全文
                        </Button>
                        {!fullscreen && (
                            <Button icon={<Expand size={14} />} onClick={() => setEditor(field)}>
                                全屏编辑
                            </Button>
                        )}
                    </Space>
                </div>
                {info && d[info.stale] && d[field] && <Alert type="warning" title="输入已变化，原稿已保留；请核对或更新" />}
                {suggested && (
                    <Tabs
                        className="shrink-0"
                        activeKey={viewingSuggestion ? "suggestion" : "draft"}
                        onChange={(key) => setSuggestionView(key === "suggestion")}
                        items={[
                            { key: "draft", label: "当前原稿" },
                            { key: "suggestion", label: "新建议（待采用）" },
                        ]}
                    />
                )}
                <div className="min-h-0 flex-1">
                    {!viewingSuggestion && (field === "script" || field === "instructions") ? (
                        <Mentions
                            aria-label={`编辑${editorNames[field]}`}
                            value={value}
                            disabled={disabled}
                            options={labels.map((l) => ({ value: l.label, label: `${l.label} · ${l.name}` }))}
                            onChange={(next) => edit(field, next)}
                            placeholder="输入文案；输入 @ 引用素材"
                            style={{ height: "100%" }}
                            styles={{ textarea: inputStyle }}
                        />
                    ) : (
                        <Input.TextArea
                            aria-label={`${viewingSuggestion ? "新建议" : "编辑"}${editorNames[field]}`}
                            value={value}
                            disabled={disabled}
                            readOnly={viewingSuggestion}
                            onChange={(e) => edit(field, e.target.value)}
                            placeholder="在这里查看或编辑完整文案"
                            style={inputStyle}
                        />
                    )}
                </div>
                {viewingSuggestion && <div className="shrink-0">{suggestionActions(field)}</div>}
                {!viewingSuggestion && (field === "script" || field === "instructions") && invalidMentions && (
                    <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                        {invalidMentions}
                    </div>
                )}
                <div className="flex shrink-0 flex-wrap justify-between gap-2 text-xs" style={muted}>
                    <span>{Array.from(value).length.toLocaleString()} 字</span>
                    <span>{wb.storageError ? "本地保存异常，请先复制文案备份" : viewingSuggestion ? "新建议尚未替换原稿，采用后可编辑" : "修改自动保存到本浏览器草稿"}</span>
                </div>
            </div>
        );
    };
    const refreshModels = async () => {
        quoteController.current?.abort();
        setPrice(null);
        setRefreshing(true);
        try {
            await loadSettings();
        } finally {
            setRefreshing(false);
        }
    };
    const checkService = async () => {
        setChecking(true);
        try {
            const caps = await getWorkerCapabilities(wb.worker);
            setServiceStatus(
                caps
                    .filter((c) => ["frames", "transcribe"].includes(c.name))
                    .map((c) => `${c.name === "frames" ? "抽样" : "转写"}：${c.available ? "可用" : c.reason || "不可用"}`)
                    .join("；"),
            );
        } catch (e) {
            setServiceStatus(e instanceof Error ? e.message : "连接失败");
        } finally {
            setChecking(false);
        }
    };
    const showRecord = async (r: VideoRecord) => {
        try {
            const media = await Promise.all((r.viralInput?.media || []).map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
            setViewed({ ...r, ...(r.viralInput ? { viralInput: { ...r.viralInput, media } } : {}), ...(r.result ? { result: await restoreWorkbenchFile(r.result) } : {}) });
            setTab("current");
        } catch (e) {
            message.error(e instanceof Error ? e.message : "作品读取失败");
        }
    };
    const restoreInput = (r: VideoRecord) => {
        if (!r.viralInput) return;
        modal.confirm({
            title: "恢复这次制作的输入",
            content: "将替换当前素材、分析与脚本；不会创建新收费任务。",
            okText: "恢复输入",
            cancelText: "取消",
            onOk: async () => {
                const { channelMode: _mode, baseUrl: _url, ...input } = r.viralInput!;
                const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) }))),
                    frames = await Promise.all(input.frames.map(restoreWorkbenchFile));
                wb.patch({ ...input, media, frames, viralOutputStale: true, viralAnalysisSuggestion: "", viralProductSuggestion: "", viralScriptSuggestion: "", viralRevision: (d.viralRevision || 0) + 1 });
                setViewed(null);
                setTab("current");
            },
        });
    };
    const spec = `${cloud ? "跟随首帧 / 平台默认" : inferVideoRatio(cfg.size)} · ${wan ? "约 " : ""}${cfg.videoSeconds}秒 · ${cfg.vquality}p`;
    const controls = (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Select
                    aria-label="视频模型"
                    className="min-w-0 flex-1"
                    disabled={locked}
                    value={cfg.videoModel}
                    virtual={false}
                    optionRender={(option) => <VideoModelOption config={config} model={String(option.value)} />}
                    onChange={(videoModel) => changeSettings({ videoModel })}
                    options={selectableModelsByCapability(config, "video").map((value) => ({ value, label: videoProfile(config, value).displayName }))}
                />
                <Button aria-label="刷新模型" disabled={locked} loading={refreshing} icon={<RefreshCw size={14} />} onClick={() => void refreshModels()} />
            </div>
            <Button block disabled={locked} onClick={() => setSettingsOpen(true)}>
                视频设置 · {spec}
            </Button>
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs" style={muted}>
                    {quote ? `预计 ${quote.credits.toLocaleString()} 算力点` : config.channelMode === "remote" || cloud ? "制作前确认本次费用" : "自定义渠道按账单计费"}
                </span>
                {session && (config.channelMode === "remote" || cloud) && (
                    <Button type="link" size="small" disabled={locked || Boolean(blocked)} loading={quoting} onClick={() => void prepareQuote()}>
                        查看本次费用
                    </Button>
                )}
            </div>
            {quote && (
                <div className="text-xs" style={muted}>
                    {publicServiceText(quote.calculation || "")}
                </div>
            )}
            {priceError && (
                <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                    {priceError}
                </div>
            )}
            {(config.channelMode === "remote" || cloud) && !session ? (
                <div className="flex items-center justify-between gap-2">
                    <span>登录后生成视频</span>
                    <UserStatusActions accountOnly />
                </div>
            ) : (
                <Button
                    type="primary"
                    size="large"
                    block
                    disabled={locked || Boolean(blocked)}
                    loading={busy}
                    icon={<Sparkles size={16} />}
                    onClick={() => {
                        setViewed(null);
                        setTab("current");
                        void wb.run("video");
                    }}
                >
                    生成视频
                </Button>
            )}
            {blocked && (
                <div className="text-xs" style={muted}>
                    {blocked}
                </div>
            )}
        </div>
    );
    if (!wb.hydrated)
        return (
            <div className="p-12 text-center">
                <Spin />
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
                    <h1 className="text-lg font-semibold">爆款复刻</h1>
                </div>
                <span className="hidden text-sm sm:block" style={muted}>
                    参考结构 → 新商品脚本 → 视频片段
                </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="viral-scroll">
                <div className="mx-auto grid min-h-full max-w-[1800px] gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[420px_minmax(0,1fr)]">
                    <section className="flex min-h-0 flex-col rounded-xl border" style={surface} aria-label="复刻素材与设置">
                        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 [&>*]:shrink-0" data-testid="viral-input-scroll">
                            {materialField("reference", "参考视频", "借鉴结构与表达；上传不会自动收费分析")}
                            <section className="space-y-2">
                                {heading("analysis", textAction("analyze", "分析参考视频", !reference))}
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-xs">抽样数量</span>
                                    <InputNumber aria-label="抽样数量" min={1} precision={0} disabled={locked} value={d.frameCount} onChange={(value) => wb.edit({ frameCount: value || 1 }, "materials")} />
                                    <Button size="small" disabled={locked || !reference} onClick={() => void wb.run("frames")}>
                                        抽取画面
                                    </Button>
                                </div>
                                {frames.length > 0 && (
                                    <div className="grid grid-cols-3 gap-2">
                                        {frames.map((f, i) => (
                                            <button
                                                key={f.id}
                                                type="button"
                                                aria-label={`预览抽样画面${i + 1}`}
                                                onClick={() => {
                                                    if (referencePlayer.current && Number.isFinite(d.viralFrameTimes?.[i])) referencePlayer.current.currentTime = d.viralFrameTimes![i];
                                                    modal.info({
                                                        title: `抽样画面${i + 1} · ${Number.isFinite(d.viralFrameTimes?.[i]) ? `${d.viralFrameTimes![i].toFixed(2)}秒` : "未返回采样时间"}`,
                                                        content: <img src={f.url} alt={f.name} className="w-full object-contain" />,
                                                    });
                                                }}
                                            >
                                                <img src={f.url} alt={f.name} className="h-20 w-full rounded object-contain" />
                                                <span className="text-xs">{Number.isFinite(d.viralFrameTimes?.[i]) ? `${d.viralFrameTimes![i].toFixed(2)}秒` : "时间未返回"}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {textPreview("analysis", "可手写开场、镜头顺序与结尾；抽样不代表镜头边界")}
                                {suggestion("analysis")}
                                <Collapse
                                    items={[
                                        {
                                            key: "transcript",
                                            label: "音轨文字（可选）",
                                            children: (
                                                <div className="space-y-2">
                                                    {heading(
                                                        "transcript",
                                                        <Button size="small" disabled={locked || !reference} onClick={() => void wb.run("transcribe")}>
                                                            转写参考音轨
                                                        </Button>,
                                                    )}
                                                    {textPreview("transcript", "服务不可用时可手动粘贴，或跳过")}
                                                    <p className="text-xs" style={muted}>
                                                        未提供文字时只分析画面，不推测声音或音乐节拍。
                                                    </p>
                                                </div>
                                            ),
                                        },
                                    ]}
                                />
                            </section>
                            {materialField("product", "新商品图片", referenceMode ? "按模型能力作为视频参考图" : "用于商品分析；商品进入画面需准备相应首帧")}
                            <section>
                                {heading("viralFacts")}
                                {textPreview("viralFacts", "名称、真实卖点与适用人群；不编造价格、优惠和功效")}
                            </section>
                            <section>
                                {heading("viralProductAnalysis", textAction("product-analyze", "分析新商品", !d.media.some((m) => m.role === "product")))}
                                {textPreview("viralProductAnalysis", "仅描述新商品，独立于参考视频结构")}
                                {suggestion("viralProductAnalysis")}
                            </section>
                            {materialField("model", "出镜人物（可选）", referenceMode ? "视频参考用途以当前能力为准，真实外观需要验收" : "分析辅助；要出镜需准备包含该人物的首帧")}
                            <section>
                                {heading("instructions")}
                                {textPreview("instructions", "保留哪些表达、改写哪些卖点；@引用素材")}
                            </section>
                            <section>
                                {heading("script", textAction("script", "AI 撰写脚本", !d.viralFacts?.trim() && !d.instructions.trim() && !d.analysis.trim() && !d.media.some((m) => m.role === "product")))}
                                {textPreview("script", `可直接手写；实际制作${cfg.videoSeconds}秒片段`)}
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <span className="text-xs" style={muted}>
                                        脚本与费用按 {cfg.videoSeconds} 秒规格
                                    </span>
                                    <Button size="small" disabled={!d.script} onClick={() => copyText(d.script, "脚本已复制")}>
                                        复制脚本
                                    </Button>
                                </div>
                                {suggestion("script")}
                                {invalidMentions && (
                                    <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                                        {invalidMentions}
                                    </div>
                                )}
                            </section>
                            {!referenceMode && (
                                <section className="space-y-2">
                                    <strong className="font-medium">生成首帧{profile.firstFrameRequired ? "（必填）" : "（可选）"}</strong>
                                    <Select
                                        aria-label="生成首帧"
                                        className="w-full"
                                        allowClear
                                        disabled={locked}
                                        value={d.viralFirstFrameId}
                                        placeholder="明确选择本次生成首帧"
                                        onChange={(value) => wb.edit({ viralFirstFrameId: value }, "video")}
                                        options={viralImageCandidates(d).map((m) => ({ value: m.id, label: `${labels.find((l) => l.id === m.id)?.label} · ${m.name}` }))}
                                    />
                                    {materialField("first-frame", "或上传生成首帧", "上传已包含目标商品或人物的画面")}
                                    {mode === "first_last" && !wan && (
                                        <Select
                                            aria-label="生成尾帧"
                                            className="w-full"
                                            allowClear
                                            disabled={locked}
                                            value={d.viralLastFrameId}
                                            placeholder="尾帧以当前模型能力为准"
                                            onChange={(value) => wb.edit({ viralLastFrameId: value }, "video")}
                                            options={viralImageCandidates(d).map((m) => ({ value: m.id, label: m.name }))}
                                        />
                                    )}
                                    <div className="text-xs" style={{ color: token.colorWarning }}>
                                        原视频抽样画面仍含原商品或人物，选择前请核对。系统不会自动合成新主体。
                                    </div>
                                </section>
                            )}
                            <section className="space-y-2">
                                <strong className="font-medium">本次视频模型输入</strong>
                                {materials.length ? (
                                    materials.map((m) => (
                                        <div key={m.id} className="flex items-center gap-2 text-xs">
                                            {m.kind === "image" && <img src={m.url} alt={m.name} className="h-10 w-12 object-contain" />}
                                            <span>
                                                {m.kind === "video" ? "视频" : "图片"} · {labels.find((l) => l.id === m.id)?.label} · {m.name}
                                            </span>
                                        </div>
                                    ))
                                ) : (
                                    <p className="text-xs" style={muted}>
                                        尚未选择视觉输入；文生模型可只用脚本。
                                    </p>
                                )}
                                {(profile.maxVideos > 0 || d.viralUseVideo) && (
                                    <label className="block text-xs">
                                        <Switch aria-label="直接视频参考" disabled={locked} checked={Boolean(d.viralUseVideo)} onChange={(value) => wb.edit({ viralUseVideo: value }, "video")} /> 直接传参考视频（仅能力已确认的通道）
                                    </label>
                                )}
                                <p className="text-xs" style={muted}>
                                    {d.viralUseVideo ? "按当前模型能力校验视频输入。" : "原视频只用于结构分析，不直接输入视频模型。"} 未发送的商品或人物图仅用于分析与脚本。
                                </p>
                            </section>
                            <Collapse
                                items={[
                                    {
                                        key: "advanced",
                                        label: "分析模型与处理服务",
                                        children: (
                                            <div className="space-y-3">
                                                <ModelPicker
                                                    config={config}
                                                    capability="text"
                                                    value={config.textModel}
                                                    fullWidth
                                                    onChange={(value) => {
                                                        if (!locked) updateConfig("textModel", value);
                                                    }}
                                                    onMissingConfig={() => openConfig(true)}
                                                />
                                                <Button disabled={locked} onClick={() => openConfig(true)}>
                                                    配置模型渠道
                                                </Button>
                                                <Button disabled={locked} onClick={() => setServiceOpen(true)}>
                                                    抽样 / 转写服务
                                                </Button>
                                                <p className="text-xs" style={muted}>
                                                    {textBlocked || (config.channelMode === "remote" ? "文案与视频分开报价确认；抽样/转写使用所配置服务。" : "文案费用按自定义渠道账单计费。")}
                                                </p>
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                        </div>
                        <div className="hidden shrink-0 border-t p-4 lg:block" style={{ borderColor: token.colorBorderSecondary }}>
                            {controls}
                        </div>
                    </section>
                    <aside className="flex min-h-0 flex-col rounded-xl border p-4" style={surface} aria-label="作品与说明">
                        {wb.storageError && <Alert className="mb-3" type="error" title="本地保存异常" description={wb.storageError} />}
                        {busy && (
                            <Alert
                                className="mb-3"
                                type="info"
                                title={`${active?.stage === "frames" ? "抽取参考画面" : stageLabels[active?.stage || ""] || "正在处理"}：${active?.step || "等待请求"}`}
                                description={
                                    <Space>
                                        <Button size="small" onClick={wb.stop}>
                                            停止等待
                                        </Button>
                                        {(active?.replicateTask || active?.workerJob) && (
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
                                className="mb-3"
                                type="info"
                                title="已有任务可恢复查询"
                                description={
                                    <Button
                                        size="small"
                                        disabled={uploading}
                                        onClick={() => {
                                            setViewed(null);
                                            void wb.resume(pending);
                                        }}
                                    >
                                        恢复原任务
                                    </Button>
                                }
                            />
                        )}
                        {!busy && active?.error && <Alert className="mb-3" type="warning" title="上次处理未完成" description={publicServiceText(active.error)} />}
                        <Tabs
                            activeKey={tab}
                            onChange={setTab}
                            items={[
                                { key: "current", label: "当前作品" },
                                { key: "editor", label: "文案编辑" },
                                { key: "history", label: "本浏览器作品" },
                                { key: "guide", label: "使用说明" },
                            ]}
                        />
                        <div className={`min-h-0 flex-1 ${tab === "editor" ? "h-[65vh] min-h-96 lg:h-auto lg:min-h-0" : "overflow-y-auto"}`}>
                            {tab === "editor" && editorBody(editingField)}
                            {tab === "current" && (
                                <div className="space-y-3">
                                    {viewed && (
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-sm">
                                                查看历史 · {stageLabels[viewed.stage]} · {new Date(viewed.createdAt).toLocaleString()}
                                            </span>
                                            <Button size="small" onClick={() => setViewed(null)}>
                                                返回当前制作
                                            </Button>
                                        </div>
                                    )}
                                    {!viewed && d.viralOutputStale && d.video && <Alert type="warning" title="输入已变化，以下为上一次制作结果" />}
                                    <div className="grid gap-3 xl:grid-cols-2">
                                        <section className="min-w-0 space-y-2">
                                            <h2 className="text-sm font-medium">参考视频</h2>
                                            {original ? (
                                                <video controls src={original.url} className="max-h-[55vh] w-full rounded object-contain" />
                                            ) : (
                                                <div className="flex min-h-52 items-center justify-center">
                                                    <Empty description="上传后预览原视频" />
                                                </div>
                                            )}
                                        </section>
                                        <section className="min-w-0 space-y-2">
                                            <h2 className="text-sm font-medium">改编作品</h2>
                                            {result ? (
                                                <video controls src={result.url} className="max-h-[55vh] w-full rounded object-contain" onError={() => setPreviewError(true)} />
                                            ) : viewed?.text ? (
                                                <Input.TextArea aria-label="历史文案" rows={12} value={viewed.text} readOnly />
                                            ) : (
                                                <div className="flex min-h-52 items-center justify-center">
                                                    <Empty description="生成后在这里对照预览" />
                                                </div>
                                            )}
                                        </section>
                                    </div>
                                    {previewError && <Alert type="warning" title="当前浏览器无法播放此编码，仍可下载原文件" />}
                                    {result && (
                                        <Space wrap>
                                            <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                                下载视频
                                            </Button>
                                            {!viewed && (
                                                <>
                                                    <Button icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset()}>
                                                        保存素材
                                                    </Button>
                                                    <Button icon={<Grid2X2 size={15} />} onClick={() => void wb.toCanvas()}>
                                                        加入画布
                                                    </Button>
                                                </>
                                            )}
                                        </Space>
                                    )}
                                    <p className="text-xs" style={muted}>
                                        当前输出单条短片。口播、字幕、配乐和多镜头剪辑不会自动完成；人物、商品与动作一致性需真实成片验收。
                                    </p>
                                </div>
                            )}
                            {tab === "history" && (
                                <div className="space-y-3">
                                    {!wb.records.length && <Empty description="暂无本浏览器制作记录" />}
                                    {wb.records.map((r) => (
                                        <div key={r.id} className="space-y-2 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }}>
                                            <div className="flex justify-between gap-2">
                                                <strong className="font-medium">
                                                    {r.stage === "frames" ? "抽取参考画面" : stageLabels[r.stage]} · {states[r.status]}
                                                </strong>
                                                <span className="text-xs" style={muted}>
                                                    {new Date(r.createdAt).toLocaleString()}
                                                </span>
                                            </div>
                                            {r.viralInput?.viralSettings && (
                                                <p className="text-xs" style={muted}>
                                                    {r.viralInput.viralSettings.videoModel} · {r.viralInput.viralSettings.videoSeconds}秒 · {r.viralInput.viralSettings.vquality}p
                                                </p>
                                            )}
                                            {r.error && (
                                                <p className="text-xs" style={{ color: token.colorError }}>
                                                    {r.error}
                                                </p>
                                            )}
                                            <Space wrap>
                                                <Button size="small" disabled={locked || (!r.result && !r.text)} onClick={() => void showRecord(r)}>
                                                    查看结果
                                                </Button>
                                                {r.viralInput && (
                                                    <Button size="small" disabled={locked} onClick={() => restoreInput(r)}>
                                                        恢复输入
                                                    </Button>
                                                )}
                                                {["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask) && (
                                                    <Button
                                                        size="small"
                                                        disabled={locked}
                                                        onClick={() => {
                                                            setViewed(null);
                                                            void wb.resume(r);
                                                        }}
                                                    >
                                                        恢复查询
                                                    </Button>
                                                )}
                                                {admin && r.replicateTask && (
                                                    <Button
                                                        size="small"
                                                        disabled={locked}
                                                        onClick={() =>
                                                            void reconcileReplicateTask(r.replicateTask!.id)
                                                                .then(() => message.success("已核对原任务"))
                                                                .catch((e) => message.error(e.message))
                                                        }
                                                    >
                                                        核对平台任务
                                                    </Button>
                                                )}
                                            </Space>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {tab === "guide" && (
                                <div className="space-y-4 text-sm">
                                    <p>参考视频用于拆解开场与表达结构；均匀抽样不是镜头检测，未转写时仅依据画面分析。</p>
                                    <p>新商品资料与人物外观单独提供。平台视频服务只接收你选定的一张首帧；若希望换成新商品/人物，请上传包含目标主体的画面。多图和视频参考按后台确认的能力发送。</p>
                                    <p>AI新分析、新脚本先提供建议，有原稿时明确采用再替换。手写脚本和合规首帧可直接生成，不依赖抽样或Whisper服务。</p>
                                    <p>视频与文案分别确认真实费用；停止等待不等于取消平台任务。恢复查询只查原任务，不再次提交收费任务。</p>
                                    <p>
                                        素材、草稿与作品保存在本浏览器。精准替换原视频主体可使用<Link to="/video/content-replace">内容替换</Link>；多片段剪辑、独立字幕与配音需后续处理。
                                    </p>
                                </div>
                            )}
                        </div>
                    </aside>
                </div>
            </div>
            <footer className="shrink-0 border-t px-4 py-3 lg:hidden" style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}>
                {controls}
            </footer>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
            <Modal
                title="文案全屏编辑"
                width="100%"
                className="!m-0 !max-w-none !pb-0"
                style={{ top: 0 }}
                styles={{ container: { height: "100dvh", display: "flex", flexDirection: "column", borderRadius: 0 }, body: { flex: 1, minHeight: 0 }, header: { flexShrink: 0 }, footer: { flexShrink: 0 } }}
                open={Boolean(editor)}
                onCancel={() => setEditor(null)}
                footer={<Button onClick={() => setEditor(null)}>完成编辑</Button>}
            >
                {editor && editorBody(editor, true)}
            </Modal>
            <Modal
                title="视频设置"
                open={settingsOpen}
                onCancel={() => setSettingsOpen(false)}
                footer={
                    <Button type="primary" onClick={() => setSettingsOpen(false)}>
                        完成
                    </Button>
                }
            >
                <div className="space-y-4">
                    <p style={muted}>{profile.displayName} · 按当前渠道能力展示</p>
                    {!cloud && (
                        <label className="block">
                            画面比例
                            <Select
                                aria-label="视频比例"
                                className="mt-2 w-full"
                                disabled={locked}
                                value={inferVideoRatio(cfg.size) === "auto" ? "16:9" : inferVideoRatio(cfg.size)}
                                onChange={(value) => changeSettings({ size: computeVideoSize(cfg.vquality, value) })}
                                options={["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map((value) => ({ value, label: value }))}
                            />
                        </label>
                    )}
                    <label className="block">
                        分辨率
                        <Select aria-label="视频分辨率" className="mt-2 w-full" disabled={locked} value={cfg.vquality} onChange={(vquality) => changeSettings({ vquality })} options={profile.resolutions.map((value) => ({ value, label: `${value}p` }))} />
                    </label>
                    <label className="block">
                        视频时长
                        {profile.seconds.length ? (
                            <Select
                                aria-label="视频时长"
                                className="mt-2 w-full"
                                disabled={locked}
                                value={cfg.videoSeconds}
                                onChange={(videoSeconds) => changeSettings({ videoSeconds })}
                                options={profile.seconds.map((value) => ({ value, label: `${wan ? "约 " : ""}${value}秒` }))}
                            />
                        ) : (
                            <Input aria-label="视频时长" value={cfg.videoSeconds} disabled={locked} onChange={(e) => changeSettings({ videoSeconds: e.target.value })} />
                        )}
                    </label>
                    {!cloud && supportedVideoInputModes(profile).length > 1 && (
                        <Select
                            aria-label="视频输入方式"
                            className="w-full"
                            disabled={locked}
                            value={mode}
                            onChange={(videoInputMode) => changeSettings({ videoInputMode })}
                            options={supportedVideoInputModes(profile).map((value) => ({ value, label: value === "reference" ? "多图参考" : value === "first_last" ? "首尾帧" : "单首帧 / 文生" }))}
                        />
                    )}
                    {wan && (
                        <label className="block">
                            <Switch aria-label="视频插帧" disabled={locked} checked={cfg.videoInterpolate === "true"} onChange={(value) => changeSettings({ videoInterpolate: String(value) })} /> 插帧（对应费用档）
                        </label>
                    )}
                    {profile.generateAudio && (
                        <label className="block">
                            <Switch aria-label="生成声音" disabled={locked} checked={cfg.videoGenerateAudio === "true"} onChange={(value) => changeSettings({ videoGenerateAudio: String(value) })} /> 生成声音
                        </label>
                    )}
                    {profile.interface === "ark" && (
                        <label className="block">
                            <Switch aria-label="平台水印" disabled={locked} checked={cfg.videoWatermark === "true"} onChange={(value) => changeSettings({ videoWatermark: String(value) })} /> 平台水印
                        </label>
                    )}
                    <p className="text-xs" style={muted}>
                        脚本、报价与正式请求共用规格。平台视频服务只使用显式首帧，比例跟随该图。
                    </p>
                </div>
            </Modal>
            <Modal title="抽样 / 转写服务" open={serviceOpen} onCancel={() => setServiceOpen(false)} footer={<Button onClick={() => setServiceOpen(false)}>完成</Button>}>
                <div className="space-y-3">
                    <Input aria-label="处理服务地址" value={wb.worker.url} disabled={locked} onChange={(e) => useVideoWorkbenchStore.getState().setWorker({ url: e.target.value })} placeholder="增强处理服务地址" />
                    <Input.Password aria-label="处理服务令牌" value={wb.worker.token} disabled={locked} onChange={(e) => useVideoWorkbenchStore.getState().setWorker({ token: e.target.value })} placeholder="自定义服务令牌" />
                    <Button loading={checking} disabled={locked} onClick={() => void checkService()}>
                        检查抽样 / 转写能力
                    </Button>
                    <p className="text-sm" style={muted}>
                        {serviceStatus || "抽样需要FFmpeg，转写需要Whisper；仅使用这些步骤时检查。无服务可手写结构与脚本。"}
                    </p>
                </div>
            </Modal>
        </main>
    );
}
