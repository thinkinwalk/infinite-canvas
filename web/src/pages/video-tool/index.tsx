import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Alert, App, Button, Card, Collapse, Empty, Input, InputNumber, Modal, Select, Space, Spin, Steps, Switch, Table, Tag, theme } from "antd";
import { Download, FolderPlus, Grid2X2, History, Settings, Sparkles, Trash2, Upload, X } from "lucide-react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { VideoSettingsPanel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { getWorkerCapabilities, workbenchMediaBlob } from "@/services/api/video-worker";
import { imageToDataUrl } from "@/services/image-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { type MediaRole, type SubtitleRegion, type SubtitleMarkMode, type VideoTool, type WorkerCapabilities } from "@/types/video-workbench";
import { getReplicateModels, publicServiceText, reconcileReplicateTask, REPLICATE_MODEL_NAMES, type ReplicateOperation, type ReplicateQuote } from "@/services/api/replicate";
import { useUserStore } from "@/stores/use-user-store";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";
import ContentReplaceWorkspace from "./content-replace-workspace";
import StoreExploreWorkspace from "./store-explore-workspace";
import ViralRecreateWorkspace from "./viral-recreate-workspace";
import DigitalHumanWorkspace from "./digital-human-workspace";
import TalkingVideoWorkspace from "./talking-video-workspace";
import UpscaleWorkspace from "./upscale-workspace";

const tools: Record<VideoTool, { title: string; description: string }> = {
    "cloud-create": { title: "视频创作", description: "上传首帧图片、填写可编辑脚本，生成单镜头短视频。可选择约 5 秒或 7.5 秒；成片可下载、保存素材或加入画布。" },
    "content-replace": { title: "视频内容替换", description: "上传原视频与替换图片，替换人物、商品或背景。可使用支持视频参考的模型，或平台增强处理服务。" },
    "store-explore": { title: "探店视频", description: "门店素材 → 素材分析 → 门店信息 → 可编辑脚本 → 视频。价格、地址和促销以你填写的信息为准。" },
    "viral-recreate": { title: "爆款复刻", description: "参考视频 → 关键帧与语音 → 镜头节奏分析 → 新商品脚本 → 生成视频。" },
    "digital-human": { title: "数字人工作台", description: "文案 → 口播与口型 → 剪气口 → 标题标签 → 字幕配乐 → 封面。每一步可单独执行，也可按当前设置自动完成。" },
    "photo-talk": { title: "照片说话", description: "人物照片与音频生成说话视频。" },
    lipsync: { title: "视频对口型", description: "人物视频匹配新的语音与口型。" },
    upscale: { title: "视频高清", description: "使用平台视频增强或增强处理服务提升清晰度，可选择目标分辨率与帧率。" },
    "subtitle-remove": { title: "硬字幕去除", description: "可使用平台智能服务手动框选去除硬字幕，也可使用增强处理服务进行 OCR 与智能修复。" },
};
export default function VideoToolPage() {
    const params = useParams();
    const location = useLocation();
    const tool = location.pathname === "/digital-human" ? "digital-human" : params.tool;
    if (!tool || !(tool in tools))
        return (
            <Empty description="未找到该视频工具">
                <Link to="/video">返回视频制作</Link>
            </Empty>
        );
    if (tool === "photo-talk" || tool === "lipsync") return <TalkingVideoWorkspace key={tool} tool={tool} />;
    return tool === "content-replace" ? <ContentReplaceWorkspace /> : tool === "store-explore" ? <StoreExploreWorkspace /> : tool === "viral-recreate" ? <ViralRecreateWorkspace /> : tool === "digital-human" ? <DigitalHumanWorkspace /> : tool === "upscale" ? <UpscaleWorkspace /> : <VideoWorkbench key={tool} tool={tool as VideoTool} />;
}

