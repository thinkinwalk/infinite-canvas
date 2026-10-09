import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Alert, App, Button, Card, Collapse, ColorPicker, Empty, Input, InputNumber, Select, Space, Spin, Switch, Tabs, Table, Tag, Upload, theme } from "antd";
import { ArrowLeft, Download, FolderPlus, Grid2X2, RefreshCw, Sparkles, UploadCloud, X } from "lucide-react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { getWorkerCapabilities } from "@/services/api/video-worker";
import { getReplicateModels, publicServiceText, REPLICATE_MODEL_NAMES, transcriptionUnavailable, type ReplicateQuote } from "@/services/api/replicate";
import { imageToDataUrl } from "@/services/image-storage";
import { uploadMediaFile } from "@/services/file-storage";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { MediaRole, VideoRecord, WorkerCapabilities } from "@/types/video-workbench";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";
import { digitalCopyTypes, digitalHumanScriptError, digitalHumanSubtitleError, digitalHumanTaskError, digitalLearningSource, digitalSystemSpeakers } from "./digital-human-request";
import { DigitalHumanPresets } from "./digital-human-presets";

const states = { running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待恢复" } as const;
const modeCopy = {
    photo: { title: "照片说话", detail: "人物照片 + 口播音频", hint: "适合店主、讲师或品牌人物从照片开始制作数字人口播。", model: "digital-human" as const, accept: "image/*", roleTitle: "人物照片" },
    video: { title: "视频对口型", detail: "人物视频 + 新口播音频", hint: "保留已有画面与动作，用新的口播替换原口型。", model: "lipsync" as const, accept: "video/*", roleTitle: "正面人物视频" },
};
const workflowStages = [
    { key: "speech", label: "文案", detail: "可编辑口播" },
    { key: "video", label: "音视频", detail: "口播与人物" },
    { key: "cut", label: "剪气口", detail: "清理停顿" },
    { key: "metadata", label: "标题", detail: "标题与标签" },
    { key: "compose", label: "成片", detail: "字幕与音乐" },
    { key: "finish", label: "封面", detail: "首帧 / 图片" },
] as const;

export default function DigitalHumanWorkspace() {
    const wb = useVideoWorkbench("digital-human");
    const { draft: d, busy } = wb;
    const { token } = theme.useToken();
    const { message, modal } = App.useApp();
    const session = useUserStore((s) => s.token);
    const admin = useUserStore((s) => s.user?.role === "admin");
    const configStore = useConfigStore();
    const config = useEffectiveConfig();
    const location = useLocation();
    const [tab, setTab] = useState("current");
    const [assetRole, setAssetRole] = useState<MediaRole | null>(null);
    const [cloudModels, setCloudModels] = useState<ReplicateQuote[] | null>(null);
    const [catalogError, setCatalogError] = useState("");
    const [capabilities, setCapabilities] = useState<WorkerCapabilities[] | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [viewed, setViewed] = useState<VideoRecord | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const [stageFocus, setStageFocus] = useState("speech");
    const [previewStage, setPreviewStage] = useState("latest");
    const [uploading, setUploading] = useState(false);
    const [quote, setQuote] = useState<ReplicateQuote | null>(null);
    const [quoting, setQuoting] = useState(false);
    const [quoteError, setQuoteError] = useState("");
    const quoteRequest = useRef<AbortController | null>(null);
    const uploadLock = useRef(false);
    const historyRequest = useRef(0);
    const appliedMode = useRef<string | null>(null);
    const mode = modeCopy[d.digitalHumanMode];
    const avatar = d.media.find((m) => m.role === "avatar" && m.kind === (d.digitalHumanMode === "video" ? "video" : "image"));
    const speech = d.speech;
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask));
    const previews = [
        { key: "video", label: "数字人初稿", file: d.video },
        { key: "edited", label: "剪气口版本", file: d.edited },
        { key: "final", label: "最终成片", file: d.final },
    ].filter((item) => item.file);
    const result = viewed?.result || previews.find((item) => item.key === previewStage)?.file || d.final || d.edited || d.video;
    const locked = busy || uploading;
    const muted = { color: token.colorTextSecondary };
    const surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };
    const modelAvailable = cloudModels?.find((m) => m.operation === mode.model);
    const transcriptionBlocked = d.digitalTranscribeRoute === "worker" ? "" : !session ? "请先登录使用云端语音识别" : catalogError || (cloudModels === null ? "正在读取云端语音识别配置…" : transcriptionUnavailable(cloudModels.find((m) => m.operation === "transcribe")));
    const modelBlocked = d.route === "replicate" ? (!session ? "请先登录使用平台智能处理" : modelAvailable && !modelAvailable.available ? publicServiceText(modelAvailable.reason || "平台服务暂不可用") : "") : "";
    const pendingBlocked = pending ? "已有任务可恢复查询，完成前请勿重复制作" : "";
    const blocked = !avatar ? "请在音频与人物步骤选择主播形象" : !speech ? "请先生成或导入口播音频" : pendingBlocked || modelBlocked;
    const autoBlocked = pendingBlocked || (!d.video ? (!avatar ? "请在音频与人物步骤选择主播形象" : !speech && !d.narration.trim() && !d.script.trim() ? digitalHumanScriptError(d) || modelBlocked : modelBlocked) : "");
    const stageReady = {
        speech: Boolean(d.narration.trim() || speech),
        video: Boolean(d.video),
        cut: Boolean(d.edited),
        metadata: Boolean(d.title || d.tags),
        compose: Boolean(d.final),
        finish: Boolean(d.cover),
    } as const;
    const nextStep = !d.video
        ? !speech && !d.narration.trim() && !d.script.trim()
            ? "生成或填写口播文案"
            : !speech
              ? "生成或导入口播音频"
              : !avatar
                ? "选择主播形象"
                : `${mode.title} · 生成视频`
        : d.cutSilence && !d.edited
          ? "执行剪气口"
          : d.addSubtitles && !d.subtitles.length
            ? "识别或添加字幕"
            : !d.final
              ? "合成字幕与配乐"
              : !d.cover
                ? "生成封面"
                : "查看最终成片";
    const scrollToStage = (key: string) => {
        setStageFocus(key);
        window.setTimeout(() => document.getElementById(`dh-stage-${key}`)?.scrollIntoView({ block: "start" }), 0);
    };
    const stageBlocked = (stage: string) => {
        if (pendingBlocked) return pendingBlocked;
        if (stage === "script") return digitalHumanScriptError(d);
        if (stage === "transcribe") return !digitalLearningSource(d) ? "请上传含口播的参考视频" : transcriptionBlocked;
        if (stage === "metadata") return !d.narration.trim() && !d.script.trim() && !d.instructions.trim() ? "请填写口播或主题" : "";
        if (stage === "speech" || stage === "speech-preview") {
            if (stage === "speech-preview" ? !d.digitalPreviewText.trim() : !d.narration.trim() && !d.script.trim()) return stage === "speech-preview" ? "请填写试听文字" : "请先填写口播正文";
            if (d.voiceMode === "clone" && !d.media.some((m) => m.role === "voice")) return "请上传声音样本";
            if (d.voiceMode === "clone" && d.route !== "replicate" && !d.promptTranscript.trim()) return "请填写声音样本原文";
            return d.route === "replicate" && !session ? "请先登录生成配音" : "";
        }
        if (stage === "video") return blocked;
        if (["cut", "subtitles", "compose", "cover"].includes(stage)) {
            if (!(stage === "cover" ? d.final || d.edited || d.video : d.edited || d.video)) return "请先生成或导入视频";
            if (stage === "subtitles") return transcriptionBlocked;
            if (stage === "compose" && digitalHumanSubtitleError(d)) return digitalHumanSubtitleError(d);
            if (stage === "cover" && d.coverMode === "image" && !d.title.trim()) return "请先填写视频标题";
        }
        return "";
    };
    const quoteKey = JSON.stringify([session, d.route, d.digitalHumanMode, d.digitalRevision, avatar?.storageKey, speech?.storageKey, avatar?.url, speech?.url]);
    useEffect(() => {
        quoteRequest.current?.abort();
        setQuote(null);
        setQuoteError("");
        setQuoting(false);
        return () => quoteRequest.current?.abort();
    }, [quoteKey]);
    const viewQuote = async () => {
        quoteRequest.current?.abort();
        const request = new AbortController();
        quoteRequest.current = request;
        setQuoting(true);
        setQuoteError("");
        setQuote(null);
        try {
            const value = await wb.quoteDigitalHuman(request.signal);
            if (!request.signal.aborted) setQuote(value);
        } catch (error) {
            if (!request.signal.aborted) setQuoteError(publicServiceText(error instanceof Error ? error.message : "费用读取失败"));
        } finally {
            if (!request.signal.aborted) setQuoting(false);
        }
    };

    useEffect(() => {
        if (!wb.hydrated) return;
        const request = new AbortController();
        const refresh = () => {
            if (session)
                void getReplicateModels(request.signal)
                    .then((models) => {
                        if (!request.signal.aborted) {
                            setCloudModels(models);
                            setCatalogError("");
                        }
                    })
                    .catch(() => {
                        if (!request.signal.aborted) {
                            setCloudModels(null);
                            setCatalogError("模型目录读取失败，请刷新模型目录后重试；这不代表服务密钥未配置。");
                        }
                    });
            else {
                setCloudModels(null);
                setCatalogError("");
            }
        };
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
            request.abort();
            window.removeEventListener("focus", refresh);
        };
    }, [wb.hydrated, session]);
    useEffect(() => {
        if (!wb.hydrated || appliedMode.current === location.search) return;
        appliedMode.current = location.search;
        const requested = new URLSearchParams(location.search).get("mode");
        if ((requested === "photo" || requested === "video") && requested !== d.digitalHumanMode) wb.edit({ digitalHumanMode: requested }, "video");
    }, [wb.hydrated, location.search]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);

    const refreshModels = async () => {
        setRefreshing(true);
        quoteRequest.current?.abort();
        setQuote(null);
        setQuoting(false);
        try {
            await configStore.loadPublicSettings();
            if (session) {
                setCloudModels(await getReplicateModels());
                setCatalogError("");
            }
        } catch {
            setCloudModels(null);
            setCatalogError("模型目录读取失败，请刷新模型目录后重试；这不代表服务密钥未配置。");
            message.error("模型目录刷新失败");
        } finally {
            setRefreshing(false);
        }
    };
    const checkProcessing = async () => {
        try {
            setCapabilities(await getWorkerCapabilities(wb.worker));
        } catch {
            setCapabilities(null);
            message.error("处理服务未连接，请检查高级设置");
        }
    };
    const addFiles = async (files: File[], role: MediaRole, accept: string) => {
        if (locked || uploadLock.current) return;
        uploadLock.current = true;
        setUploading(true);
        try {
            await wb.addFiles(files, role, accept);
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!assetRole || payload.kind === "text") return;
        try {
            const blob = payload.kind === "image" ? await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob() : await (await fetch(payload.url)).blob();
            await addFiles([new File([blob], payload.title, { type: blob.type })], assetRole, assetRole === "avatar" ? "image/*,video/*" : ["learning", "reference"].includes(assetRole) ? "video/*" : "audio/*");
            setAssetRole(null);
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "读取素材失败"));
        }
    };
    const materialField = (role: MediaRole, accept: string, title: string, hint: string) => {
        const files = d.media.filter((m) => m.role === role);
        return (
            <section className="space-y-2" data-material-role={role}>
                <div className="flex items-center justify-between gap-2">
                    <strong>{title}</strong>
                    <span className="text-xs" style={muted}>
                        {files.length ? `${files.length} 个` : "未选择"}
                    </span>
                </div>
                {role === "avatar" && files.length > 0 ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: token.colorBorderSecondary }}>
                        <span style={muted}>主播已在上方选择，可在那里预览和更换</span>
                        <Button type="text" size="small" disabled={locked} aria-label="移除当前主播" icon={<X size={13} />} onClick={() => files.forEach((m) => wb.removeMedia(m.id))} />
                    </div>
                ) : (
                    files.map((m) => (
                        <div key={m.id} className="rounded-lg border p-2" style={{ borderColor: token.colorBorderSecondary }}>
                            {m.kind === "image" ? (
                                <img src={m.url} alt={m.name} className="max-h-48 w-full rounded object-contain" />
                            ) : m.kind === "video" ? (
                                <video src={m.url} controls preload="metadata" className="max-h-48 w-full rounded" />
                            ) : (
                                <audio src={m.url} controls className="w-full" />
                            )}
                            <div className="mt-1 flex items-center justify-between gap-2">
                                <span className="truncate text-xs" title={m.name}>
                                    {m.name}
                                </span>
                                <Button type="text" size="small" disabled={locked} aria-label={`移除${m.name}`} icon={<X size={13} />} onClick={() => wb.removeMedia(m.id)} />
                            </div>
                            <div className="text-xs" style={muted}>
                                {m.width && m.height ? `${m.width}×${m.height}` : ""}
                                {m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(2)} 秒` : ""}
                            </div>
                        </div>
                    ))
                )}
                <Upload.Dragger
                    height={88}
                    accept={accept}
                    showUploadList={false}
                    disabled={locked}
                    beforeUpload={(file) => {
                        void addFiles([file], role, accept);
                        return Upload.LIST_IGNORE;
                    }}
                    style={{ background: token.colorFillQuaternary }}
                >
                    <div className="flex items-center justify-center gap-2 text-sm">
                        <UploadCloud size={17} />
                        <span>点击或拖拽上传</span>
                    </div>
                    <div className="mt-1 text-xs" style={muted}>
                        {hint}
                    </div>
                </Upload.Dragger>
                {!(["voice", "music"] as MediaRole[]).includes(role) && (
                    <Button size="small" type="text" disabled={locked} onClick={() => setAssetRole(role)}>
                        从我的素材选择
                    </Button>
                )}
            </section>
        );
    };
    const runStage = (stage: string) => {
        if (stage === "transcribe" && d.transcript.trim()) {
            modal.confirm({ title: "重新识别参考原文？", content: "识别成功后将替换当前参考原文，保留口播正文与视频结果。", okText: "重新识别", cancelText: "保留原文", onOk: () => wb.run(stage) });
            return;
        }
        if ((stage === "script" && d.narration.trim()) || (stage === "metadata" && (d.title.trim() || d.tags.trim()))) {
            modal.confirm({ title: stage === "script" ? "替换当前口播正文？" : "替换当前标题与标签？", content: "AI 生成成功后将替换当前内容，请先保留需要的手写文字。", okText: "生成并替换", cancelText: "保留当前", onOk: () => wb.run(stage) });
        } else void wb.run(stage);
    };
    const action = (stage: string, label: string, primary = false) => (
        <div className="space-y-1">
            <Button type={primary ? "primary" : "default"} size="small" disabled={locked || Boolean(stageBlocked(stage))} icon={<Sparkles size={14} />} onClick={() => runStage(stage)}>
                {label}
            </Button>
            {stageBlocked(stage) && (
                <div className="text-xs" style={muted}>
                    {stageBlocked(stage)}
                </div>
            )}
        </div>
    );
    const importSpeech = async (file: File) => {
        if (locked || uploadLock.current) return;
        uploadLock.current = true;
        setUploading(true);
        try {
            if (!file.type.startsWith("audio/")) throw new Error("请选择音频文件");
            wb.edit({ speech: await uploadMediaFile(file, "video-speech") }, "video");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "音频导入失败，已保留原音频"));
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const restoreInput = (record: VideoRecord) => {
        if (!record.digitalHumanInput) return;
        modal.confirm({
            title: "恢复这次数字人输入",
            content: "将替换当前草稿，恢复人物素材、口播设置、文案及当时已有的阶段文件，不会创建新的收费任务。",
            okText: "恢复输入",
            cancelText: "取消",
            onOk: async () => {
                const { channelMode: _channel, baseUrl: _url, audioModel: _audio, textModel: _text, ...input } = record.digitalHumanInput!;
                const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                const files = await Promise.all((["speech", "voicePreview", "video", "edited", "final"] as const).map(async (key) => [key, input[key] ? await restoreWorkbenchFile(input[key]!) : null]));
                wb.patch({ ...input, ...Object.fromEntries(files), media, cover: null, activeRecord: record.id, digitalRevision: (d.digitalRevision || 0) + 1 });
                historyRequest.current++;
                setViewed(null);
                setTab("current");
            },
        });
    };
    const showRecord = async (record: VideoRecord) => {
        const request = ++historyRequest.current;
        try {
            const file = record.result ? await restoreWorkbenchFile(record.result) : undefined;
            if (request === historyRequest.current) {
                setViewed({ ...record, result: file });
                setTab("current");
            }
        } catch {
            if (request === historyRequest.current) message.error("作品读取失败");
        }
    };
    if (!wb.hydrated)
        return (
            <div className="p-12 text-center">
                <Spin tip="加载数字人工作台" />
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
                    <h1 className="text-lg font-semibold">数字人工作台</h1>
                </div>
                <span className="hidden text-sm sm:block" style={muted}>
                    文案 → 口播 → 数字人视频 → 后期成片
                </span>
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="digital-human-scroll">
                <div className="mx-auto grid min-h-full min-w-0 max-w-[1880px] gap-3 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_340px]">
                    <section className="flex min-h-0 min-w-0 max-w-full flex-col rounded-xl border" style={surface} aria-label="数字人输入与设置">
                        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b p-2" style={{ ...surface, borderColor: token.colorBorderSecondary }} aria-label="数字人制作阶段" data-testid="digital-human-stage-nav">
                            {workflowStages.map((stage, index) => (
                                <button
                                    key={stage.key}
                                    type="button"
                                    onClick={() => scrollToStage(stage.key)}
                                    className="min-w-[72px] flex-1 shrink-0 rounded-md px-2 py-1.5 text-left text-xs transition"
                                    style={{ background: stageFocus === stage.key ? token.colorPrimaryBg : "transparent", color: stageFocus === stage.key ? token.colorPrimary : token.colorTextSecondary }}
                                    aria-current={stageFocus === stage.key ? "step" : undefined}
                                >
                                    <span className="flex items-center gap-1 font-medium">
                                        <span>{String(index + 1).padStart(2, "0")}</span>
                                        {stageReady[stage.key] ? <span aria-label="已准备">✓</span> : <span aria-label="待准备">·</span>}
                                    </span>
                                    <span className="block truncate">{stage.label}</span>
                                </button>
                            ))}
                        </nav>
                        <div className="grid min-h-0 min-w-0 flex-1 lg:overflow-y-auto xl:grid-cols-2 xl:overflow-hidden">
                            <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-x-hidden p-3 xl:overflow-y-auto" data-testid="digital-human-input-scroll">
                                <Card className="shrink-0 scroll-mt-3" id="dh-stage-speech" size="small" title="01 · 文案">
                                    <Select className="mb-3 w-full" aria-label="文案来源" disabled={locked} value={d.digitalCopySource} onChange={(digitalCopySource) => wb.edit({ digitalCopySource }, "brief")} options={[{ value: "brief", label: "提供资料 · AI 写稿" }, { value: "reference", label: "视频学习 · 识别并改写" }, { value: "manual", label: "直接填写口播正文" }]} />
                                    {d.digitalCopySource === "reference" && (
                                        <div className="mb-3 space-y-3">
                                            {materialField("learning", "video/*", "参考视频", "上传含清晰人声的视频，学习文案内容")}
                                            <Select
                                                className="w-full"
                                                aria-label="语音识别方式"
                                                disabled={locked}
                                                value={d.digitalTranscribeRoute || "replicate"}
                                                options={[{ value: "replicate", label: "云端识别 · 推荐" }, { value: "worker", label: "本地处理服务识别" }]}
                                                onChange={(digitalTranscribeRoute) => wb.edit({ digitalTranscribeRoute })}
                                            />
                                            <p className="text-xs" style={muted}>{d.digitalTranscribeRoute === "worker" ? "在已连接的处理服务运行语音模型，需要足够内存。" : "提取声音后发送到云端语音服务，不在本机加载识别模型；执行前确认算力点费用。此选择也用于成片字幕识别。"}</p>
                                            {action("transcribe", "识别参考原文")}
                                            <Input.TextArea aria-label="参考视频原文" disabled={locked} rows={4} value={d.transcript} placeholder="识别后先校正错字，也可直接粘贴参考原文" onChange={(e) => wb.edit({ transcript: e.target.value, digitalTranscriptSource: digitalLearningSource(d) }, "brief")} />
                                            <p className="text-xs" style={muted}>通过视频中的人声识别文案；无声视频可手动粘贴参考原文，当前不识别画面字幕。校正后填写本次真实资料改写，视频学习不会克隆参考人物或声音。</p>
                                        </div>
                                    )}
                                    {d.digitalCopySource !== "manual" && (
                                        <div className="space-y-3">
                                            <Select className="w-full" aria-label="文案类型" disabled={locked} value={d.digitalBrief.type} options={digitalCopyTypes.map(({ value, label }) => ({ value, label }))} onChange={(type) => wb.edit({ digitalBrief: { ...d.digitalBrief, type } }, "brief")} />
                                            <div className="grid gap-2 sm:grid-cols-2">
                                                {([
                                                    ["industry", "行业", "例如：家居、餐饮、教育"], ["audience", "目标受众", "这条视频说给谁听"],
                                                    ["persona", "主播人设", "例如：经营十年的家具店主"], ["product", "产品 / 业务", "本次要介绍的产品或服务"],
                                                    ["price", "实际价格 / 优惠", "填写真实价格，没有可留空"], ["duration", "目标时长（秒）", "例如：60；实际以配音为准"],
                                                    ["style", "表达风格", "例如：亲切、简洁、专业"], ["callToAction", "结尾引导", "例如：评论提问、咨询详情"],
                                                ] as const).map(([key, label, placeholder]) => (
                                                    <label className="space-y-1 text-xs" key={key}>
                                                        <span>{label}</span>
                                                        <Input aria-label={label} disabled={locked} value={d.digitalBrief[key]} placeholder={placeholder} onChange={(e) => wb.edit({ digitalBrief: { ...d.digitalBrief, [key]: e.target.value } }, "brief")} />
                                                    </label>
                                                ))}
                                            </div>
                                            <Input.TextArea aria-label="真实产品卖点" disabled={locked} rows={2} value={d.digitalBrief.sellingPoints} placeholder="真实卖点、可核实的产品特点或本次知识要点" onChange={(e) => wb.edit({ digitalBrief: { ...d.digitalBrief, sellingPoints: e.target.value } }, "brief")} />
                                            <Input.TextArea aria-label="口播主题与其他要求" disabled={locked} rows={2} value={d.instructions} placeholder="主题、补充资料和其他视频要求" onChange={(e) => wb.edit({ instructions: e.target.value }, "brief")} />
                                            <p className="text-xs" style={muted}>修改资料会保留已有正文和成片；确认重新写稿后才更新口播。故事式口播由一个主播讲述。</p>
                                        </div>
                                    )}
                                    <div className="mt-3 flex items-center justify-between gap-2">
                                        <strong>口播正文</strong>
                                        {d.digitalCopySource !== "manual" && action("script", d.digitalCopySource === "reference" ? "按本次资料改写" : "AI 撰写口播")}
                                    </div>
                                    <Input.TextArea disabled={locked} rows={4} value={d.narration} placeholder="只填写需要朗读的正文" onChange={(e) => wb.edit({ narration: e.target.value, script: e.target.value }, "script")} />
                                    <div className="mt-2 text-xs" style={muted}>
                                        口播生成后会显示音频时长、播放器和可重新生成入口。
                                    </div>
                                </Card>
                                <Card className="shrink-0 scroll-mt-3" id="dh-stage-video" size="small" title="02 · 音频与人物">
                                    <div className="grid min-w-0 grid-cols-1 gap-3">
                                        <DigitalHumanPresets draft={d} locked={locked || Boolean(pending)} onApply={(value) => wb.edit(value, "speech")} />
                                        <div className="space-y-3">
                                            <div className="flex flex-wrap gap-2">
                                                <Select
                                                    disabled={locked}
                                                    value={d.voiceMode}
                                                    onChange={(voiceMode) => wb.edit({ voiceMode }, "speech")}
                                                    options={[
                                                        { value: "api", label: "系统音色" },
                                                        { value: "clone", label: "声音样本克隆" },
                                                    ]}
                                                />
                                                <Select
                                                    aria-label="朗读语言"
                                                    disabled={locked}
                                                    value={d.language === "中文" ? "Chinese" : d.language}
                                                    onChange={(language) => wb.edit({ language }, "speech")}
                                                    options={["Chinese", "English", "Japanese", "Korean", "French", "German", "auto"].map((value) => ({ value, label: value === "Chinese" ? "中文" : value === "auto" ? "自动识别" : value }))}
                                                />
                                                {d.voiceMode === "api" && d.route === "replicate" && (
                                                    <Select
                                                        aria-label="配音音色"
                                                        disabled={locked}
                                                        value={d.replicateSpeaker}
                                                        onChange={(replicateSpeaker) => wb.edit({ replicateSpeaker }, "speech")}
                                                        options={digitalSystemSpeakers.map((value) => ({ value, label: value }))}
                                                    />
                                                )}
                                                {d.voiceMode === "api" && d.route !== "replicate" && (
                                                    <Input aria-label="自定义配音音色" className="max-w-48" disabled={locked} value={d.voice} placeholder="模型音色，例如 alloy" onChange={(e) => wb.edit({ voice: e.target.value }, "speech")} />
                                                )}
                                            </div>
                                            {d.voiceMode === "clone" && (
                                                <>
                                                    {materialField("voice", "audio/*", "声音样本", "上传 3–15 秒清晰人声，并填写样本文字")}
                                                    <Input.TextArea disabled={locked} rows={2} value={d.promptTranscript} placeholder="声音样本中实际说出的文字" onChange={(e) => wb.edit({ promptTranscript: e.target.value }, "speech")} />
                                                </>
                                            )}
                                            <Collapse items={[{ key: "voice-preview", label: "先试听音色", children: (
                                                <div className="space-y-2">
                                                    <Input.TextArea aria-label="音色试听文字" disabled={locked} rows={2} value={d.digitalPreviewText} onChange={(e) => wb.edit({ digitalPreviewText: e.target.value }, "preview")} />
                                                    {action("speech-preview", "生成试听")}
                                                    <p className="text-xs" style={muted}>试听独立计费；平台配音提交前确认费用，其他方式按已配置服务计费。试听保留正式口播与成片。</p>
                                                    {d.voicePreview && <audio aria-label="音色试听" controls src={d.voicePreview.url} className="w-full" />}
                                                </div>
                                            ) }]} />
                                            <Space wrap>
                                                {action("speech", "生成口播")}
                                                {speech && (
                                                    <Button size="small" disabled={locked || Boolean(stageBlocked("speech"))} onClick={() => void wb.run("speech")}>
                                                        重新生成
                                                    </Button>
                                                )}
                                                <Button size="small" disabled={locked} onClick={(e) => e.currentTarget.querySelector<HTMLInputElement>("input")?.click()}>
                                                    导入口播
                                                    <input
                                                        type="file"
                                                        accept="audio/*"
                                                        className="hidden"
                                                        onClick={(e) => e.stopPropagation()}
                                                        onChange={async (e) => {
                                                            const file = e.target.files?.[0];
                                                            e.target.value = "";
                                                            if (file) {
                                                                await importSpeech(file);
                                                            }
                                                        }}
                                                    />
                                                </Button>
                                            </Space>
                                            {speech && (
                                                <div className="rounded-lg border p-2" style={{ borderColor: token.colorBorderSecondary }}>
                                                    <audio controls src={speech.url} className="w-full" />
                                                    <div className="mt-1 text-xs" style={muted}>
                                                        口播音频 {speech.durationMs ? `${(speech.durationMs / 1000).toFixed(2)} 秒` : "已导入"}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-3">
                                            <div className="space-y-2">
                                                <Select aria-label="人物生成方式" className="w-full" disabled={locked} value={d.digitalHumanMode} onChange={(digitalHumanMode) => wb.edit({ digitalHumanMode }, "video")} options={[{ value: "photo", label: "使用人物照片 · 照片说话" }, { value: "video", label: "使用人物视频 · 视频对口型" }]} />
                                                <p className="text-xs" style={muted}>上传照片或人物视频后自动选择方式；切换方式保留口播音频，清理不匹配人物和视频结果。</p>
                                            </div>
                                            {materialField("avatar", "image/*,video/*", "主播形象", "上传人物照片或正面人物视频，自动选择对应生成方式")}
                                            {d.digitalHumanMode === "photo" && d.route === "replicate" && <Input.TextArea aria-label="人物动作要求" disabled={locked} rows={2} value={d.digitalMotion} placeholder="人物动作要求（可选）：自然看向镜头、轻微表情；与写稿资料分开" onChange={(e) => wb.edit({ digitalMotion: e.target.value }, "video")} />}
                                            {avatar && (
                                                <Button type="primary" block disabled={locked || Boolean(blocked)} onClick={() => void wb.run("video")}>
                                                    {mode.title} · 生成视频
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                    <Collapse className="mt-4" items={[{ key: "import", label: "已有口播视频：跳过数字人生成继续后期", children: materialField("reference", "video/*", "已有口播视频", "导入后可直接剪气口、识别字幕和加配乐") }]} />
                                </Card>
                                <Collapse
                                    items={[
                                        {
                                            key: "advanced",
                                            label: "高级设置 · 处理方式与模型",
                                            children: (
                                                <div className="space-y-3">
                                                    <Select
                                                        className="w-full"
                                                        disabled={locked}
                                                        value={d.route}
                                                        onChange={(route) => wb.edit({ route }, "speech")}
                                                        options={[
                                                            { value: "replicate", label: "平台智能处理（推荐）" },
                                                            { value: "model", label: "已配置模型与处理服务" },
                                                            { value: "worker", label: "增强处理服务" },
                                                        ]}
                                                    />
                                                    {d.route === "replicate" && (
                                                        <div className="space-y-2 text-xs" style={muted}>
                                                            {(["speech", mode.model] as const).map((operation) => {
                                                                const item = cloudModels?.find((m) => m.operation === operation);
                                                                return (
                                                                    <div key={operation}>
                                                                        <strong>{REPLICATE_MODEL_NAMES[operation]}</strong>：{item?.available ? "可使用" : publicServiceText(item?.reason || (session ? "暂不可用" : "登录后使用平台服务"))}
                                                                        ；生成前显示本次扣点明细。
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                    {d.route !== "replicate" && (
                                                        <ModelPicker
                                                            config={config}
                                                            capability="audio"
                                                            value={config.audioModel}
                                                            fullWidth
                                                            onChange={(value) => configStore.updateConfig("audioModel", value)}
                                                            onMissingConfig={() => configStore.openConfigDialog(true)}
                                                        />
                                                    )}
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="text-xs" style={muted}>
                                                            处理服务：{capabilities ? `${capabilities.filter((c) => c.available).length} 项能力可用` : "未读取"}
                                                        </span>
                                                        <Button size="small" disabled={locked} onClick={() => void checkProcessing()}>
                                                            检查处理服务
                                                        </Button>
                                                        <Button size="small" icon={<RefreshCw size={13} />} loading={refreshing} onClick={() => void refreshModels()}>
                                                            刷新模型
                                                        </Button>
                                                    </div>
                                                </div>
                                            ),
                                        },
                                    ]}
                                />
                            </div>
                            <div className="flex min-h-0 min-w-0 flex-col gap-3 border-t p-3 xl:overflow-y-auto xl:border-l xl:border-t-0" style={{ borderColor: token.colorBorderSecondary }} data-testid="digital-human-post-scroll">
                                <Card className="shrink-0 scroll-mt-3" id="dh-stage-cut" size="small" title="03 · 剪气口">
                                    <Space wrap>
                                        <Switch aria-label="自动剪气口" disabled={locked} checked={d.cutSilence} onChange={(cutSilence) => wb.edit({ cutSilence, edited: null, subtitles: [] }, "finish")} />
                                        <span className="text-sm">自动去除语音段落间空白</span>
                                        {action("cut", "执行剪气口")}
                                    </Space>
                                    <p className="mt-2 text-xs" style={muted}>
                                        需要已生成视频；完成后请重新识别字幕以对齐新时间轴。
                                    </p>
                                </Card>
                                <Card className="shrink-0 scroll-mt-3" id="dh-stage-metadata" size="small" title="04 · 标题与标签">
                                    <div className="grid min-w-0 grid-cols-1 gap-3">
                                        <Input disabled={locked} value={d.title} placeholder="视频标题" onChange={(e) => wb.edit({ title: e.target.value }, "cover")} />
                                        <Input disabled={locked} value={d.tags} placeholder="话题标签，用逗号分隔" onChange={(e) => wb.edit({ tags: e.target.value })} />
                                        {action("metadata", "生成标题与标签")}
                                    </div>
                                </Card>
                                <Card className="shrink-0 scroll-mt-3" id="dh-stage-compose" size="small" title="05 · 字幕与配乐">
                                    <Select className="mb-2 w-full" aria-label="字幕识别方式" disabled={locked} value={d.digitalTranscribeRoute || "replicate"} options={[{ value: "replicate", label: "云端识别 · 推荐" }, { value: "worker", label: "本地处理服务识别" }]} onChange={(digitalTranscribeRoute) => wb.edit({ digitalTranscribeRoute })} />
                                    <p className="mb-3 text-xs" style={muted}>{d.digitalTranscribeRoute === "worker" ? "字幕识别在已连接的处理服务运行，需要足够内存。" : "字幕识别会将音频发送到云端，执行前确认费用；与视频学习共用识别方式。"}</p>
                                    <div className="grid min-w-0 grid-cols-1 gap-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Switch aria-label="烧录字幕" disabled={locked} checked={d.addSubtitles} onChange={(addSubtitles) => wb.edit({ addSubtitles }, "finish")} />
                                            <span className="text-sm">烧录字幕</span>
                                            {action("subtitles", "识别字幕")}
                                            <Button
                                                size="small"
                                                disabled={locked || !(d.video || d.edited)}
                                                onClick={() => wb.edit({ subtitles: [...d.subtitles, { start: d.subtitles.at(-1)?.end || 0, end: (d.subtitles.at(-1)?.end || 0) + 1, text: "" }] }, "finish")}
                                            >
                                                添加字幕行
                                            </Button>
                                        </div>
                                        <Table
                                            className="min-w-0 max-w-full"
                                            size="small"
                                            pagination={false}
                                            scroll={{ x: 340 }}
                                            rowKey={(_, index) => String(index)}
                                            dataSource={d.subtitles}
                                            columns={[
                                                {
                                                    title: "开始",
                                                    width: 80,
                                                    render: (_, row, index) => (
                                                        <InputNumber
                                                            aria-label={`第${index + 1}行字幕开始时间`}
                                                            style={{ width: "100%" }}
                                                            disabled={locked}
                                                            min={0}
                                                            step={0.1}
                                                            value={row.start}
                                                            onChange={(start) => wb.edit({ subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, start: start || 0 } : s)) }, "finish")}
                                                        />
                                                    ),
                                                },
                                                {
                                                    title: "结束",
                                                    width: 80,
                                                    render: (_, row, index) => (
                                                        <InputNumber
                                                            aria-label={`第${index + 1}行字幕结束时间`}
                                                            style={{ width: "100%" }}
                                                            disabled={locked}
                                                            min={0}
                                                            step={0.1}
                                                            value={row.end}
                                                            onChange={(end) => wb.edit({ subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, end: end || 0 } : s)) }, "finish")}
                                                        />
                                                    ),
                                                },
                                                {
                                                    title: "文字",
                                                    render: (_, row, index) => (
                                                        <Input
                                                            aria-label={`第${index + 1}行字幕文字`}
                                                            disabled={locked}
                                                            value={row.text}
                                                            onChange={(e) => wb.edit({ subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, text: e.target.value } : s)) }, "finish")}
                                                        />
                                                    ),
                                                },
                                                {
                                                    title: "",
                                                    width: 40,
                                                    render: (_, _row, index) => (
                                                        <Button
                                                            type="text"
                                                            size="small"
                                                            aria-label={`删除第${index + 1}行字幕`}
                                                            disabled={locked}
                                                            icon={<X size={13} />}
                                                            onClick={() => wb.edit({ subtitles: d.subtitles.filter((_, i) => i !== index) }, "finish")}
                                                        />
                                                    ),
                                                },
                                            ]}
                                            locale={{ emptyText: "暂无字幕，先识别或手动添加" }}
                                        />
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm">字号</span>
                                            <InputNumber min={1} disabled={locked} value={d.subtitleSize} onChange={(subtitleSize) => wb.edit({ subtitleSize: subtitleSize || 1 }, "finish")} />
                                            <span className="text-sm">配乐音量</span>
                                            <InputNumber min={0} max={1} step={0.1} disabled={locked} value={d.musicVolume} onChange={(musicVolume) => wb.edit({ musicVolume: musicVolume ?? 0 }, "finish")} />
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span>字色</span>
                                            <ColorPicker aria-label="字幕颜色" disabled={locked} value={d.subtitleColor} onChangeComplete={(color) => wb.edit({ subtitleColor: color.toHexString() }, "finish")} />
                                            <span>高亮色</span>
                                            <ColorPicker aria-label="关键词高亮颜色" disabled={locked} value={d.highlightColor} onChangeComplete={(color) => wb.edit({ highlightColor: color.toHexString() }, "finish")} />
                                        </div>
                                        <Input disabled={locked} value={d.keywords} placeholder="高亮关键词，用逗号分隔" onChange={(e) => wb.edit({ keywords: e.target.value }, "finish")} />
                                        {materialField("music", "audio/*", "背景音乐（可选）", "上传音乐后再合成最终视频")}
                                        {action("compose", "合成字幕与配乐", true)}
                                    </div>
                                </Card>
                                <Card className="shrink-0 scroll-mt-3" id="dh-stage-finish" size="small" title="06 · 封面">
                                    <Space wrap>
                                        <Select
                                            disabled={locked}
                                            value={d.coverMode}
                                            onChange={(coverMode) => wb.edit({ coverMode }, "cover")}
                                            options={[
                                                { value: "frame", label: "视频首帧" },
                                                { value: "image", label: "图片模型封面" },
                                            ]}
                                        />
                                        {action("cover", "生成封面")}
                                    </Space>
                                    <p className="mt-2 text-xs" style={muted}>
                                        可从当前视频抽取首帧；图片模型封面需填写标题。
                                    </p>
                                </Card>
                            </div>
                        </div>
                        <div className="hidden shrink-0 border-t p-3 lg:block" style={{ borderColor: token.colorBorderSecondary }} data-testid="digital-human-desktop-actions">
                            <div className="flex flex-wrap items-center gap-2">
                                <Button type="primary" disabled={locked || Boolean(blocked)} loading={busy} onClick={() => void wb.run("video")}>
                                    {mode.title} · 生成视频
                                </Button>
                                <Button disabled={locked || Boolean(autoBlocked)} onClick={() => void wb.automatic()}>
                                    一键完成后续步骤
                                </Button>
                                {busy && <Button onClick={wb.stop}>停止等待</Button>}
                                <span className="text-xs" style={muted}>
                                    草稿自动保存在本浏览器
                                </span>
                            </div>
                            <div className="mt-2 text-xs" style={muted}>
                                {blocked || "生成前确认真实模型、音频时长和本次费用"}
                            </div>
                        </div>
                    </section>
                    <aside className="flex min-h-0 min-w-0 max-w-full flex-col rounded-xl border p-4" style={surface} aria-label="数字人结果与任务">
                        {wb.storageError && <Alert className="mb-3" type="error" showIcon title="本地保存异常" description={wb.storageError} />}
                        {busy && (
                            <Alert
                                className="mb-3"
                                type="info"
                                showIcon
                                title={`${stageLabels[active?.stage || ""] || "正在处理"}：${active?.step || "等待请求"}`}
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
                                type="warning"
                                showIcon
                                title="已有任务可恢复查询"
                                description={
                                    <Button size="small" onClick={() => void wb.resume(pending)}>
                                        恢复任务结果
                                    </Button>
                                }
                            />
                        )}
                        {!busy && active?.error && (
                            <Alert
                                key={active.id}
                                className="mb-3"
                                type={active.status === "interrupted" ? "warning" : "error"}
                                showIcon
                                title={`${stageLabels[active.stage] || "任务"}未完成`}
                                description={digitalHumanTaskError(active.error)}
                                closable={active.status === "failed" ? { closeIcon: <X size={14} />, onClose: () => wb.patch({ activeRecord: undefined }) } : false}
                            />
                        )}
                        <div className="mb-3 space-y-2 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }} data-testid="digital-human-quote">
                            <div className="flex items-center justify-between gap-2">
                                <strong className="text-sm">生成与费用</strong>
                                <Button size="small" type="text" aria-label="刷新模型目录" icon={<RefreshCw size={14} />} loading={refreshing} onClick={() => void refreshModels()} />
                            </div>
                            <div className="text-xs" style={muted}>
                                {d.route === "replicate" ? REPLICATE_MODEL_NAMES[mode.model] : "已配置处理服务"} · {speech?.durationMs ? `${(speech.durationMs / 1000).toFixed(2)} 秒口播` : "等待口播音频"}
                            </div>
                            {modelBlocked && (
                                <div className="text-xs" style={{ color: token.colorWarning }}>
                                    {modelBlocked}
                                </div>
                            )}
                            <Button size="small" block disabled={locked || d.route !== "replicate" || Boolean(blocked)} loading={quoting} onClick={() => void viewQuote()}>
                                查看本次费用
                            </Button>
                            {quoting && (
                                <p className="text-xs" style={muted}>
                                    正在保存当前参考素材并核算费用，不创建生成任务。
                                </p>
                            )}
                            {quote && (
                                <div className="space-y-1 text-xs">
                                    <strong style={{ color: token.colorPrimary }}>{quote.credits.toLocaleString()} 算力点</strong>
                                    <p>{publicServiceText(quote.calculation || quote.billingDescription || "")}</p>
                                    {quote.submissionBlocked && <p style={{ color: token.colorWarning }}>{publicServiceText(quote.submissionBlocked)}</p>}
                                    <p style={muted}>正式提交时再次报价并确认。</p>
                                </div>
                            )}
                            {quoteError && (
                                <p className="text-xs" style={{ color: token.colorError }}>
                                    {quoteError}
                                </p>
                            )}
                            <p className="text-xs" style={muted}>
                                {d.route !== "replicate" ? "处理服务费用以对应渠道为准。" : blocked || "根据本次输入核算，确认费用后才生成。"}
                            </p>
                        </div>
                        <Tabs
                            activeKey={tab}
                            onChange={setTab}
                            items={[
                                { key: "current", label: "当前作品" },
                                { key: "history", label: "任务记录" },
                                { key: "help", label: "使用说明" },
                            ]}
                        />
                        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="digital-human-result-scroll">
                            {tab === "current" && !viewed && (
                                <div className="mb-3 space-y-3 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary, background: token.colorFillQuaternary }} data-testid="digital-human-progress-summary">
                                    <div className="flex items-center justify-between gap-2">
                                        <div>
                                            <div className="text-xs" style={muted}>
                                                当前制作方式
                                            </div>
                                            <strong>{mode.title}</strong>
                                        </div>
                                        <Tag color={busy ? "processing" : result ? "success" : "default"}>{busy ? "处理中" : result ? "已有结果" : "未开始"}</Tag>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2">
                                        {workflowStages.map((stage) => (
                                            <button
                                                key={stage.key}
                                                type="button"
                                                className="rounded-md border px-2 py-2 text-left text-xs"
                                                style={{ borderColor: stageReady[stage.key] ? token.colorSuccess : token.colorBorderSecondary }}
                                                onClick={() => scrollToStage(stage.key)}
                                            >
                                                <div className="flex items-center justify-between gap-1">
                                                    <span>{stage.label}</span>
                                                    <span style={{ color: stageReady[stage.key] ? token.colorSuccess : token.colorTextSecondary }}>{stageReady[stage.key] ? "✓" : "—"}</span>
                                                </div>
                                                <div className="mt-1 truncate" style={muted}>
                                                    {stage.detail}
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                    <div className="flex items-center justify-between gap-2 text-xs">
                                        <span style={muted}>下一步</span>
                                        <strong className="truncate">{nextStep}</strong>
                                    </div>
                                </div>
                            )}
                            {tab === "current" && (
                                <div className="flex min-h-[200px] flex-col gap-3">
                                    {viewed && (
                                        <div className="flex items-center justify-between gap-2 text-sm">
                                            <span>查看历史 · {stageLabels[viewed.stage] || viewed.stage}</span>
                                            <Button
                                                size="small"
                                                onClick={() => {
                                                    historyRequest.current++;
                                                    setViewed(null);
                                                }}
                                            >
                                                返回当前
                                            </Button>
                                        </div>
                                    )}
                                    {!viewed && previews.length > 0 && (
                                        <Select
                                            aria-label="预览结果版本"
                                            value={previews.some((p) => p.key === previewStage) ? previewStage : previews.at(-1)!.key}
                                            options={previews.map(({ key, label }) => ({ value: key, label }))}
                                            onChange={setPreviewStage}
                                        />
                                    )}
                                    {result ? (
                                        <>
                                            <div className="flex min-h-[200px] items-center justify-center rounded-lg" style={{ background: token.colorFillQuaternary }}>
                                                {result.mimeType.startsWith("image/") ? (
                                                    <img src={result.url} alt="历史封面" className="max-h-[45vh] w-full object-contain" />
                                                ) : result.mimeType.startsWith("audio/") ? (
                                                    <audio controls src={result.url} className="w-full" />
                                                ) : (
                                                    <video controls preload="metadata" src={result.url} className="max-h-[45vh] w-full rounded-lg object-contain" onError={() => setPreviewError(true)} />
                                                )}
                                            </div>
                                            {previewError && <Alert type="warning" title="当前浏览器无法播放此编码，仍可下载原文件" />}
                                            <Space wrap>
                                                <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                                    下载{result.mimeType.startsWith("image/") ? "封面" : result.mimeType.startsWith("audio/") ? "音频" : "视频"}
                                                </Button>
                                                {!viewed && result.mimeType.startsWith("video/") && (
                                                    <>
                                                        <Button icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset(result)}>
                                                            保存素材
                                                        </Button>
                                                        <Button icon={<Grid2X2 size={15} />} onClick={() => void wb.toCanvas(result)}>
                                                            加入画布
                                                        </Button>
                                                    </>
                                                )}
                                            </Space>
                                        </>
                                    ) : (
                                        <div className="flex min-h-[170px] items-center justify-center">
                                            <Empty
                                                description={
                                                    <span className="text-xs">
                                                        {nextStep}，完成后在这里预览
                                                        <br />
                                                        支持切换初稿、剪气口版本与成片
                                                    </span>
                                                }
                                            />
                                        </div>
                                    )}
                                    {!viewed && d.cover && (
                                        <div className="space-y-2">
                                            <div className="flex items-center justify-between">
                                                <strong>封面</strong>
                                                <Button size="small" onClick={() => void wb.download(d.cover!)}>
                                                    下载封面
                                                </Button>
                                            </div>
                                            <img src={d.cover.url} alt="数字人封面" className="max-h-60 w-full rounded object-contain" />
                                        </div>
                                    )}
                                </div>
                            )}
                            {tab === "history" && (
                                <div className="space-y-3">
                                    {!wb.records.length && <Empty description="本浏览器还没有数字人任务" />}
                                    {wb.records.map((r) => (
                                        <article key={r.id} className="space-y-2 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }}>
                                            <div className="flex items-center justify-between gap-2">
                                                <strong>{stageLabels[r.stage] || r.stage}</strong>
                                                <Tag color={r.status === "completed" ? "success" : r.status === "failed" ? "error" : "processing"}>{states[r.status]}</Tag>
                                            </div>
                                            <p className="text-xs" style={muted}>
                                                {new Date(r.createdAt).toLocaleString()} · {r.digitalHumanInput?.digitalHumanMode === "video" ? "视频对口型" : "照片说话"}
                                                {r.digitalHumanInput?.language ? ` · ${r.digitalHumanInput.language}` : ""}
                                            </p>
                                            {r.digitalHumanQuote && (
                                                <p className="text-xs" style={muted}>
                                                    {REPLICATE_MODEL_NAMES[r.digitalHumanQuote.operation]} · {r.digitalHumanQuote.credits.toLocaleString()} 算力点
                                                    {r.digitalHumanQuote.durationSeconds ? ` · ${r.digitalHumanQuote.durationSeconds.toFixed(2)} 秒` : ""}
                                                </p>
                                            )}
                                            {r.step && (
                                                <p className="text-xs" style={muted}>
                                                    {r.step}
                                                </p>
                                            )}
                                            {r.error && (
                                                <p className="text-xs" style={{ color: token.colorError }}>
                                                    {digitalHumanTaskError(r.error)}
                                                </p>
                                            )}
                                            <Space wrap>
                                                {r.result && (
                                                    <Button size="small" onClick={() => void showRecord(r)}>
                                                        查看结果
                                                    </Button>
                                                )}
                                                {r.digitalHumanInput && (
                                                    <Button size="small" disabled={locked || Boolean(pending)} onClick={() => restoreInput(r)}>
                                                        恢复输入
                                                    </Button>
                                                )}
                                                {["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask) && (
                                                    <Button size="small" disabled={locked} onClick={() => void wb.resume(r)}>
                                                        恢复查询
                                                    </Button>
                                                )}
                                                {admin && r.replicateTask && <Tag>可核对平台任务</Tag>}
                                            </Space>
                                        </article>
                                    ))}
                                </div>
                            )}
                            {tab === "help" && (
                                <div className="space-y-3 text-sm">
                                    <h2 className="font-medium">制作说明</h2>
                                    <ol className="list-inside list-decimal space-y-2">
                                        <li>先确认文案，再到音频与人物步骤选择音色和主播形象；上传照片或视频会自动选择对应生成方式。</li>
                                        <li>填写可编辑口播，生成或导入音频后核对时长。</li>
                                        <li>可提供资料写稿、上传参考视频识别后改写，或直接粘贴正文；参考原文需先校正。</li>
                                        <li>保存常用主播和音色后可重复选用；音色试听独立计费，不覆盖正式配音。</li>
                                        <li>生成前会按当前模型、人物输入和音频时长确认费用。</li>
                                        <li>数字人视频完成后可单独剪气口、识别字幕、合成配乐和生成封面。</li>
                                    </ol>
                                    <p style={muted}>云端人物生成与云端语音识别不依赖本机语音模型；视频学习步骤可切换识别方式，字幕识别使用相同选择。剪气口、字幕配乐和首帧封面仍需连接处理服务，当前剪气口仍需其语音模型。草稿和任务记录保存在当前浏览器。</p>
                                </div>
                            )}
                        </div>
                    </aside>
                </div>
            </div>
            <div className="shrink-0 space-y-2 border-t px-4 py-3 lg:hidden" data-testid="digital-human-mobile-actions" style={{ ...surface, borderColor: token.colorBorderSecondary, paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
                <div className="grid grid-cols-2 gap-2">
                    <Button type="primary" disabled={locked || Boolean(blocked)} loading={busy} onClick={() => void wb.run("video")}>
                        {mode.title} · 生成
                    </Button>
                    <Button disabled={locked || Boolean(autoBlocked)} onClick={() => void wb.automatic()}>
                        继续后续步骤
                    </Button>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs" style={muted}>
                        {blocked || "生成前会确认费用"}
                    </span>
                    {busy ? (
                        <Button size="small" onClick={wb.stop}>
                            停止等待
                        </Button>
                    ) : (
                        <Button
                            size="small"
                            onClick={() => {
                                setTab("current");
                                document.querySelector('[aria-label="数字人结果与任务"]')?.scrollIntoView({ block: "start" });
                            }}
                        >
                            查看结果
                        </Button>
                    )}
                </div>
            </div>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
        </main>
    );
}
