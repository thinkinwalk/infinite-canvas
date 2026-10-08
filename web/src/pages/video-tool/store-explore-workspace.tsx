import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCopyText } from "@/hooks/use-copy-text";
import { Link } from "react-router-dom";
import { Alert, App, Button, Collapse, Empty, Input, Mentions, Modal, Select, Space, Spin, Switch, Tabs, Tag, Upload, theme } from "antd";
import { ArrowLeft, Download, Expand, FolderPlus, Grid2X2, Images, RefreshCw, Sparkles, X } from "lucide-react";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { ModelPicker } from "@/components/model-picker";
import { videoSizeLabel } from "@/components/video-settings-panel";
import { computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { formatBytes } from "@/lib/image-utils";
import { materialMentionError, supportedVideoInputModes, videoInputMode, videoProfile } from "@/lib/video-capabilities";
import { VideoModelOption } from "@/components/video-model-option";
import { HAILUO_VIDEO_MODEL, publicServiceText, REPLICATE_VIDEO_MODEL, isReplicateVideoModel, reconcileReplicateTask } from "@/services/api/replicate";
import { type VideoPrice } from "@/services/api/video";
import { imageToDataUrl } from "@/services/image-storage";
import { useConfigStore, selectableModelsByCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { StoreVideoSettings, VideoDraft, VideoRecord } from "@/types/video-workbench";
import { useVideoCreationConfig } from "../video/use-video-creation-config";
import { normalizeStoreSettings, storeMaterialLabels, storeVideoConfig, storeVideoError, storeVideoMaterials, storeVideoSettings } from "./store-explore-request";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";

const states = { running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待暂停" };
type Editor = "storeFacts" | "analysis" | "instructions" | "script";
const names: Record<Editor, string> = { storeFacts: "门店真实资料", analysis: "视觉分析", instructions: "创作要求", script: "视频脚本" };

export default function StoreExploreWorkspace() {
    const wb = useVideoWorkbench("store-explore"),
        { draft: d, busy } = wb;
    const config = useVideoCreationConfig();
    const copyText = useCopyText();
    const modelCosts = useConfigStore((s) => s.publicSettings?.modelChannel.modelCosts);
    const { token } = theme.useToken(),
        { message, modal } = App.useApp();
    const session = useUserStore((s) => s.token),
        admin = useUserStore((s) => s.user?.role === "admin");
    const openConfig = useConfigStore((s) => s.openConfigDialog),
        updateConfig = useConfigStore((s) => s.updateConfig),
        loadSettings = useConfigStore((s) => s.loadPublicSettings);
    const [uploading, setUploading] = useState(false),
        uploadLock = useRef(false);
    const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
    const [assetRole, setAssetRole] = useState<"reference" | "model" | "first-frame" | null>(null);
    const [tab, setTab] = useState("current"),
        [editor, setEditor] = useState<Editor | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false),
        [refreshing, setRefreshing] = useState(false);
    const [price, setPrice] = useState<{ key: string; value: VideoPrice } | null>(null),
        [priceError, setPriceError] = useState("");
    const [quoting, setQuoting] = useState(false),
        quoteController = useRef<AbortController | null>(null);
    const [viewed, setViewed] = useState<VideoRecord | null>(null),
        [previewError, setPreviewError] = useState(false);
    const cfg = storeVideoConfig(d, config),
        settings = storeVideoSettings(cfg),
        model = cfg.videoModel;
    const profile = videoProfile(cfg, model),
        mode = videoInputMode(cfg, model),
        referenceMode = mode === "reference";
    const wan = model === REPLICATE_VIDEO_MODEL,
        hailuo = model === HAILUO_VIDEO_MODEL,
        cloud = isReplicateVideoModel(model);
    const labels = storeMaterialLabels(d),
        materials = storeVideoMaterials(d, cfg);
    const locked = busy || uploading;
    const pending = wb.records.find((r) => r.stage === "video" && ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask));
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const blocked = storeVideoError(d, cfg) || (pending ? "已有任务可恢复查询，完成前请勿重复制作" : "");
    const textBlocked = config.channelMode === "remote" && !session ? "登录后使用平台文案模型" : !config.textModel || !useConfigStore.getState().isAiConfigReady(config, config.textModel) ? "请配置分析 / 文案模型" : "";
    const invalidMentions = materialMentionError(`${d.instructions}\n${d.script}`, labels);
    const priceKey = JSON.stringify([
        d.media.map((m) => [m.id, m.storageKey]),
        settings,
        d.storeFirstFrameId,
        d.storeLastFrameId,
        d.script,
        d.instructions,
        d.analysis,
        d.storeFacts,
        config.channelMode,
        config.videoModels,
        config.models,
        modelCosts,
        session,
    ]);
    const quote = price?.key === priceKey ? price.value : null;
    const result = viewed ? viewed.result : d.video;
    const muted = { color: token.colorTextSecondary },
        surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };

    useEffect(() => {
        if (wb.hydrated && !d.storeSettings) wb.patch({ storeSettings: normalizeStoreSettings(storeVideoSettings(config), config) });
    }, [wb.hydrated, d.storeSettings, config]);
    useEffect(() => {
        quoteController.current?.abort();
        setQuoting(false);
        setPriceError("");
        return () => quoteController.current?.abort();
    }, [priceKey]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);

    const changeSettings = (value: Partial<StoreVideoSettings>) => {
        wb.edit({ storeSettings: normalizeStoreSettings({ ...settings, ...value }, config) }, "video");
    };
    const edit = (field: Editor, value: string) =>
        wb.edit({ [field]: value, ...(field === "analysis" ? { storeAnalysisStale: false } : field === "script" ? { storeScriptStale: false } : {}) }, field === "storeFacts" ? "materials" : field === "script" ? "video" : "script");
    const prepareQuote = async () => {
        const controller = new AbortController();
        quoteController.current?.abort();
        quoteController.current = controller;
        setQuoting(true);
        setPriceError("");
        try {
            const value = await wb.quoteStoreVideo(controller.signal);
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
    const addFiles = async (files: File[], role: "reference" | "model" | "first-frame") => {
        if (locked || uploadLock.current) return false;
        uploadLock.current = true;
        setUploading(true);
        setErrors((e) => ({ ...e, [role]: "" }));
        try {
            const added = await wb.addFiles(files, role, "image/*");
            if (typeof added === "string") setErrors((e) => ({ ...e, [role]: added }));
            if (Array.isArray(added) && role === "first-frame") wb.edit({ storeFirstFrameId: added[0]?.id }, "video");
            return Array.isArray(added);
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!assetRole) return;
        try {
            if (payload.kind !== "image") throw new Error("请选择图片素材");
            const blob = await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob();
            if (await addFiles([new File([blob], payload.title, { type: blob.type })], assetRole)) setAssetRole(null);
        } catch (error) {
            setErrors((e) => ({ ...e, [assetRole]: error instanceof Error ? error.message : "素材读取失败" }));
        }
    };
    const materialField = (role: "reference" | "model" | "first-frame", title: string, hint: string) => {
        const files = d.media.filter((m) => m.role === role);
        return (
            <section data-material-role={role} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <strong className="font-medium">{title}</strong>
                    <span className="text-xs" style={muted}>
                        {files.length} 张
                    </span>
                </div>
                {files.length > 0 && (
                    <div className="grid grid-cols-2 gap-2">
                        {files.map((m) => (
                            <div key={m.id} className="min-w-0 rounded-lg border p-2" style={{ borderColor: token.colorBorderSecondary }}>
                                <button
                                    type="button"
                                    className="block w-full cursor-pointer"
                                    aria-label={`预览${m.name}`}
                                    onClick={() => modal.info({ title: m.name, width: 800, content: <img src={m.url} alt={m.name} className="max-h-[65vh] w-full object-contain" /> })}
                                >
                                    <img src={m.url} alt={m.name} className="h-24 w-full rounded object-contain" />
                                </button>
                                <div className="mt-1 flex min-w-0 items-center gap-1">
                                    <span className="min-w-0 flex-1 truncate text-xs" title={m.name}>
                                        {labels.find((l) => l.id === m.id)?.label || "首帧"} · {m.name}
                                    </span>
                                    <Button type="text" size="small" aria-label={`移除${m.name}`} disabled={locked} icon={<X size={13} />} onClick={() => wb.removeMedia(m.id)} />
                                </div>
                                <div className="text-xs" style={muted}>
                                    {formatBytes(m.bytes)}
                                    {m.width && m.height ? ` · ${m.width}×${m.height}` : ""}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                <Upload.Dragger
                    height={96}
                    accept="image/*"
                    multiple={role !== "first-frame"}
                    showUploadList={false}
                    disabled={locked}
                    beforeUpload={(file, list) => {
                        if (file === list[0]) void addFiles(role === "first-frame" ? [file] : list, role);
                        return Upload.LIST_IGNORE;
                    }}
                    style={{ background: token.colorFillQuaternary }}
                >
                    <div className="flex items-center justify-center gap-2 text-sm">
                        {uploading ? <Spin size="small" /> : <Images size={18} />}
                        <span>点击或拖拽上传图片</span>
                    </div>
                    <div className="mt-1 px-2 text-xs" style={muted}>
                        {hint}
                    </div>
                </Upload.Dragger>
                <Button size="small" type="text" disabled={locked} onClick={() => setAssetRole(role)}>
                    从我的素材选择
                </Button>
                {errors[role] && (
                    <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                        {errors[role]}
                    </div>
                )}
            </section>
        );
    };
    const editorHeading = (field: Editor, extra?: ReactNode) => (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <strong className="font-medium">{names[field]}</strong>
            <Space size={4}>
                {extra}
                <Button type="text" size="small" icon={<Expand size={13} />} onClick={() => setEditor(field)}>
                    放大
                </Button>
            </Space>
        </div>
    );
    const textAction = (stage: "analyze" | "script", label: string) => (
        <Button
            size="small"
            disabled={locked || Boolean(textBlocked) || (stage === "analyze" && !labels.length) || (stage === "script" && !labels.length && !d.storeFacts?.trim() && !d.instructions.trim())}
            icon={<Sparkles size={13} />}
            onClick={() => void wb.run(stage)}
        >
            {label}
        </Button>
    );
    const showRecord = async (record: VideoRecord) => {
        try {
            setViewed({ ...record, ...(record.result ? { result: await restoreWorkbenchFile(record.result) } : {}) });
            setTab("current");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "作品读取失败");
        }
    };
    const restoreInput = (record: VideoRecord) => {
        if (!record.storeExploreInput) return;
        modal.confirm({
            title: "恢复这次制作的输入",
            content: "将替换当前素材、资料与脚本；不会创建新收费任务。",
            okText: "恢复输入",
            cancelText: "取消",
            onOk: async () => {
                const { channelMode: _mode, baseUrl: _url, ...input } = record.storeExploreInput!;
                const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                wb.patch({ ...input, media, storeOutputStale: true, storeScriptStale: false, storeAnalysisStale: false, storeAnalysisSuggestion: "", storeScriptSuggestion: "" });
                setViewed(null);
                setTab("current");
            },
        });
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
    const spec = `${cloud ? (materials.length ? "跟随首帧" : "平台默认比例") : videoSizeLabel(cfg.size)} · ${wan ? "约 " : ""}${cfg.videoSeconds}秒 · ${cfg.vquality}p${wan && cfg.videoInterpolate === "true" ? " · 插帧" : ""}`;
    const controls = (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs" style={muted}>
                    {quote ? `预计 ${quote.credits.toLocaleString()} 算力点` : config.channelMode === "remote" || cloud ? "制作前确认本次算力点" : "自定义渠道费用以服务账单为准"}
                </span>
                {(config.channelMode === "remote" || cloud) && session && (
                    <Button size="small" type="link" disabled={locked || Boolean(blocked)} loading={quoting} onClick={() => void prepareQuote()}>
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
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">登录后生成视频</span>
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
            <div className="text-xs" style={muted}>
                {uploading ? "正在保存素材" : busy ? "正在处理，请稍候" : blocked || "已具备制作条件；文案与视频分别计费"}
            </div>
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
                    <h1 className="text-lg font-semibold">探店视频</h1>
                </div>
                <span className="hidden text-sm sm:block" style={muted}>
                    真实门店素材 → 可编辑脚本 → 视频片段
                </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="store-scroll">
                <div className="mx-auto grid min-h-full max-w-[1800px] gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[420px_minmax(0,1fr)]">
                    <section className="flex min-h-0 flex-col rounded-xl border" style={surface} aria-label="探店素材与设置">
                        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4" data-testid="store-input-scroll">
                            {materialField("reference", "探店素材", "门头、环境、商品与服务过程")}
                            <section>
                                {editorHeading("storeFacts")}
                                <Input.TextArea aria-label="门店真实资料" rows={3} disabled={locked} value={d.storeFacts || ""} onChange={(e) => edit("storeFacts", e.target.value)} placeholder="填写真实店名、地址、商品、价格和活动；未知信息留空" />
                            </section>
                            <section>
                                {editorHeading("analysis", textAction("analyze", "AI 分析"))}
                                <Input.TextArea aria-label="视觉分析" rows={3} disabled={locked} value={d.analysis} onChange={(e) => edit("analysis", e.target.value)} placeholder="分析环境、商品和可用镜头；不会从图片推测价格或地址" />
                                {d.storeAnalysisStale && d.analysis && (
                                    <div className="mt-1 text-xs" style={{ color: token.colorWarning }}>
                                        素材或资料已变化，请核对分析
                                    </div>
                                )}
                                {d.storeAnalysisSuggestion && (
                                    <div className="mt-2 space-y-2">
                                        <Input.TextArea aria-label="新分析预览" rows={4} value={d.storeAnalysisSuggestion} readOnly />
                                        <Space>
                                            <Button size="small" disabled={locked} onClick={() => wb.edit({ analysis: d.storeAnalysisSuggestion!, storeAnalysisSuggestion: "", storeAnalysisStale: false }, "script")}>
                                                采用新分析
                                            </Button>
                                            <Button size="small" disabled={locked} onClick={() => wb.patch({ storeAnalysisSuggestion: "" })}>
                                                保留原分析
                                            </Button>
                                        </Space>
                                    </div>
                                )}
                            </section>
                            {materialField("model", "出镜人物（可选）", referenceMode ? "用于人物外观参考，以当前模型能力为准" : "仅用于分析；人物进入画面需准备对应首帧")}
                            <section>
                                {editorHeading("instructions")}
                                <Mentions
                                    aria-label="创作要求"
                                    rows={3}
                                    disabled={locked}
                                    value={d.instructions}
                                    onChange={(value) => edit("instructions", value)}
                                    options={labels.map((l) => ({ value: l.label, label: `${l.label} · ${l.name}` }))}
                                    placeholder="风格、动作、受众等；输入 @ 引用素材"
                                />
                                <div className="mt-1 text-xs" style={muted}>
                                    {labels.length} 个可引用素材
                                </div>
                            </section>
                            <section>
                                {editorHeading("script", textAction("script", "AI 撰写脚本"))}
                                <Mentions
                                    aria-label="视频脚本"
                                    rows={6}
                                    disabled={locked}
                                    value={d.script}
                                    onChange={(value) => edit("script", value)}
                                    options={labels.map((l) => ({ value: l.label, label: `${l.label} · ${l.name}` }))}
                                    placeholder={`可直接手写脚本；当前制作${cfg.videoSeconds}秒片段`}
                                />
                                <div className="mt-2 flex items-center justify-between gap-2">
                                    <span className="text-xs" style={muted}>
                                        按当前 {cfg.videoSeconds} 秒规格编写
                                    </span>
                                    <Button size="small" disabled={!d.script} onClick={() => copyText(d.script, "脚本已复制")}>
                                        复制脚本
                                    </Button>
                                </div>
                                {d.storeScriptStale && d.script && (
                                    <div className="mt-1 text-xs" style={{ color: token.colorWarning }}>
                                        输入或规格已变化，原稿已保留；请核对或更新
                                    </div>
                                )}
                                {d.storeScriptSuggestion && (
                                    <div className="mt-2 space-y-2">
                                        <Input.TextArea aria-label="新脚本预览" rows={6} value={d.storeScriptSuggestion} readOnly />
                                        <Space>
                                            <Button size="small" disabled={locked} onClick={() => wb.edit({ script: d.storeScriptSuggestion!, storeScriptSuggestion: "", storeScriptStale: false }, "video")}>
                                                采用新脚本
                                            </Button>
                                            <Button size="small" disabled={locked} onClick={() => wb.patch({ storeScriptSuggestion: "" })}>
                                                保留原稿
                                            </Button>
                                        </Space>
                                    </div>
                                )}
                                {invalidMentions && (
                                    <div role="alert" className="mt-1 text-xs" style={{ color: token.colorError }}>
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
                                        disabled={locked}
                                        allowClear
                                        value={d.storeFirstFrameId}
                                        placeholder={profile.firstFrameRequired ? "明确选择本次生成首帧" : "不选图片时纯文字生成"}
                                        onChange={(value) => wb.edit({ storeFirstFrameId: value, media: value ? d.media : d.media.filter((m) => m.role !== "first-frame") }, "video")}
                                        options={d.media.filter((m) => m.kind === "image").map((m) => ({ value: m.id, label: `${labels.find((l) => l.id === m.id)?.label || "首帧"} · ${m.name}` }))}
                                    />
                                    {materialField("first-frame", "或上传生成首帧", "上传合成后的门店与人物图片，可控制起始画面")}
                                    {mode === "first_last" && !wan && (
                                        <Select
                                            aria-label="生成尾帧"
                                            className="w-full"
                                            allowClear
                                            disabled={locked}
                                            value={d.storeLastFrameId}
                                            placeholder={profile.lastFrameOptional ? "尾帧可选" : "当前模型要求尾帧"}
                                            onChange={(value) => wb.edit({ storeLastFrameId: value }, "video")}
                                            options={d.media.filter((m) => m.kind === "image").map((m) => ({ value: m.id, label: m.name }))}
                                        />
                                    )}
                                    <p className="text-xs" style={muted}>
                                        只有选定的首帧{mode === "first_last" && !wan ? " / 尾帧" : ""}传给视频模型，其他图用于分析与脚本。
                                    </p>
                                </section>
                            )}
                            <div className="text-xs" style={muted}>
                                文案模型与视频分别计费。{textBlocked || "可跳过 AI 分析，直接填写资料和脚本。"}
                            </div>
                            <Collapse
                                items={[
                                    {
                                        key: "advanced",
                                        label: "高级设置 · 文案与渠道",
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
                                                <p className="text-xs" style={muted}>
                                                    草稿、素材与作品保存在本浏览器。选择自定义渠道后，费用以该渠道账单为准。
                                                </p>
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                        </div>
                        <div className="hidden shrink-0 space-y-2 border-t p-4 lg:block" style={{ borderColor: token.colorBorderSecondary }}>
                            <div className="flex items-center gap-2">
                                <Select
                                    aria-label="视频模型"
                                    className="min-w-0 flex-1"
                                    disabled={locked}
                                    value={model}
                                    virtual={false}
                                    optionRender={(option) => <VideoModelOption config={config} model={String(option.value)} />}
                                    onChange={(videoModel) => changeSettings({ videoModel })}
                                    options={selectableModelsByCapability(config, "video").map((value) => ({ value, label: videoProfile(config, value).displayName }))}
                                />
                                <Button aria-label="刷新模型" icon={<RefreshCw size={14} />} loading={refreshing} disabled={locked} onClick={() => void refreshModels()} />
                            </div>
                            <Button block disabled={locked} onClick={() => setSettingsOpen(true)}>
                                视频设置 · {spec}
                            </Button>
                            <p className="text-xs" style={muted}>
                                {referenceMode ? `${materials.length}张视频参考图` : materials.length ? `选定${materials.length}张首帧${materials.length > 1 ? " / 尾帧" : ""}` : "当前无首帧"}
                            </p>
                            {controls}
                        </div>
                    </section>
                    <aside className="flex min-h-0 flex-col rounded-xl border p-4" style={surface} aria-label="作品与说明">
                        {wb.storageError && <Alert type="error" showIcon title="本地保存异常" description={wb.storageError} className="mb-3" />}
                        {busy && (
                            <Alert
                                type="info"
                                showIcon
                                title={`${stageLabels[active?.stage || ""] || "正在处理"}：${active?.step || "等待请求"}`}
                                description={
                                    <Space>
                                        <Button size="small" onClick={wb.stop}>
                                            停止等待
                                        </Button>
                                        {active?.replicateTask && (
                                            <Button size="small" danger onClick={() => void wb.cancel()}>
                                                取消处理任务
                                            </Button>
                                        )}
                                    </Space>
                                }
                                className="mb-3"
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
                                            setViewed(null);
                                            void wb.resume(pending);
                                        }}
                                    >
                                        恢复任务结果
                                    </Button>
                                }
                                className="mb-3"
                            />
                        )}
                        {!busy && active?.error && <Alert type={active.status === "interrupted" ? "warning" : "error"} title={publicServiceText(active.error)} className="mb-3" />}
                        <Tabs
                            activeKey={tab}
                            onChange={setTab}
                            items={[
                                { key: "current", label: "当前作品" },
                                { key: "history", label: "本浏览器作品" },
                                { key: "help", label: "使用说明" },
                            ]}
                        />
                        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="store-result-scroll">
                            {tab === "current" && (
                                <div className="flex min-h-[320px] flex-col gap-3 lg:h-full">
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
                                    {!viewed && d.storeOutputStale && d.video && <Alert type="warning" title="输入已变化，以下为上一次制作的结果" />}
                                    {result ? (
                                        <>
                                            <div className="flex min-h-[260px] flex-1 items-center justify-center rounded-lg" style={{ background: token.colorFillQuaternary }}>
                                                <video controls src={result.url} className="max-h-[65vh] w-full rounded-lg object-contain" onError={() => setPreviewError(true)} />
                                            </div>
                                            {previewError && <Alert type="warning" title="当前浏览器无法播放此编码，仍可下载原文件" />}
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
                                        </>
                                    ) : viewed?.text ? (
                                        <Input.TextArea rows={14} value={viewed.text} readOnly aria-label="历史文案" />
                                    ) : (
                                        <div className="flex min-h-[300px] flex-1 items-center justify-center">
                                            <Empty description="视频制作完成后在这里预览" />
                                        </div>
                                    )}
                                    <p className="text-xs" style={muted}>
                                        当前生成单条视频片段。配音、字幕与多镜头剪辑需相应模型或额外处理，不会自动完成。
                                    </p>
                                </div>
                            )}
                            {tab === "history" && (
                                <div className="space-y-3">
                                    {!wb.records.length && <Empty description="本浏览器还没有探店作品或文案记录" />}
                                    {wb.records.map((r) => (
                                        <article key={r.id} className="space-y-2 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }}>
                                            <div className="flex items-center justify-between gap-2">
                                                <strong className="font-medium">{stageLabels[r.stage] || r.stage}</strong>
                                                <Tag color={r.status === "completed" ? "success" : r.status === "failed" ? "error" : "processing"}>{states[r.status]}</Tag>
                                            </div>
                                            <p className="text-xs" style={muted}>
                                                {new Date(r.createdAt).toLocaleString()} · {r.storeExploreInput?.storeSettings?.videoModel ? videoProfile(config, r.storeExploreInput.storeSettings.videoModel).displayName : "原任务"}
                                                {r.stage === "video" && r.storeExploreInput?.storeSettings ? ` · ${r.storeExploreInput.storeSettings.videoSeconds}秒 · ${r.storeExploreInput.storeSettings.vquality}p` : ""}
                                            </p>
                                            {r.error && (
                                                <p className="text-xs" style={{ color: token.colorError }}>
                                                    {r.error}
                                                </p>
                                            )}
                                            <Space wrap>
                                                {(r.result || r.text) && (
                                                    <Button size="small" onClick={() => void showRecord(r)}>
                                                        查看作品
                                                    </Button>
                                                )}
                                                {r.storeExploreInput && (
                                                    <Button size="small" disabled={locked} onClick={() => restoreInput(r)}>
                                                        恢复输入
                                                    </Button>
                                                )}
                                                {["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask) && (
                                                    <Button
                                                        size="small"
                                                        disabled={locked}
                                                        onClick={() => {
                                                            setViewed(null);
                                                            setTab("current");
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
                                                        onClick={() => {
                                                            let prediction = "";
                                                            modal.confirm({
                                                                title: "核对平台任务",
                                                                content: (
                                                                    <Input
                                                                        placeholder="原任务编号，不创建新任务"
                                                                        onChange={(e) => {
                                                                            prediction = e.target.value.trim();
                                                                        }}
                                                                    />
                                                                ),
                                                                onOk: () => reconcileReplicateTask(r.replicateTask!.id, prediction),
                                                            });
                                                        }}
                                                    >
                                                        核对平台任务
                                                    </Button>
                                                )}
                                            </Space>
                                        </article>
                                    ))}
                                </div>
                            )}
                            {tab === "help" && (
                                <div className="space-y-4 text-sm">
                                    <h2 className="font-medium">如何制作探店片段</h2>
                                    <ol className="list-inside list-decimal space-y-2">
                                        <li>上传门店与商品照片，填写真实资料。</li>
                                        <li>按需要上传人物图，分析素材或直接填写脚本。</li>
                                        <li>选择多图参考模型，或明确选择生成首帧。</li>
                                        <li>核对当前时长、清晰度与费用，再确认制作。</li>
                                    </ol>
                                    <p style={muted}>门店地址、价格与活动不从照片推测。输入变化会保留原稿并提示核对；AI 新稿需明确采用。</p>
                                    <p style={muted}>单首帧模型不会直接接收其他门店或人物照片。希望人物出现在画面中时，请上传已有的门店人物合成首帧。</p>
                                    <p style={muted}>没有本站实测样例时不展示外站作品充当生成效果。草稿与作品保存在当前浏览器。</p>
                                </div>
                            )}
                        </div>
                    </aside>
                </div>
            </div>
            <div className="shrink-0 space-y-2 border-t px-4 py-3 lg:hidden" style={{ ...surface, borderColor: token.colorBorderSecondary }}>
                <div className="flex items-center gap-2">
                    <Select
                        aria-label="视频模型"
                        className="min-w-0 flex-1"
                        disabled={locked}
                        value={model}
                        virtual={false}
                        optionRender={(option) => <VideoModelOption config={config} model={String(option.value)} />}
                        onChange={(videoModel) => changeSettings({ videoModel })}
                        options={selectableModelsByCapability(config, "video").map((value) => ({ value, label: videoProfile(config, value).displayName }))}
                    />
                    <Button aria-label="刷新模型" icon={<RefreshCw size={14} />} disabled={locked} loading={refreshing} onClick={() => void refreshModels()} />
                    <Button disabled={locked} onClick={() => setSettingsOpen(true)}>
                        规格
                    </Button>
                </div>
                <div className="text-xs" style={muted}>
                    {spec}
                </div>
                {controls}
            </div>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
            <Modal title={editor ? names[editor] : "编辑"} width={900} open={Boolean(editor)} onCancel={() => setEditor(null)} footer={<Button onClick={() => setEditor(null)}>完成</Button>}>
                {editor && <Input.TextArea aria-label={`放大编辑${names[editor]}`} rows={14} disabled={locked} value={d[editor] || ""} onChange={(e) => edit(editor, e.target.value)} />}
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
                            <Input aria-label="视频时长" disabled={locked} value={cfg.videoSeconds} onChange={(e) => changeSettings({ videoSeconds: e.target.value })} />
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
                        <label>
                            <Switch aria-label="视频插帧" disabled={locked} checked={cfg.videoInterpolate === "true"} onChange={(value) => changeSettings({ videoInterpolate: String(value) })} /> 插帧（使用对应费用档）
                        </label>
                    )}
                    {profile.generateAudio && (
                        <label>
                            <Switch aria-label="生成声音" disabled={locked} checked={cfg.videoGenerateAudio === "true"} onChange={(value) => changeSettings({ videoGenerateAudio: String(value) })} /> 生成声音
                        </label>
                    )}
                    {profile.interface === "ark" && (
                        <label>
                            <Switch aria-label="平台水印" disabled={locked} checked={cfg.videoWatermark === "true"} onChange={(value) => changeSettings({ videoWatermark: String(value) })} /> 平台水印
                        </label>
                    )}
                    {cloud && (
                        <p className="text-xs" style={muted}>
                            {hailuo ? "768p支持6/10秒；1080p仅支持6秒。上传图片跟随首帧，纯文字使用平台默认比例。" : "当前探店仅使用1张首帧，比例跟随该图。"}
                        </p>
                    )}
                    <p className="text-xs" style={muted}>
                        脚本、费用预估与正式生成共用这些规格。
                    </p>
                </div>
            </Modal>
        </main>
    );
}