function VideoWorkbench({ tool }: { tool: VideoTool }) {
    const location = useLocation();
    const appliedSearch = useRef<string | null>(null);
    const wb = useVideoWorkbench(tool);
    const { draft: d, busy } = wb;
    const { token } = theme.useToken();
    const { message, modal } = App.useApp();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((s) => s.updateConfig);
    const openConfig = useConfigStore((s) => s.openConfigDialog);
    const themeMode = useThemeStore((s) => s.theme);
    const platformToken = useUserStore((state) => state.token);
    const administrator = useUserStore((state) => state.user?.role === "admin");
    const [cloudModels, setCloudModels] = useState<ReplicateQuote[]>([]);
    const [cloudError, setCloudError] = useState("");
    const [previewError, setPreviewError] = useState(false);
    const [serviceOpen, setServiceOpen] = useState(false);
    const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [assetRole, setAssetRole] = useState<{ role: MediaRole; accept: string } | null>(null);
    const [capabilities, setCapabilities] = useState<WorkerCapabilities[] | null>(null);
    const [serviceError, setServiceError] = useState("");
    const [checking, setChecking] = useState(false);
    const [drawRegions, setDrawRegions] = useState(false);
    const [drawing, setDrawing] = useState<SubtitleRegion | null>(null);
    const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
    const reference = d.media.find((m) => m.role === "reference" && m.kind === "video");
    const subtitleCapability = capabilities?.find((item) => item.name === "subtitle-remove");
    const ocrCapability = capabilities?.find((item) => item.name === "ocr");
    const subtitleReady =
        tool !== "subtitle-remove" ||
        (d.route === "replicate"
            ? Boolean(reference && d.subtitleMode === "manual" && d.regions.length > 0)
            : Boolean(reference && subtitleCapability?.available && (d.subtitleMode === "manual" ? d.regions.length > 0 : ocrCapability?.available)));
    const processing = tool === "upscale" || tool === "subtitle-remove";
    const digital = tool === "digital-human";
    const result = d.final || d.edited || d.video;
    const videoOperation: ReplicateOperation = digital
        ? d.digitalHumanMode === "video"
            ? "lipsync"
            : "digital-human"
        : tool === "upscale"
          ? "upscale"
          : tool === "content-replace"
            ? d.replacement === "person"
                ? "replace-person"
                : d.maskedEdit
                  ? "masked-edit"
                  : "video-edit"
            : tool === "subtitle-remove"
              ? "subtitle-remove"
              : "image-to-video";
    const relevantOperations: ReplicateOperation[] = digital ? ["speech", videoOperation] : [videoOperation];
    useEffect(() => {
        if (!wb.hydrated || appliedSearch.current === location.search) return;
        appliedSearch.current = location.search;
        const query = new URLSearchParams(location.search);
        const mode = query.get("mode");
        const replacement = query.get("replacement");
        if (mode === "photo" || mode === "video") wb.edit({ digitalHumanMode: mode, route: "replicate" }, "video");
        if (replacement === "person" || replacement === "product" || replacement === "background") wb.edit({ replacement, route: "replicate", maskedEdit: query.get("masked") === "1" }, "video");
        if (query.get("focus")) document.getElementById(query.get("focus") === "speech" ? "speech-settings" : "avatar-settings")?.scrollIntoView({ block: "start" });
    }, [wb.hydrated, location.search]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const checkService = async () => {
        setChecking(true);
        setServiceError("");
        try {
            setCapabilities(await getWorkerCapabilities(useVideoWorkbenchStore.getState().worker));
        } catch (error) {
            setCapabilities(null);
            setServiceError(publicServiceText(error instanceof Error ? error.message : "服务不可用"));
        } finally {
            setChecking(false);
        }
    };
    useEffect(() => {
        if (wb.hydrated) void checkService();
    }, [wb.hydrated, wb.worker.url]);
    const checkCloud = async () => {
        try {
            setCloudModels(await getReplicateModels());
            setCloudError("");
        } catch (error) {
            setCloudModels([]);
            setCloudError(error instanceof Error ? error.message : "云服务读取失败");
        }
    };
    useEffect(() => {
        if (platformToken) void checkCloud();
        else {
            setCloudModels([]);
            setCloudError("登录后使用平台智能服务");
        }
    }, [platformToken]);
    const modelPicker = (capability: "text" | "video" | "audio" | "image", label: string) => (
        <div className="space-y-2">
            <div style={{ color: token.colorTextSecondary }}>{label}</div>
            <ModelPicker config={config} capability={capability} value={config[`${capability}Model`]} onChange={(value) => updateConfig(`${capability}Model`, value)} onMissingConfig={() => openConfig(true)} fullWidth />
        </div>
    );
    const action = (stage: string, label: string, primary = false, blocked = false) => (
        <Button type={primary ? "primary" : "default"} disabled={busy || blocked} icon={<Sparkles size={15} />} onClick={() => void wb.run(stage)}>
            {label}
        </Button>
    );
    const materialField = (role: MediaRole, accept: string, label: string, multiple = false) => (
        <Card size="small" title={label}>
            <Space wrap>
                <Button icon={<Upload size={15} />} disabled={busy} onClick={(event) => event.currentTarget.querySelector<HTMLInputElement>("input")?.click()}>
                    上传
                    <input
                        type="file"
                        className="hidden"
                        accept={accept}
                        multiple={multiple}
                        disabled={busy}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(e) => {
                            void wb.addFiles(Array.from(e.target.files || []), role, accept);
                            e.target.value = "";
                        }}
                    />
                </Button>
                {!accept.startsWith("audio") && (
                    <Button disabled={busy} onClick={() => setAssetRole({ role, accept })}>
                        从我的素材选择
                    </Button>
                )}
            </Space>
            <div className="mt-3 flex flex-wrap gap-3">
                {d.media
                    .filter((m) => m.role === role)
                    .map((m) => (
                        <div key={m.id} className="w-full space-y-1 sm:max-w-56">
                            {m.kind === "image" ? (
                                <img className="max-h-40 w-full rounded object-contain" src={m.url} alt={m.name} />
                            ) : m.kind === "video" ? (
                                <video className="max-h-40 w-full rounded" src={m.url} controls preload="metadata" />
                            ) : (
                                <audio className="w-full" src={m.url} controls />
                            )}
                            <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-xs" title={m.name}>
                                    {m.name}
                                </span>
                                <Button type="text" disabled={busy} size="small" icon={<X size={14} />} aria-label="移除素材" onClick={() => wb.removeMedia(m.id)} />
                            </div>
                            {!!m.durationMs && (
                                <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                    素材时长：{(m.durationMs / 1000).toFixed(2)} 秒；扣费以服务器读取的时长为准
                                </div>
                            )}
                        </div>
                    ))}
            </div>
        </Card>
    );
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!assetRole || payload.kind === "text") {
            message.error("请选择图片或视频素材");
            return;
        }
        try {
            if (!assetRole.accept.includes(`${payload.kind}/`)) throw new Error("素材类型与此位置不匹配");
            const blob =
                payload.kind === "image"
                    ? await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob()
                    : await workbenchMediaBlob({ url: payload.url, storageKey: payload.storageKey || "", mimeType: "video/mp4", bytes: 0 });
            await wb.addFiles([new File([blob], payload.title, { type: blob.type })], assetRole.role, assetRole.accept);
            setAssetRole(null);
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "读取素材失败"));
        }
    };
    const reconcile = (id: string) => {
        let predictionId = "";
        modal.confirm({
            title: "核对并关联已有平台任务",
            content: (
                <div className="space-y-3">
                    <p>如果任务提交后状态暂未返回，请填写原任务编号。后台会比对原始输入；此操作不会创建新的收费任务。</p>
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
                    await reconcileReplicateTask(id, predictionId);
                    message.success("已关联，可恢复查询取得结果");
                } catch (error) {
                    message.error(publicServiceText(error instanceof Error ? error.message : "关联失败"));
                    throw error;
                }
            },
        });
    };
    const point = (e: PointerEvent<HTMLDivElement>) => {
        const bounds = e.currentTarget.getBoundingClientRect();
        return { x: Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (e.clientY - bounds.top) / bounds.height)) };
    };
    const instructions = (
        <Card size="small" title={digital ? "① 文案主题与口播" : "制作资料与要求"}>
            <Input.TextArea
                rows={4}
                disabled={busy}
                value={d.instructions}
                placeholder={tool === "store-explore" ? "填写门店名称、地址、招牌产品、真实价格、目标人群与活动信息" : digital ? "输入主题、产品信息和表达风格，也可在下方直接填写口播" : "说明商品、目标人群和想要的效果"}
                onChange={(e) => wb.edit({ instructions: e.target.value }, "script")}
            />
            {digital && (
                <>
                    <div className="my-3">口播文案（可编辑）</div>
                    <Input.TextArea rows={5} value={d.narration} disabled={busy} placeholder="只填写需要朗读的正文" onChange={(e) => wb.edit({ narration: e.target.value, script: e.target.value }, "script")} />
                    <div className="mt-3">{action("script", "AI 撰写口播")}</div>
                </>
            )}
        </Card>
    );
    const completedSteps = d.cover ? 6 : d.final ? 5 : d.title ? 4 : d.edited ? 3 : d.video ? 2 : d.script || d.narration ? 1 : 0;
    if (!wb.hydrated)
        return (
            <div className="p-12 text-center">
                <Spin tip="加载视频工作台" />
            </div>
        );
    return (
        <main className="mx-auto h-full max-w-7xl space-y-5 overflow-y-auto px-4 py-6 sm:px-6" tabIndex={0} aria-label={`${tools[tool].title}工作台`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="mb-2 text-sm">
                        <Link to="/video">视频制作</Link> / {tools[tool].title}
                    </div>
                    <h1 className="text-2xl font-semibold">{tools[tool].title}</h1>
                    <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: token.colorTextSecondary }}>
                        {tools[tool].description}
                    </p>
                </div>
                <Space wrap>
                    <Button icon={<Settings size={16} />} onClick={() => setServiceOpen(true)}>
                        处理服务
                    </Button>
                    <Button onClick={() => openConfig(true)}>模型设置</Button>
                    <Button icon={<History size={16} />} onClick={() => setHistoryOpen(true)}>
                        任务记录
                    </Button>
                </Space>
            </div>
            {wb.storageError && <Alert type="error" showIcon title="本地保存异常" description={wb.storageError} />}
            {serviceError && d.route !== "replicate" && (d.route === "worker" || tool === "subtitle-remove") && (
                <Alert
                    type="warning"
                    showIcon
                    title="视频处理服务未连接"
                    description={
                        <span>
                            {serviceError}。
                            <Button type="link" onClick={() => setServiceOpen(true)}>
                                配置服务
                            </Button>
                        </span>
                    }
                />
            )}
            {busy && (
                <Alert
                    type="info"
                    showIcon
                    icon={<Spin size="small" />}
                    title={`${stageLabels[active?.stage || ""] || "正在处理"}：${active?.step || "请求执行中"}`}
                    description={
                        <Space>
                            <Button onClick={wb.stop}>停止等待</Button>
                            {(active?.workerJob || active?.replicateTask) && (
                                <Button danger onClick={() => void wb.cancel()}>
                                    取消处理任务
                                </Button>
                            )}
                        </Space>
                    }
                />
            )}
            {!busy && active && (active.status === "running" || active.status === "interrupted") && (active.modelTask || active.workerJob || active.replicateTask) && (
                <Alert type="info" showIcon title="有已提交的任务可继续查询" description={<Button onClick={() => void wb.resume(active)}>恢复任务结果</Button>} />
            )}
            {digital && <Steps size="small" current={completedSteps} items={["文案", "口播口型", "剪气口", "标题标签", "字幕配乐", "封面"].map((title) => ({ title }))} />}
            <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)]">
                <div className="space-y-4">
                    <>
                        <Collapse
                            items={[
                                {
                                    key: "advanced",
                                    label: "高级设置 · 处理方式",
                                    children: (
                                        <>
                                            <Space wrap>
                                                <Select
                                                    aria-label="处理方式"
                                                    disabled={busy}
                                                    value={d.route}
                                                    onChange={(route) => wb.edit({ route }, digital ? "speech" : "video")}
                                                    options={[
                                                        { value: "replicate", label: "平台智能处理（推荐）" },
                                                        ...(!["subtitle-remove"].includes(tool) ? [{ value: "model", label: "已配置模型与处理服务" }] : []),
                                                        ...(["content-replace", "digital-human", "upscale", "subtitle-remove"].includes(tool) ? [{ value: "worker", label: "增强处理服务" }] : []),
                                                    ]}
                                                />
                                                {d.route === "replicate" && (
                                                    <Button disabled={busy} onClick={() => void checkCloud()}>
                                                        检查云服务
                                                    </Button>
                                                )}
                                            </Space>
                                            {d.route === "replicate" && (
                                                <div className="mt-3 text-sm" style={{ color: token.colorTextSecondary }}>
                                                    AI 运算由平台智能服务完成，文案和封面使用当前平台配置。每次创建任务前确认算力点；字幕、剪气口和配乐由处理服务完成。
                                                </div>
                                            )}
                                        </>
                                    ),
                                },
                            ]}
                        />
                    </>
                    {digital && (
                        <Card size="small" title="数字人制作方式">
                            <Select
                                aria-label="数字人制作方式"
                                disabled={busy}
                                value={d.digitalHumanMode}
                                onChange={(digitalHumanMode) => wb.edit({ digitalHumanMode }, "video")}
                                options={[
                                    { value: "photo", label: "照片说话 · 上传照片 + 口播音频" },
                                    { value: "video", label: "视频对口型 · 上传人物视频 + 新音频" },
                                ]}
                                className="w-full"
                            />
                            <p className="mt-3 text-sm" style={{ color: token.colorTextSecondary }}>
                                {d.digitalHumanMode === "photo" ? "例如：上传店主照片，让店主讲解新品。" : "例如：上传已有介绍视频，用新口播替换原口型。"}
                            </p>
                        </Card>
                    )}
                    {d.route === "replicate" && (
                        <Card size="small" title="本功能使用的模型">
                            <div className="space-y-3">
                                {relevantOperations.map((operation) => {
                                    const item = cloudModels.find((m) => m.operation === operation);
                                    return (
                                        <div key={operation}>
                                            <strong>{REPLICATE_MODEL_NAMES[operation]}</strong>
                                            <div className="mt-1 text-sm" style={{ color: token.colorTextSecondary }}>
                                                {publicServiceText(item?.description || "")}
                                            </div>
                                            <Tag className="mt-2" color={item?.available ? "success" : "default"}>
                                                {item?.available ? "可使用" : "暂不可用"}
                                            </Tag>
                                            {!item?.available && <span className="text-xs">{publicServiceText(item?.reason || cloudError || "正在读取服务状态")}</span>}
                                            <div className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>
                                                {publicServiceText(item?.billingDescription || "平台按本次规格计费" )}；制作前显示本次扣点明细。
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    )}
                    {d.route === "replicate" && (["cloud-create", "store-explore", "viral-recreate"].includes(tool) || (tool === "content-replace" && d.replacement === "person")) && (
                        <Card size="small" title="平台视频参数">
                            <Space wrap>
                                <span>分辨率</span>
                                <Select
                                    aria-label="平台视频分辨率"
                                    disabled={busy}
                                    value={d.replicateResolution}
                                    onChange={(replicateResolution) => wb.edit({ replicateResolution }, "video")}
                                    options={[
                                        { value: "480p", label: "480p" },
                                        { value: "720p", label: "720p" },
                                    ]}
                                />
                                {tool !== "content-replace" && (
                                    <>
                                        <span>时长</span>
                                        <Select
                                    aria-label="平台视频时长"
                                            disabled={busy}
                                            value={d.replicateFrames}
                                            onChange={(replicateFrames) => wb.edit({ replicateFrames }, "video")}
                                            options={[
                                                { value: 81, label: "约 5 秒" },
                                                { value: 121, label: "约 7.5 秒" },
                                            ]}
                                        />
                                    </>
                                )}
                            </Space>
                        </Card>
                    )}

                    {processing ? (
                        materialField("reference", "video/*", "原视频")
                    ) : digital ? (
                        instructions
                    ) : (
                        <>
                            {materialField(
                                "reference",
                                tool === "store-explore" || tool === "cloud-create" ? "image/*" : "video/*",
                                tool === "store-explore" ? "门店 / 商品参考图" : tool === "cloud-create" ? "首帧图片" : "参考视频",
                                tool === "store-explore",
                            )}
                            {materialField("model", "image/*", tool === "content-replace" ? "替换人物 / 商品图片" : "商品 / 出镜模特图片", true)}
                            {tool === "content-replace" && materialField("background", "image/*", "背景参考图（替换背景时必填）")}
                            {instructions}
                        </>
                    )}
                    {tool === "content-replace" && (d.route === "worker" || (d.route === "replicate" && d.maskedEdit)) && d.replacement !== "person" && materialField("mask", "image/*,video/*", "编辑掩膜（白色区域改动，黑色区域保留）")}
                    {tool === "content-replace" && (
                        <Card size="small" title="替换设置">
                            <Space wrap>
                                <Select
                                    disabled={busy}
                                    value={d.replacement}
                                    onChange={(replacement) => wb.edit({ replacement }, "video")}
                                    options={[
                                        { value: "person", label: "替换人物" },
                                        { value: "product", label: "替换商品" },
                                        { value: "background", label: "替换背景" },
                                    ]}
                                />
                                {d.route === "replicate" && d.replacement !== "person" && (
                                    <>
                                        <Switch aria-label="掩膜局部编辑" disabled={busy} checked={d.maskedEdit} onChange={(maskedEdit) => wb.edit({ maskedEdit }, "video")} />
                                        <span>使用掩膜指定区域（局部精修）</span>
                                    </>
                                )}
                            </Space>
                            <p className="mt-3 text-sm" style={{ color: token.colorTextSecondary }}>
                                人物替换、商品和背景编辑使用平台视频处理能力（商品和背景原视频需为 2–10 秒）。开启局部精修并上传掩膜后，只处理指定区域；生成效果需用实际素材验收。
                            </p>
                            <div className="mt-3">{action("video", "开始替换", true)}</div>
                        </Card>
                    )}
                    {(tool === "cloud-create" || tool === "store-explore" || tool === "viral-recreate") && (
                        <>
                            <Card size="small" title="素材分析">
                                <Space wrap>
                                    {tool === "viral-recreate" && (
                                        <>
                                            <span>抽取帧数</span>
                                            <InputNumber disabled={busy} min={1} precision={0} value={d.frameCount} onChange={(value) => wb.edit({ frameCount: value || 1 }, "materials")} />
                                            {action("transcribe", "转写参考音轨")}
                                        </>
                                    )}
                                    {action("analyze", "分析素材")}
                                </Space>
                                {d.frames.length > 0 && (
                                    <div className="mt-3 flex gap-2 overflow-x-auto">
                                        {d.frames.map((f) => (
                                            <img key={f.storageKey} src={f.url} alt="参考关键帧" className="h-24 rounded" />
                                        ))}
                                    </div>
                                )}
                                <Input.TextArea className="mt-3" disabled={busy} rows={6} value={d.analysis} placeholder="AI 分析后可在此修订事实与镜头结构" onChange={(e) => wb.edit({ analysis: e.target.value }, "script")} />
                                {d.transcript && (
                                    <Collapse
                                        className="mt-3"
                                        items={[{ key: "transcript", label: "参考语音转写", children: <Input.TextArea rows={3} disabled={busy} value={d.transcript} onChange={(e) => wb.edit({ transcript: e.target.value }, "script")} /> }]}
                                    />
                                )}
                            </Card>
                            {d.route === "replicate" && tool !== "cloud-create" && materialField("first-frame", "image/*", "生成首帧（可选；未上传时使用参考图片或已抽取画面）")}
                            <Card size="small" title="视频脚本">
                                <Input.TextArea disabled={busy} rows={8} value={d.script} placeholder="分析后点击 AI 撰写，也可直接填写脚本" onChange={(e) => wb.edit({ script: e.target.value }, "script")} />
                                <Space className="mt-3" wrap>
                                    {action("script", "AI 撰写脚本")}
                                    {action("video", "生成视频", true)}
                                </Space>
                            </Card>
                        </>
                    )}
                    {digital && (
                        <>
                            <Card id="speech-settings" size="small" title="② 口播与口型">
                                <Space wrap>
                                    <Select
                                        disabled={busy}
                                        value={d.voiceMode}
                                        onChange={(voiceMode) => wb.edit({ voiceMode }, "speech")}
                                        options={[
                                            { value: "api", label: d.route === "replicate" ? "系统音色配音" : "已配置语音模型" },
                                            { value: "clone", label: d.route === "replicate" ? "声音样本克隆" : "声音样本克隆 · 已配置服务" },
                                        ]}
                                    />
                                    {d.route === "replicate" ? (
                                        <Select
                                            aria-label="朗读语言"
                                            disabled={busy}
                                            value={d.language === "中文" ? "Chinese" : d.language}
                                            onChange={(language) => wb.edit({ language }, "speech")}
                                            options={["Chinese", "English", "Japanese", "Korean", "French", "German", "Italian", "Spanish", "Portuguese", "Russian", "auto"].map((value) => ({
                                                value,
                                                label: value === "Chinese" ? "中文" : value === "auto" ? "自动识别" : value,
                                            }))}
                                        />
                                    ) : (
                                        <Input className="!w-32" disabled={busy} value={d.language} placeholder="朗读语言" onChange={(e) => wb.edit({ language: e.target.value }, "speech")} />
                                    )}
                                </Space>
                                {d.voiceMode === "api" ? (
                                    <div className="mt-3 space-y-2">
                                        {d.route === "replicate" ? (
                                            <Select
                                                aria-label="配音音色"
                                                disabled={busy}
                                                value={d.replicateSpeaker}
                                                onChange={(replicateSpeaker) => wb.edit({ replicateSpeaker }, "speech")}
                                                options={["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"].map((value) => ({ value, label: value }))}
                                            />
                                        ) : (
                                            <>
                                                {modelPicker("audio", "语音模型")}
                                                <Input disabled={busy} value={d.voice} placeholder="模型支持的 voice 名称，例如 alloy" onChange={(e) => wb.edit({ voice: e.target.value }, "speech")} />
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <div className="mt-3 space-y-3">
                                        {materialField("voice", "audio/*", "声音样本")}
                                        <Input.TextArea
                                            disabled={busy}
                                            value={d.promptTranscript}
                                            rows={2}
                                            placeholder={d.route === "replicate" ? "声音样本的原文（推荐填写）" : "声音样本中实际说出的文字"}
                                            onChange={(e) => wb.edit({ promptTranscript: e.target.value }, "speech")}
                                        />
                                    </div>
                                )}
                                <Space wrap className="mt-3">
                                    {action("speech", "生成口播")}
                                    <Button disabled={busy} onClick={(event) => event.currentTarget.querySelector<HTMLInputElement>("input")?.click()}>
                                        导入口播
                                        <input
                                            type="file"
                                            className="hidden"
                                            accept="audio/*"
                                            onClick={(event) => event.stopPropagation()}
                                            onChange={async (e) => {
                                                const file = e.target.files?.[0];
                                                e.target.value = "";
                                                if (file) {
                                                    try {
                                                        const { uploadMediaFile } = await import("@/services/file-storage");
                                                        wb.edit({ speech: await uploadMediaFile(file, "video-speech") }, "video");
                                                    } catch {
                                                        message.error("导入音频失败");
                                                    }
                                                }
                                            }}
                                        />
                                    </Button>
                                </Space>
                                {d.speech && <audio className="mt-3 w-full" controls src={d.speech.url} />}
                                {d.speech?.durationMs && <div className="mt-2 text-sm">口播音频：{(d.speech.durationMs / 1000).toFixed(2)} 秒</div>}
                                <div id="avatar-settings" className="mt-4">
                                    {materialField("avatar", d.digitalHumanMode === "video" ? "video/*" : "image/*", d.digitalHumanMode === "video" ? "人物正面视频" : "人物照片")}
                                </div>
                                <div className="mt-3">{action("video", d.digitalHumanMode === "video" ? "生成对口型视频" : "让照片说话", true)}</div>
                                <Collapse className="mt-3" items={[{ key: "import", label: "已有口播视频：直接导入继续后续制作", children: materialField("reference", "video/*", "已有口播视频") }]} />
                            </Card>
                            <Card size="small" title="③ 剪气口">
                                <Space wrap>
                                    <Switch disabled={busy} checked={d.cutSilence} onChange={(cutSilence) => wb.edit({ cutSilence, edited: null, subtitles: [] }, "finish")} />
                                    <span>自动流程中去除语音段落间空白</span>
                                    {action("cut", "执行剪气口")}
                                </Space>
                                <p className="mt-3 text-sm" style={{ color: token.colorTextSecondary }}>
                                    按逐词时间轴和标点拆出语音短句，剪掉短句间空白；完成后重新识别字幕以对齐新时间轴。
                                </p>
                            </Card>
                            <Card size="small" title="④ 标题与标签">
                                <Input disabled={busy} value={d.title} placeholder="视频标题" onChange={(e) => wb.edit({ title: e.target.value }, "cover")} />
                                <Input className="mt-3" disabled={busy} value={d.tags} placeholder="话题标签，用逗号分隔" onChange={(e) => wb.edit({ tags: e.target.value })} />
                                <div className="mt-3">{action("metadata", "生成标题与标签")}</div>
                            </Card>
                            <Card size="small" title="⑤ 字幕与配乐">
                                <Space wrap>
                                    <Switch disabled={busy} checked={d.addSubtitles} onChange={(addSubtitles) => wb.edit({ addSubtitles }, "finish")} />
                                    <span>烧录字幕</span>
                                    {action("subtitles", "识别字幕")}
                                    <Button
                                        disabled={busy}
                                        onClick={() => {
                                            const start = d.subtitles.at(-1)?.end || 0;
                                            wb.edit({ subtitles: [...d.subtitles, { start, end: start + 2, text: "" }] }, "finish");
                                        }}
                                    >
                                        添加字幕行
                                    </Button>
                                </Space>
                                <Table
                                    className="mt-3"
                                    size="small"
                                    pagination={false}
                                    scroll={{ x: 480 }}
                                    rowKey={(_, index) => String(index)}
                                    dataSource={d.subtitles}
                                    columns={[
                                        {
                                            title: "开始/秒",
                                            width: 100,
                                            render: (_, row, index) => (
                                                <InputNumber disabled={busy} min={0} step={0.1} value={row.start} onChange={(start) => wb.edit({ subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, start: start || 0 } : s)) }, "finish")} />
                                            ),
                                        },
                                        {
                                            title: "结束/秒",
                                            width: 100,
                                            render: (_, row, index) => (
                                                <InputNumber disabled={busy} min={0} step={0.1} value={row.end} onChange={(end) => wb.edit({ subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, end: end || 0 } : s)) }, "finish")} />
                                            ),
                                        },
                                        {
                                            title: "文字",
                                            render: (_, row, index) => <Input disabled={busy} value={row.text} onChange={(e) => wb.edit({ subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, text: e.target.value } : s)) }, "finish")} />,
                                        },
                                        { title: "", width: 36, render: (_, __, index) => <Button type="text" disabled={busy} icon={<Trash2 size={14} />} onClick={() => wb.edit({ subtitles: d.subtitles.filter((_, i) => i !== index) }, "finish")} /> },
                                    ]}
                                />
                                <Space wrap className="mt-3">
                                    <span>字号</span>
                                    <InputNumber min={1} disabled={busy} value={d.subtitleSize} onChange={(subtitleSize) => wb.edit({ subtitleSize: subtitleSize || 1 }, "finish")} />
                                    <span>字色</span>
                                    <input disabled={busy} aria-label="字幕颜色" type="color" value={d.subtitleColor} onChange={(e) => wb.edit({ subtitleColor: e.target.value }, "finish")} />
                                    <span>关键词色</span>
                                    <input disabled={busy} type="color" aria-label="关键词颜色" value={d.highlightColor} onChange={(e) => wb.edit({ highlightColor: e.target.value }, "finish")} />
                                </Space>
                                <Input className="mt-3" disabled={busy} value={d.keywords} placeholder="需要高亮的关键词，逗号分隔" onChange={(e) => wb.edit({ keywords: e.target.value }, "finish")} />
                                <div className="mt-3">{materialField("music", "audio/*", "背景音乐（可选）")}</div>
                                <Space className="mt-3" wrap>
                                    <span>音乐音量</span>
                                    <InputNumber min={0} max={1} step={0.1} disabled={busy} value={d.musicVolume} onChange={(musicVolume) => wb.edit({ musicVolume: musicVolume ?? 0 }, "finish")} />
                                    {action("compose", "合成字幕与配乐", true)}
                                </Space>
                            </Card>
                            <Card size="small" title="⑥ 封面">
                                <Space wrap>
                                    <Select
                                        disabled={busy}
                                        value={d.coverMode}
                                        options={[
                                            { value: "frame", label: "视频首帧（无需图片模型）" },
                                            { value: "image", label: "图片模型制作封面" },
                                        ]}
                                        onChange={(coverMode) => wb.edit({ coverMode }, "cover")}
                                    />
                                    {action("cover", "生成封面")}
                                </Space>
                                {d.coverMode === "image" && <div className="mt-3">{modelPicker("image", "封面模型")}</div>}
                            </Card>
                            <Button type="primary" size="large" block disabled={busy} icon={<Sparkles size={18} />} onClick={() => void wb.automatic()}>
                                按当前设置自动完成后续步骤
                            </Button>
                            <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                自动流程复用已完成的步骤。调用已配置模型时会按对应渠道计费。
                            </div>
                        </>
                    )}
                    {tool === "upscale" && d.route === "replicate" && (
                        <Card size="small" title="云高清参数">
                            <Space wrap>
                                <span>目标分辨率</span>
                                <Select
                                    aria-label="高清目标分辨率"
                                    disabled={busy}
                                    value={d.replicateTargetResolution}
                                    onChange={(replicateTargetResolution) => wb.edit({ replicateTargetResolution }, "finish")}
                                    options={["720p", "1080p", "4k"].map((value) => ({ value, label: value }))}
                                />
                                <span>目标帧率</span>
                                <InputNumber
                                    aria-label="高清目标帧率"
                                    min={15}
                                    max={60}
                                    precision={0}
                                    disabled={busy}
                                    value={d.replicateFps}
                                    onChange={(replicateFps) => {
                                        if (replicateFps) wb.edit({ replicateFps }, "finish");
                                    }}
                                />
                                {action("upscale", "开始云端增强", true)}
                            </Space>
                        </Card>
                    )}
                    {tool === "upscale" && d.route !== "replicate" && (
                        <Card size="small" title="增强设置">
                            <Space wrap>
                                <span>放大倍数</span>
                                <Select
                                    disabled={busy}
                                    value={d.scale}
                                    onChange={(scale) => wb.edit({ scale }, "finish")}
                                    options={[
                                        { value: 2, label: "2 倍" },
                                        { value: 4, label: "4 倍" },
                                    ]}
                                />
                                <span>目标帧率（留空保持原帧率）</span>
                                <InputNumber min={1} disabled={busy} value={d.fps} onChange={(fps) => wb.edit({ fps }, "finish")} />
                            </Space>
                            <div className="mt-4">{action("upscale", "开始增强", true)}</div>
                        </Card>
                    )}
                    {(tool === "subtitle-remove" || (tool === "content-replace" && d.route === "worker" && d.replacement !== "person")) && (
                        <Card size="small" title={tool === "subtitle-remove" ? "字幕区域" : "框选需要替换的区域"}>
                                    {tool === "subtitle-remove" && (
                                <>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {(["auto", "manual"] as SubtitleMarkMode[]).map((mode) => (
                                            <Button
                                                key={mode}
                                                block
                                                type={d.subtitleMode === mode ? "primary" : "default"}
                                                aria-pressed={d.subtitleMode === mode}
                                                disabled={busy}
                                                onClick={() => {
                                                    wb.edit({ subtitleMode: mode }, "finish");
                                                    setDrawRegions(mode === "manual");
                                                }}
                                            >
                                                {mode === "auto" ? "自动标记 · OCR 识别字幕" : "手动标记 · 框选字幕区域"}
                                            </Button>
                                        ))}
                                    </div>
                                    <p className="mt-2 text-sm" style={{ color: token.colorTextSecondary }}>
                                        {d.route === "replicate"
                                            ? "平台智能服务当前要求手动框选字幕区域，视频需为 2–10 秒；服务器会请求保留原音轨。"
                                            : d.subtitleMode === "auto"
                                            ? "上传后按帧识别文字区域；识别结果仍需检查，请先启用智能识别服务。"
                                              : "放大视频后框选固定字幕区域；适合字幕位置稳定的片段。"}
                                    </p>
                                    <Space wrap className="mt-3">
                                        {d.route === "replicate" ? <Tag color="success">平台智能服务：已连接</Tag> : <>
                                            <Tag color={subtitleCapability?.available ? "success" : "warning"}>
                                                修复引擎：{subtitleCapability?.available ? "可用" : publicServiceText(subtitleCapability?.reason || "未连接")}
                                            </Tag>
                                            <Tag color={ocrCapability?.available ? "success" : "warning"}>OCR：{ocrCapability?.available ? "可用" : publicServiceText(ocrCapability?.reason || "未连接")}</Tag>
                                        </>}
                                    </Space>
                                </>
                            )}
                            {tool !== "subtitle-remove" && (
                                <Space wrap>
                                    <Switch disabled={busy || !reference} checked={drawRegions} onChange={setDrawRegions} />
                                    <span>开启框选（先在视频中定位需要编辑的画面）</span>
                                </Space>
                            )}
                            <Space wrap className="mt-3">
                                <Button disabled={busy || !d.regions.length} onClick={() => wb.edit({ regions: [] }, "finish")}>
                                    清空区域
                                </Button>
                                {d.regions.length > 0 && <span className="text-sm">已选择 {d.regions.length} 个固定区域</span>}
                            </Space>
                            {reference && (
                                <div className="relative mt-3 overflow-hidden rounded">
                                    <video className="block h-auto w-full" controls src={reference.url} />
                                    <div
                                        className="absolute inset-0"
                                        style={{ pointerEvents: (tool === "subtitle-remove" ? d.subtitleMode === "manual" : drawRegions) && !busy ? "auto" : "none", cursor: "crosshair" }}
                                        onPointerDown={(e) => {
                                            e.currentTarget.setPointerCapture(e.pointerId);
                                            const a = point(e);
                                            setAnchor(a);
                                            setDrawing({ ...a, width: 0, height: 0 });
                                        }}
                                        onPointerMove={(e) => {
                                            if (!anchor) return;
                                            const b = point(e);
                                            setDrawing({ x: Math.min(anchor.x, b.x), y: Math.min(anchor.y, b.y), width: Math.abs(b.x - anchor.x), height: Math.abs(b.y - anchor.y) });
                                        }}
                                        onPointerUp={(e) => {
                                            if (drawing?.width && drawing.height) wb.edit({ regions: [...d.regions, drawing] }, "finish");
                                            setAnchor(null);
                                            setDrawing(null);
                                            e.currentTarget.releasePointerCapture(e.pointerId);
                                        }}
                                        onPointerCancel={() => {
                                            setAnchor(null);
                                            setDrawing(null);
                                        }}
                                    >
                                        {[...d.regions, ...(drawing ? [drawing] : [])].map((region, index) => (
                                            <div
                                                key={index}
                                                className="absolute border-2"
                                                style={{
                                                    left: `${region.x * 100}%`,
                                                    top: `${region.y * 100}%`,
                                                    width: `${region.width * 100}%`,
                                                    height: `${region.height * 100}%`,
                                                    borderColor: token.colorPrimary,
                                                    opacity: 0.55,
                                                    background: token.colorPrimaryBg,
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                            {d.regions.length > 0 && (
                                <div className="mt-3 space-y-1">
                                    {d.regions.map((region, index) => (
                                        <div key={`${region.x}-${region.y}-${index}`} className="flex items-center justify-between gap-2 text-sm">
                                            <span>
                                                区域 {index + 1}：{Math.round(region.x * 100)}% / {Math.round(region.y * 100)}%，{Math.round(region.width * 100)}% × {Math.round(region.height * 100)}%
                                            </span>
                                            <Button
                                                type="text"
                                                size="small"
                                                danger
                                                icon={<Trash2 size={14} />}
                                                aria-label={`删除字幕区域 ${index + 1}`}
                                                disabled={busy || (d.subtitleMode === "auto" && d.route === "replicate")}
                                                onClick={() => wb.edit({ regions: d.regions.filter((_, regionIndex) => regionIndex !== index) }, "finish")}
                                            />
                                        </div>
                                    ))}
                                </div>
                            )}
                            {tool === "subtitle-remove" && (
                                <>
                                    <div className="mt-3">
                                        {d.route === "replicate"
                                            ? d.regions.length
                                                ? "智能服务会把这些固定区域用于整段视频，请检查字幕位置是否稳定。"
                                                : "请切换到手动标记并在视频上框选至少一个字幕区域。"
                                            : d.subtitleMode === "auto"
                                              ? "未手动框选时使用 OCR；需要服务端配置 OCR 引擎。"
                                              : d.regions.length
                                                ? "固定区域会覆盖整个视频，请检查时间段内字幕位置是否稳定。"
                                                : "请在视频上框选至少一个字幕区域。"}
                                    </div>
                                    <div className="mt-3">{action("subtitle-remove", "去除硬字幕", true, !subtitleReady)}</div>
                                </>
                            )}
                            <p className="mt-3 text-sm" style={{ color: token.colorTextSecondary }}>
                                当前修复按帧执行，移动画面可能产生闪烁，输出后请检查字幕区域。
                            </p>
                        </Card>
                    )}
                </div>
                <aside className="space-y-4 lg:sticky lg:top-4">
                    {!processing && (d.route !== "replicate" || digital || ["store-explore", "viral-recreate"].includes(tool)) && (
                        <Card size="small" title="模型与视频参数">
                            <div className="space-y-4">
                                {(tool === "store-explore" || tool === "viral-recreate" || digital) && modelPicker("text", "分析 / 文案模型")}
                                {!digital && d.route !== "replicate" && modelPicker("video", "视频模型")}
                                {!digital && d.route !== "replicate" && (
                                    <Button disabled={busy} onClick={() => setModelSettingsOpen(true)}>
                                        尺寸、时长、分辨率
                                    </Button>
                                )}
                            </div>
                        </Card>
                    )}
                    <Card size="small" title="作品预览">
                        {result ? (
                            <>
                                {tool === "subtitle-remove" && reference ? (
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div>
                                            <div className="mb-1 text-xs" style={{ color: token.colorTextSecondary }}>原视频</div>
                                            <video className="w-full rounded" controls src={reference.url} />
                                        </div>
                                        <div>
                                            <div className="mb-1 text-xs" style={{ color: token.colorTextSecondary }}>去字幕结果</div>
                                            <video key={result.storageKey || result.url} className="w-full rounded" controls src={result.url} onError={() => setPreviewError(true)} />
                                        </div>
                                    </div>
                                ) : (
                                    <video key={result.storageKey || result.url} className="w-full rounded" controls src={result.url} onError={() => setPreviewError(true)} />
                                )}
                                {previewError && <Alert className="mt-3" type="warning" title="当前浏览器无法播放此编码" description="文件仍可下载；可以通过剪辑服务转换为 H.264 后预览。" />}
                                {tool === "upscale" && <div className="mt-3">{action("compatibility", "转换为浏览器播放格式")}</div>}
                                <Space wrap className="mt-4">
                                    <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                        下载视频
                                    </Button>
                                    <Button icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset()}>
                                        保存素材
                                    </Button>
                                    <Button icon={<Grid2X2 size={15} />} onClick={() => void wb.toCanvas()}>
                                        加入新画布
                                    </Button>
                                </Space>
                            </>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="处理完成后，视频显示在这里" />
                        )}
                        {d.cover && (
                            <div className="mt-4 space-y-2">
                                <img src={d.cover.url} alt="生成封面" className="w-full rounded" />
                                <Button onClick={() => void wb.download(d.cover!)} icon={<Download size={15} />}>
                                    下载封面
                                </Button>
                            </div>
                        )}
                        {d.title && (
                            <div className="mt-4">
                                <strong>{d.title}</strong>
                                <p className="mt-1 text-sm" style={{ color: token.colorTextSecondary }}>
                                    {d.tags}
                                </p>
                            </div>
                        )}
                    </Card>
                    {capabilities && (
                        <Card size="small" title="增强处理服务能力">
                            <Space wrap>
                                {capabilities.map((capability) => (
                                    <Tag key={capability.name} color={capability.available ? "success" : "default"} title={publicServiceText(capability.reason || "")}>
                                        {(
                                            {
                                                frames: "抽帧",
                                                compose: "合成",
                                                transcribe: "语音识别",
                                                cut: "剪气口",
                                                upscale: "高清增强",
                                                "subtitle-remove": "字幕修复",
                                                "digital-human": "口型",
                                                "replace-person": "人物替换",
                                                "replace-product": "商品/背景替换",
                                                "voice-clone": "声音克隆",
                                                ocr: "OCR",
                                            } as Record<string, string>
                                        )[capability.name] || capability.name}{" "}
                                        {capability.available ? "可用" : "待配置"}
                                    </Tag>
                                ))}
                            </Space>
                        </Card>
                    )}
                </aside>
            </div>
            {tool === "subtitle-remove" && (
                <div className="sticky bottom-2 z-10 rounded-lg border p-2 shadow-lg lg:hidden" style={{ background: token.colorBgContainer, borderColor: token.colorBorder }}>
                    <Button type="primary" block disabled={busy || !subtitleReady} icon={<Sparkles size={15} />} onClick={() => void wb.run("subtitle-remove")}>
                        {busy ? "正在处理…" : "去除硬字幕"}
                    </Button>
                    {!subtitleReady && <div className="mt-1 text-center text-xs" style={{ color: token.colorTextSecondary }}>请上传视频并完成标记方式/处理服务配置</div>}
                </div>
            )}
            <Modal
                title="视频处理服务连接"
                open={serviceOpen}
                onCancel={() => setServiceOpen(false)}
                footer={
                    <Button loading={checking} onClick={() => void checkService()}>
                        检查连接
                    </Button>
                }
            >
                <div className="space-y-3">
                    <p>平台增强处理服务由服务器统一提供，并由当前登录账号鉴权。连接地址和访问凭证由平台管理员维护。</p>
                    <Input disabled={busy} value={wb.worker.url} placeholder="处理服务地址" onChange={(e) => useVideoWorkbenchStore.getState().setWorker({ url: e.target.value })} />
                    <Input.Password disabled={busy} value={wb.worker.token} placeholder="服务访问令牌（配置后填写）" onChange={(e) => useVideoWorkbenchStore.getState().setWorker({ token: e.target.value })} />
                    {serviceError && <Alert type="error" title={serviceError} />}
                    {capabilities?.map((c) => (
                        <div key={c.name}>
                            <Tag color={c.available ? "success" : "default"}>{c.name}</Tag>
                            {c.available ? "可用" : publicServiceText(c.reason || "不可用")}
                        </div>
                    ))}
                    <p className="text-xs" style={{ color: token.colorTextSecondary }}>
                        草稿和素材保存在当前浏览器。站内服务的内部令牌仅保留在服务器；手动直连其他处理服务时，其令牌保存在当前浏览器。
                    </p>
                </div>
            </Modal>
            <Modal title="视频生成参数" open={modelSettingsOpen} onCancel={() => setModelSettingsOpen(false)} footer={null}>
                <VideoSettingsPanel config={config} onConfigChange={updateConfig} theme={canvasThemes[themeMode]} className="space-y-4" />
            </Modal>
            <Modal title="任务记录与阶段结果" open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={820}>
                <div className="space-y-3">
                    {wb.records.length ? (
                        wb.records.map((r) => (
                            <Card
                                key={r.id}
                                size="small"
                                title={stageLabels[r.stage] || r.stage}
                                extra={<Tag color={r.status === "completed" ? "success" : r.status === "failed" ? "error" : "processing"}>{{ running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待暂停" }[r.status]}</Tag>}
                            >
                                <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                    {new Date(r.createdAt).toLocaleString()} {r.step}
                                </div>
                                {r.replicateTask && <div className="mt-1 select-text text-xs">平台任务编号：{r.replicateTask.id}</div>}
                                {r.subtitleRemoveInput && (
                                    <div className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>
                                        标记方式：{r.subtitleRemoveInput.subtitleMode === "auto" ? "自动识别" : "手动框选"}；区域：{r.subtitleRemoveInput.regions.length || "未指定（由服务识别）"}；服务：{r.subtitleRemoveInput.route === "replicate" ? "平台智能修复" : "增强处理服务"}
                                    </div>
                                )}
                                {r.error && <Alert className="mt-2" type="warning" title={r.error} />}
                                {r.text && <Input.TextArea className="mt-2" rows={3} readOnly value={r.text} />}
                                <Space wrap className="mt-3">
                                    {administrator && r.replicateTask && r.status === "interrupted" && (
                                        <Button disabled={busy} onClick={() => reconcile(r.replicateTask!.id)}>
                                            核对平台任务
                                        </Button>
                                    )}
                                    {(r.workerJob || r.modelTask || r.replicateTask) && r.status !== "completed" && (
                                        <Button disabled={busy} onClick={() => void wb.resume(r)}>
                                            恢复查询
                                        </Button>
                                    )}
                                    {r.status === "failed" && (
                                        <Button disabled={busy} onClick={() => void wb.run(r.stage)}>
                                            重试此步骤
                                        </Button>
                                    )}
                                    {r.draftPatch && (
                                        <Button
                                            disabled={busy}
                                            onClick={async () => {
                                                const restored = { ...r.draftPatch };
                                                for (const key of ["video", "speech", "edited", "final", "cover"] as const) {
                                                    if (restored[key]) restored[key] = await restoreWorkbenchFile(restored[key]!);
                                                }
                                                wb.edit(restored, r.stage === "speech" ? "speech" : r.stage === "video" ? "video" : r.stage === "script" || r.stage === "analyze" ? "script" : r.stage === "cover" ? "cover" : "finish");
                                                setHistoryOpen(false);
                                            }}
                                        >
                                            使用此阶段结果
                                        </Button>
                                    )}
                                    {r.result && <Button onClick={() => void wb.download(r.result!)}>下载阶段结果</Button>}
                                </Space>
                            </Card>
                        ))
                    ) : (
                        <Empty description="尚无执行记录" />
                    )}
                </div>
            </Modal>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
        </main>
    );
}
