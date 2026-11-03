import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Collapse, Empty, Grid, Input, InputNumber, Mentions, Modal, Segmented, Select, Slider, Space, Spin, Switch, Tabs, Tooltip, Upload, theme } from "antd";
import { ArrowDown, ArrowLeft, ArrowUp, Copy, Download, Expand, FolderPlus, Grid2X2, Images, Pencil, Plus, RefreshCw, Save, Settings2, Sparkles, Trash2, Undo2, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { ModelPicker } from "@/components/model-picker";
import { FeatureModelPicker } from "@/components/feature-model-picker";
import { VideoModelOption } from "@/components/video-model-option";
import { videoSizeLabel } from "@/components/video-settings-panel";
import { computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { audioVoiceOptions, cloudSpeechSpeakers } from "@/lib/audio-generation";
import { supportedVideoInputModes, videoInputMode, videoProfile } from "@/lib/video-capabilities";
import { publicServiceText, REPLICATE_VIDEO_MODEL, isReplicateVideoModel } from "@/services/api/replicate";
import type { VideoPrice } from "@/services/api/video";
import { getWorkerCapabilities } from "@/services/api/video-worker";
import { imageToDataUrl } from "@/services/image-storage";
import { configForFeature, managedModelBinding, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { emptyVideoDraft, type StoreShot, type StoreVideoSettings, type VideoDraft, type VideoRecord } from "@/types/video-workbench";
import { useVideoCreationConfig } from "@/hooks/use-video-creation-config";
import { useCopyText } from "@/hooks/use-copy-text";
import { storeAnalysisDisplay } from "./store-analysis";
import { normalizeStoreSettings, storeMaterialLabels, storeVideoConfig, storeVideoError, storeVideoSettings } from "./store-explore-request";
import { renderStoreShots, storeCaptionError, storeKeyframeKey, storePlanKey, storeSpeechKey, storeSubtitleSource, storeSuggestedPurpose } from "./store-explore-plan";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";

type Editor = "storeFacts" | "analysis" | "instructions" | "script";
const names = { storeFacts: "门店真实资料", analysis: "素材观察", instructions: "本次要求", script: "自由脚本" };
const states = { running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待恢复" };

export default function StoreExploreWorkspace() {
    const screens = Grid.useBreakpoint();
    const wb = useVideoWorkbench("store-explore"),
        { draft: d, busy } = wb;
    const config = useVideoCreationConfig(),
        cfg = storeVideoConfig(d, config),
        settings = storeVideoSettings(cfg);
    const { token } = theme.useToken(),
        { message, modal } = App.useApp();
    const copyText = useCopyText();
    const session = useUserStore((s) => s.token),
        presets = useVideoWorkbenchStore((s) => s.storePresets);
    const [tab, setActiveTab] = useState("plan"),
        [editor, setEditor] = useState<Editor | null>(null);
    const mainScroll = useRef<HTMLDivElement>(null),
        tabScroll = useRef<Record<string, number>>({});
    const setTab = (next: string) => {
        if (next === tab) return;
        tabScroll.current[tab] = mainScroll.current?.scrollTop || 0;
        setActiveTab(next);
    };
    useLayoutEffect(() => {
        const restore = () => {
            if (mainScroll.current) mainScroll.current.scrollTop = tabScroll.current[tab] || 0;
        };
        restore();
        // Textareas measure their height after mounting.
        let frame = requestAnimationFrame(() => { restore(); frame = requestAnimationFrame(restore); });
        return () => cancelAnimationFrame(frame);
    }, [tab]);
    const [uploading, setUploading] = useState(false),
        uploadLock = useRef(false);
    const [assetRole, setAssetRole] = useState<"reference" | "model" | "first-frame" | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false),
        [presetsOpen, setPresetsOpen] = useState(false),
        [presetName, setPresetName] = useState("");
    const [viewed, setViewed] = useState<VideoRecord | null>(null),
        [previewError, setPreviewError] = useState(false);
    const [request, setRequest] = useState(""),
        [scope, setScope] = useState("all");
    const [analysisOpen, setAnalysisOpen] = useState(false),
        [analysisView, setAnalysisView] = useState("current"),
        [analysisDraft, setAnalysisDraft] = useState<{ base: string; value: string } | null>(null);
    const [quote, setQuote] = useState<{ key: string; value: VideoPrice } | null>(null),
        [quoting, setQuoting] = useState(false),
        quoteController = useRef<AbortController | null>(null);
    const [capabilities, setCapabilities] = useState({ compose: false, transcribe: false, error: "" });
    const [refreshing, setRefreshing] = useState(false);
    const locked = busy || uploading,
        labels = storeMaterialLabels(d),
        profile = videoProfile(cfg, cfg.videoModel);
    const mode = videoInputMode(cfg, cfg.videoModel),
        cloud = isReplicateVideoModel(cfg.videoModel),
        wan = cfg.videoModel === REPLICATE_VIDEO_MODEL;
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask || r.workerJob));
    const blocked = storeVideoError(d, cfg) || (pending ? "请先恢复已有任务查询" : "");
    const textError = (analyze = false) => {
        const c = analyze ? configForFeature(config, "store-explore.analyze", "text") : config;
        return c.channelMode === "remote" && !session ? "请先登录" : !c.textModel || !useConfigStore.getState().isAiConfigReady(c, c.textModel) ? "请配置当前文案模型" : "";
    };
    const priceKey = JSON.stringify([settings, d.script, d.storeShots, d.media, d.instructions, d.storeFacts, d.storeFirstFrameId, d.storeLastFrameId, config.channelMode, config.managed?.revision, session]);
    const price = quote?.key === priceKey ? quote.value : null,
        result = viewed ? viewed.result : d.final || d.video;
    const muted = { color: token.colorTextSecondary },
        border = { borderColor: token.colorBorderSecondary };
    const shots = d.storeShots || [],
        audioMode = d.storeAudioMode || "source";
    const cloudSpeech = managedModelBinding(config, config.audioModel, "audio")?.adapter === "cloud:speech";
    const voiceOptions = cloudSpeech ? cloudSpeechSpeakers : audioVoiceOptions.map((v) => v.value);
    const speechCurrent = Boolean(d.speech && d.storeSpeechKey === storeSpeechKey(d, config.audioModel));
    const duration = (d.video?.durationMs || 0) / 1000 || Number(cfg.videoSeconds),
        captionError = storeCaptionError(d, duration);
    const finishError = !d.video ? "请先生成视频" : d.storeOutputStale ? "方案已变化，请先生成当前画面" : audioMode === "narration" && !speechCurrent ? "请先生成当前旁白" : captionError;
    useEffect(() => {
        if (wb.hydrated && !d.storeSettings) wb.patch({ storeSettings: normalizeStoreSettings(storeVideoSettings(config), config) });
    }, [wb.hydrated, d.storeSettings, config]);
    useEffect(() => {
        quoteController.current?.abort();
        setQuoting(false);
        return () => quoteController.current?.abort();
    }, [priceKey]);
    useEffect(() => setPreviewError(false), [result?.url]);
    useEffect(() => { if (screens.lg && tab === "materials") setTab("plan"); }, [screens.lg, tab]);
    useEffect(() => {
        if (wb.hydrated && config.audioModel && !voiceOptions.includes(d.voice)) wb.edit({ voice: cloudSpeech ? "Vivian" : "alloy" }, "speech");
    }, [wb.hydrated, cloudSpeech, config.audioModel, d.voice]);
    useEffect(() => {
        if (wb.hydrated && d.speech && !speechCurrent && d.final && !d.storeFinishStale) wb.patch({ storeFinishStale: true });
    }, [wb.hydrated, speechCurrent, d.speech, d.final, d.storeFinishStale]);
    const refreshCapabilities = async () => {
        try {
            const values = await getWorkerCapabilities(wb.worker);
            setCapabilities({ compose: Boolean(values.find((c) => c.name === "store-compose")?.available), transcribe: Boolean(values.find((c) => c.name === "store-transcribe")?.available), error: "" });
        } catch (e) {
            setCapabilities({ compose: false, transcribe: false, error: e instanceof Error ? e.message : "处理服务连接失败" });
        }
    };
    useEffect(() => {
        if (wb.hydrated) void refreshCapabilities();
    }, [wb.hydrated, wb.worker.url, wb.worker.token, session]);
    const changeSettings = (value: Partial<StoreVideoSettings>) => wb.edit({ storeSettings: normalizeStoreSettings({ ...settings, ...value }, config) }, "script");
    const saveVersion = () => [...(d.storePlanVersions || []), { script: d.script, shots, createdAt: Date.now() }];
    const edit = (field: Editor, value: string) =>
        wb.edit(
            { [field]: value, ...(field === "script" ? { storeShots: [], storeScriptStale: false, ...(shots.length ? { storePlanVersions: saveVersion() } : {}) } : field === "analysis" ? { storeAnalysisStale: false } : {}) },
            field === "storeFacts" ? "materials" : field === "script" ? "video" : "script",
        );
    const updateShots = (value: StoreShot[]) => wb.edit({ storeShots: value, script: renderStoreShots(value, d), storeScriptStale: false }, "video");
    const updateShot = (id: string, value: Partial<StoreShot>) => updateShots(shots.map((s) => (s.id === id ? { ...s, ...value } : s)));
    const moveShot = (index: number, offset: number) => {
        const next = [...shots];
        [next[index], next[index + offset]] = [next[index + offset], next[index]];
        let time = 0;
        updateShots(
            next.map((s) => {
                const length = s.end - s.start,
                    row = { ...s, start: time, end: time + length };
                time += length;
                return row;
            }),
        );
    };
    const adopt = () => {
        if (d.storeSuggestionBase !== storePlanKey(d)) {
            message.warning("原稿已变化，请重新生成修改建议");
            return;
        }
        wb.edit({ script: d.storeScriptSuggestion!, storeShots: d.storeShotSuggestion || [], storePlanVersions: saveVersion(), storeScriptSuggestion: "", storeShotSuggestion: undefined, storeScriptStale: false }, "video");
    };
    const addFiles = async (files: File[], role: "reference" | "model" | "first-frame") => {
        if (locked || uploadLock.current) return;
        uploadLock.current = true;
        setUploading(true);
        try {
            const added = await wb.addFiles(files, role, "image/*");
            if (typeof added === "string") throw new Error(added);
            if (Array.isArray(added) && role === "first-frame") wb.edit({ storeFirstFrameId: added[0]?.id }, "video");
            if (Array.isArray(added) && role === "reference") {
                const current = useVideoWorkbenchStore.getState().drafts["store-explore"]!;
                wb.patch({ media: current.media.map((m) => added.some((a) => a.id === m.id) ? { ...m, storePurpose: storeSuggestedPurpose(m.name) } : m) });
            }
            return Array.isArray(added);
        } catch (e) {
            message.error(e instanceof Error ? e.message : "素材添加失败");
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (!assetRole) return;
        try {
            if (payload.kind !== "image") throw new Error("请选择图片");
            const blob = await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob();
            if (await addFiles([new File([blob], payload.title, { type: blob.type })], assetRole)) setAssetRole(null);
        } catch (e) {
            message.error(e instanceof Error ? e.message : "素材读取失败");
        }
    };
    const prepareQuote = async () => {
        const controller = new AbortController();
        quoteController.current?.abort();
        quoteController.current = controller;
        setQuoting(true);
        try {
            const value = await wb.quoteStoreVideo(controller.signal);
            if (!controller.signal.aborted) setQuote({ key: priceKey, value });
        } catch (e) {
            if (!controller.signal.aborted) message.error(e instanceof Error ? e.message : "报价失败");
        } finally {
            if (!controller.signal.aborted) setQuoting(false);
        }
    };
    const restoreInput = (r: VideoRecord) =>
        modal.confirm({
            title: "基于这个版本制作",
            content: "载入该版输入，当前结果保留在历史记录中。",
            okText: "载入",
            cancelText: "取消",
            onOk: async () => {
                if (!r.storeExploreInput) return;
                const { channelMode: _c, baseUrl: _b, ...input } = r.storeExploreInput;
                const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                wb.patch({ ...emptyVideoDraft("store-explore"), ...input, media, video: null, final: null, speech: null, storeSpeechKey: undefined, subtitles: [], storeOutputStale: false, storeScriptSuggestion: "", storeShotSuggestion: undefined });
                setViewed(null);
                setTab("plan");
            },
        });
    const icon = (title: string, node: React.ReactNode, action: () => void, disabled = locked) => (
        <Tooltip title={title}>
            <Button aria-label={title} type="text" size="small" disabled={disabled} icon={node} onClick={action} />
        </Tooltip>
    );
    const materialField = (role: "reference" | "model" | "first-frame", title: string) => {
        const media = d.media.filter((m) => m.role === role && m.kind === "image");
        const props = {
            accept: "image/*",
            multiple: role !== "first-frame",
            showUploadList: false,
            disabled: locked,
            beforeUpload: (file: File, list: File[]) => {
                if (file === list[0]) void addFiles(role === "first-frame" ? [file] : list, role);
                return Upload.LIST_IGNORE;
            },
        };
        return (
            <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm font-medium">{title}</strong>
                    <Space size={0}>
                        <Upload {...props}>
                            <Button aria-label={`添加${title}`} size="small" type="text" icon={<Plus size={15} />} />
                        </Upload>
                        <Button size="small" type="text" disabled={locked} onClick={() => setAssetRole(role)}>
                            素材库
                        </Button>
                    </Space>
                </div>
                {media.length ? (
                    <div className="space-y-2">
                        {media.map((m) => (
                            <div key={m.id} className="flex min-w-0 gap-2 border-b pb-2" style={border}>
                                <button type="button" className="shrink-0" aria-label={`预览${m.name}`} onClick={() => modal.info({ title: m.name, width: 800, content: <img src={m.url} alt={m.name} className="max-h-[65vh] w-full object-contain" /> })}>
                                    <img src={m.url} alt={m.name} className="h-16 w-16 rounded object-cover" />
                                </button>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1">
                                        <span className="min-w-0 flex-1 truncate text-xs" title={m.name}>
                                            {labels.find((l) => l.id === m.id)?.label} · {m.name}
                                        </span>
                                        {icon(`移除${m.name}`, <X size={13} />, () => wb.removeMedia(m.id))}
                                    </div>
                                    {role === "model" ? (
                                        <Input
                                            size="small"
                                            aria-label={`${m.name}人物身份`}
                                            placeholder="同一人物的多视角填同名"
                                            value={m.storePerson}
                                            disabled={locked}
                                            onChange={(e) => wb.edit({ media: d.media.map((v) => (v.id === m.id ? { ...v, storePerson: e.target.value } : v)) }, "materials")}
                                        />
                                    ) : (
                                        <Select
                                            size="small"
                                            aria-label={`${m.name}用途`}
                                            className="w-full"
                                            disabled={locked}
                                            value={m.storePurpose || "未分类"}
                                            onChange={(storePurpose) => wb.edit({ media: d.media.map((v) => (v.id === m.id ? { ...v, storePurpose } : v)) }, "materials")}
                                            options={["未分类", "门头", "环境", "商品", "服务", "首帧"].map((value) => ({ value, label: value }))}
                                        />
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <Upload.Dragger {...props} height={90}>
                        <Images size={20} className="mx-auto mb-1" />
                        <span className="text-xs">添加{title}</span>
                    </Upload.Dragger>
                )}
            </section>
        );
    };
    const heading = (field: Editor) => (
        <div className="mb-2 flex items-center justify-between">
            <strong className="text-sm font-medium">{names[field]}</strong>
            {icon(`放大${names[field]}`, <Expand size={13} />, () => setEditor(field), false)}
        </div>
    );
    const mentions = (field: "script" | "instructions", rows = 4) => (
        <Mentions
            aria-label={names[field]}
            rows={rows}
            disabled={locked}
            value={d[field]}
            onChange={(v) => edit(field, v)}
            options={labels.map((l) => ({
                value: l.label,
                label: (
                    <span className="inline-flex items-center gap-2">
                        <img src={d.media.find((m) => m.id === l.id)?.url} alt="" className="h-6 w-6 object-cover" />
                        {l.label} · {l.name}
                        <span style={muted}>{d.media.find((m) => m.id === l.id)?.storePurpose || d.media.find((m) => m.id === l.id)?.storePerson || "未分类"}</span>
                    </span>
                ),
            }))}
        />
    );
    const openAnalysis = (view = "current") => {
        setAnalysisView(view);
        setAnalysisDraft(null);
        setAnalysisOpen(true);
    };
    const viewingAnalysisSuggestion = analysisView === "suggestion" && Boolean(d.storeAnalysisSuggestion);
    const analysisText = viewingAnalysisSuggestion ? d.storeAnalysisSuggestion! : d.analysis;
    const analysisDocument = (value: string, summary = false) => {
        const content = storeAnalysisDisplay(value, labels);
        // Static Markdown can retain list nodes from the previous version.
        return (
            <Streamdown
                key={content}
                mode="static"
                controls={false}
                className={`min-w-0 break-words [overflow-wrap:anywhere] [&_:is(h1,h2,h3,h4,h5,h6)]:text-base [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium ${summary ? "text-sm leading-6 [&_:is(h1,h2,h3,h4,h5,h6)]:text-sm" : "text-base leading-7"}`}
                components={{ img: () => null }}
            >
                {content}
            </Streamdown>
        );
    };
    const adoptAnalysis = () => {
        wb.edit({ analysis: d.storeAnalysisSuggestion!, storeAnalysisSuggestion: "", storeAnalysisStale: false }, "script");
        setAnalysisView("current");
    };
    const materialsPanel = (
        <div className="space-y-5">
            {materialField("reference", "门店素材")}
            <section>
                {heading("storeFacts")}
                <Input.TextArea aria-label="门店真实资料" rows={3} disabled={locked} value={d.storeFacts || ""} onChange={(e) => edit("storeFacts", e.target.value)} placeholder="已确认的店名、地址、价格、活动；未知留空" />
            </section>
            <section>
                {heading("instructions")}
                {mentions("instructions", 3)}
            </section>
            <Collapse
                ghost
                items={[
                    { key: "person", label: `出镜人物（可选） · ${d.media.filter((m) => m.role === "model").length} 张`, children: materialField("model", "人物参考") },
                    {
                        key: "analysis",
                        label: `素材观察${d.storeAnalysisStale ? " · 待更新" : d.analysis ? " · 已有" : ""}`,
                        extra: <span onClick={(e) => e.stopPropagation()}>{icon("放大素材观察", <Expand size={14} />, () => openAnalysis(), false)}</span>,
                        children: (
                            <div className="space-y-3">
                                <Button size="small" icon={<Sparkles size={13} />} disabled={locked || !labels.length || Boolean(textError(true))} onClick={() => void wb.run("analyze")}>
                                    分析素材
                                </Button>
                                {d.analysis ? (
                                    <>
                                        <div aria-label="素材观察摘要" className="max-h-28 overflow-hidden">{analysisDocument(d.analysis, true)}</div>
                                        <Button size="small" type="link" className="!px-0" icon={<Expand size={14} />} onClick={() => openAnalysis()}>
                                            查看完整分析
                                        </Button>
                                    </>
                                ) : <p className="text-sm" style={muted}>尚无素材观察</p>}
                                {d.storeAnalysisSuggestion && (
                                    <Button size="small" onClick={() => openAnalysis("suggestion")}>查看新分析 · 待采用</Button>
                                )}
                            </div>
                        ),
                    },
                ]}
            />
            {mode !== "reference" && (
                <section className="space-y-2">
                    <strong className="text-sm font-medium">生成首帧{profile.firstFrameRequired ? "（必填）" : "（可选）"}</strong>
                    <Select
                        className="w-full"
                        aria-label="生成首帧"
                        allowClear
                        disabled={locked}
                        value={d.storeFirstFrameId}
                        onChange={(storeFirstFrameId) => wb.edit({ storeFirstFrameId, ...(storeFirstFrameId ? {} : { media: d.media.filter((m) => m.role !== "first-frame") }) }, "video")}
                        options={d.media.filter((m) => m.kind === "image").map((m) => ({ value: m.id, label: m.name }))}
                    />
                    {materialField("first-frame", "合成首帧")}
                    <Button size="small" icon={<Sparkles size={13} />} disabled={locked || !labels.length || !config.imageModel} onClick={() => void wb.run("keyframe")}>AI 合成首帧预览</Button>
                    {d.storeKeyframeSuggestion && <div className="space-y-2"><img src={d.storeKeyframeSuggestion.url} alt="待采用首帧" className="max-h-48 w-full object-contain" /><Space wrap><Button size="small" disabled={locked || d.storeKeyframeKey !== storeKeyframeKey(d)} onClick={() => {
                        const image = d.storeKeyframeSuggestion!, id = crypto.randomUUID();
                        wb.edit({ media: [...d.media, { ...image, id, name: "探店合成首帧", kind: "image", role: "first-frame" }], storeFirstFrameId: id, storeKeyframeSuggestion: undefined }, "video");
                    }}>采用首帧</Button><Button size="small" disabled={locked} onClick={() => wb.patch({ storeKeyframeSuggestion: undefined })}>保留原首帧</Button></Space></div>}
                    {mode === "first_last" && !wan && (
                        <Select
                            className="w-full"
                            aria-label="生成尾帧"
                            placeholder="生成尾帧"
                            allowClear
                            disabled={locked}
                            value={d.storeLastFrameId}
                            onChange={(storeLastFrameId) => wb.edit({ storeLastFrameId }, "video")}
                            options={d.media.filter((m) => m.kind === "image").map((m) => ({ value: m.id, label: m.name }))}
                        />
                    )}
                    <p className="text-xs" style={muted}>
                        本次只发送选定首帧{mode === "first_last" ? "和尾帧" : ""}，其余素材用于方案。
                    </p>
                </section>
            )}
        </div>
    );
    const spec = `${cloud ? "跟随首帧 / 平台比例" : videoSizeLabel(cfg.size)} · ${cfg.videoSeconds} 秒 · ${cfg.vquality}p`;
    const emptyInput = !labels.length && !d.script.trim() && !d.storeFacts?.trim() && !d.instructions.trim();
    const planAction = () => {
        if (textError()) {
            message.warning(textError());
            return;
        }
        setTab("plan");
        void wb.run("script");
    };
    const primary = tab === "result" && d.video && !viewed && !d.storeOutputStale && (audioMode !== "source" || d.addSubtitles || d.media.some((m) => m.role === "music") || d.final) && (!d.final || d.storeFinishStale)
        ? { label: "合成当前成片", action: () => { void wb.run("compose"); }, disabled: Boolean(finishError) || !capabilities.compose }
        : tab === "result" && result && !viewed && !d.storeOutputStale && !(d.final && d.storeFinishStale)
        ? { label: d.final ? "下载成片" : "下载原片", action: () => { void wb.download(result); }, disabled: false }
        : !d.script.trim()
        ? { label: "生成拍摄方案", action: planAction, disabled: Boolean(textError()) || (!labels.length && !d.storeFacts?.trim() && !d.instructions.trim()) }
        : {
              label: "生成视频",
              action: () => {
                  setViewed(null);
                  setTab("result");
                  void wb.run("video");
              },
              disabled: Boolean(blocked),
          };
    const controls = (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span style={muted}>
                    {spec} · {audioMode === "narration" ? "独立旁白" : audioMode === "mute" ? "去除原声" : "保留原声"}
                </span>
                <Button size="small" type="text" icon={<Settings2 size={14} />} onClick={() => setSettingsOpen(true)}>
                    设置
                </Button>
            </div>
            {config.channelMode === "remote" || cloud ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span>{price ? `本次视频 ${price.credits.toLocaleString()} 算力点` : "方案、视频、旁白按各阶段确认费用"}</span>
                    {session && d.script && (
                        <Button type="link" size="small" disabled={locked || Boolean(blocked)} loading={quoting} onClick={() => void prepareQuote()}>
                            视频报价
                        </Button>
                    )}
                </div>
            ) : (
                <p className="text-xs" style={muted}>
                    自定义渠道按服务账单收费
                </p>
            )}
            {emptyInput ? (
                <Upload
                    accept="image/*"
                    multiple
                    showUploadList={false}
                    disabled={locked}
                    className="block w-full [&_.ant-upload]:!block"
                    beforeUpload={(file, list) => {
                        if (file === list[0]) void addFiles(list, "reference");
                        return Upload.LIST_IGNORE;
                    }}
                >
                    <Button block type="primary" size="large" disabled={locked} loading={uploading} icon={<Plus size={16} />}>
                        添加门店素材
                    </Button>
                </Upload>
            ) : !session && (config.channelMode === "remote" || cloud) ? (
                <UserStatusActions accountOnly />
            ) : (
                <Button block type="primary" size="large" disabled={locked || primary.disabled} loading={busy} icon={<Sparkles size={16} />} onClick={primary.action}>
                    {primary.label}
                </Button>
            )}
            {d.script && blocked && (
                <p role="status" className="text-xs" style={{ color: token.colorWarningText }}>
                    {blocked}
                </p>
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
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6" style={border}>
                <div className="flex items-center gap-3">
                    <Link to="/video" aria-label="返回视频制作">
                        <ArrowLeft size={18} />
                    </Link>
                    <h1 className="text-lg font-semibold">探店视频</h1>
                    <span className="hidden text-xs sm:inline" style={muted}>
                        {wb.storageError ? "保存失败" : "本浏览器草稿"}
                    </span>
                </div>
                <Button type="text" icon={<Save size={15} />} onClick={() => setPresetsOpen(true)}>
                    门店方案
                </Button>
            </header>
            {wb.storageError && <Alert type="error" title={wb.storageError} showIcon />}
            <div className="min-h-0 flex-1 overflow-hidden" data-testid="store-scroll">
                <div className="mx-auto grid h-full max-w-[1680px] lg:grid-cols-[320px_minmax(0,1fr)]">
                    <aside className="hidden min-h-0 flex-col border-r lg:flex" style={border} aria-label="门店素材">
                        <div className="min-h-0 flex-1 overflow-y-auto p-5">{materialsPanel}</div>
                        <div className="shrink-0 border-t p-4" style={border}>
                            {controls}
                        </div>
                    </aside>
                    <section className="flex min-h-0 min-w-0 flex-col px-4 pb-4 sm:px-6">
                        <Tabs
                            activeKey={tab}
                            onChange={setTab}
                            items={[
                                ...(!screens.lg ? [{ key: "materials", label: "素材" }] : []),
                                { key: "plan", label: "拍摄方案" },
                                { key: "result", label: "成片" },
                                { key: "history", label: "历史版本" },
                            ]}
                        />
                        {busy && (
                            <Alert
                                className="mb-3"
                                type="info"
                                showIcon
                                title={active?.step || "正在处理"}
                                description={
                                    <Button size="small" onClick={wb.stop}>
                                        停止等待
                                    </Button>
                                }
                            />
                        )}
                        {!busy && pending && (
                            <Alert
                                className="mb-3"
                                type="info"
                                title="已有任务可恢复"
                                description={
                                    <Button size="small" onClick={() => void wb.resume(pending)}>
                                        查询原任务结果
                                    </Button>
                                }
                            />
                        )}
                        {!busy && active?.error && <Alert className="mb-3" type="warning" title={publicServiceText(active.error)} />}
                        <div ref={mainScroll} className="min-h-0 flex-1 overflow-y-auto pb-3" data-testid="store-main-scroll">
                            {tab === "materials" && <div className="max-w-xl py-2">{materialsPanel}</div>}
                            {tab === "plan" && (
                                <div className="space-y-4 py-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <h2 className="text-base font-medium">{shots.length ? `${shots.length} 个镜头 · ${shots.at(-1)?.end} 秒` : "拍摄方案"}</h2>
                                        <Space wrap size={4}>
                                            <Button size="small" icon={<Sparkles size={14} />} disabled={locked || Boolean(textError())} onClick={planAction}>
                                                {d.script ? "重新编写" : "AI 编写"}
                                            </Button>
                                            {icon(
                                                "撤销采用",
                                                <Undo2 size={14} />,
                                                () => {
                                                    const versions = d.storePlanVersions!,
                                                        last = versions.at(-1)!;
                                                    wb.edit({ script: last.script, storeShots: last.shots, storePlanVersions: versions.slice(0, -1) }, "video");
                                                },
                                                locked || !d.storePlanVersions?.length,
                                            )}
                                            <Button size="small" icon={<Expand size={13} />} onClick={() => setEditor("script")}>
                                                自由编辑
                                            </Button>
                                        </Space>
                                    </div>
                                    {d.storeScriptStale && d.script && <Alert type="warning" title="资料或规格已变化，原方案已保留，请核对后调整" />}
                                    {!d.script && !shots.length && (
                                        <div className="space-y-4">
                                            <div className="flex flex-wrap gap-2">
                                                {d.media
                                                    .filter((m) => m.kind === "image")
                                                    .map((m) => (
                                                        <img key={m.id} src={m.url} alt={m.name} className="h-24 w-24 rounded object-cover" />
                                                    ))}
                                            </div>
                                            {mentions("script", 8)}
                                        </div>
                                    )}
                                    {shots.length
                                        ? shots.map((s, i) => (
                                              <article key={s.id} className="space-y-3 border-b pb-4" style={border}>
                                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                                      <strong className="text-sm font-medium">镜头 {i + 1}</strong>
                                                      <div className="flex flex-wrap items-center gap-1">
                                                          <InputNumber aria-label={`镜头${i + 1}开始`} size="small" className="!w-20" value={s.start} disabled={locked} onChange={(v) => updateShot(s.id, { start: v ?? 0 })} />
                                                          <span>–</span>
                                                          <InputNumber aria-label={`镜头${i + 1}结束`} size="small" className="!w-20" value={s.end} disabled={locked} onChange={(v) => updateShot(s.id, { end: v ?? 0 })} />
                                                          <span className="text-xs">秒</span>
                                                          {icon(`上移镜头${i + 1}`, <ArrowUp size={13} />, () => moveShot(i, -1), locked || i === 0)}
                                                          {icon(`下移镜头${i + 1}`, <ArrowDown size={13} />, () => moveShot(i, 1), locked || i === shots.length - 1)}
                                                          {icon(`删除镜头${i + 1}`, <Trash2 size={13} />, () => updateShots(shots.filter((v) => v.id !== s.id)))}
                                                      </div>
                                                  </div>
                                                  <Input.TextArea aria-label={`镜头${i + 1}画面`} autoSize={{ minRows: 2 }} value={s.visual} disabled={locked} onChange={(e) => updateShot(s.id, { visual: e.target.value })} />
                                                  <div className="flex flex-wrap gap-2">
                                                      {s.materialIds.map((id) => {
                                                          const m = d.media.find((v) => v.id === id);
                                                          return m ? <img key={id} src={m.url} alt={m.name} title={m.name} className="h-12 w-12 rounded object-cover" /> : <Alert key={id} type="error" title="引用素材已移除" />;
                                                      })}
                                                  </div>
                                                  <Select
                                                      className="w-full"
                                                      mode="multiple"
                                                      aria-label={`镜头${i + 1}素材`}
                                                      placeholder="选择参考素材"
                                                      disabled={locked}
                                                      value={s.materialIds}
                                                      onChange={(materialIds) => updateShot(s.id, { materialIds })}
                                                      options={labels.map((l) => ({ value: l.id, label: `${l.label} · ${l.name}` }))}
                                                  />
                                                  <Input.TextArea aria-label={`镜头${i + 1}台词`} autoSize={{ minRows: 1 }} placeholder="台词（可选）" disabled={locked} value={s.dialogue} onChange={(e) => updateShot(s.id, { dialogue: e.target.value })} />
                                              </article>
                                          ))
                                        : d.script && mentions("script", 12)}
                                    <Button
                                        size="small"
                                        disabled={locked || Boolean(d.script && !shots.length)}
                                        icon={<Plus size={14} />}
                                        onClick={() => {
                                            const last = shots.at(-1), end = last?.end || Number(cfg.videoSeconds), start = last ? Number(((last.start + end) / 2).toFixed(3)) : 0;
                                            updateShots([...shots.map((s) => s === last ? { ...s, end: start } : s), { id: crypto.randomUUID(), start, end, materialIds: [], visual: "", dialogue: "" }]);
                                        }}
                                    >
                                        添加镜头
                                    </Button>
                                    {d.script && (
                                        <div className="flex flex-wrap gap-2 border-t pt-4" style={border}>
                                            <Select
                                                aria-label="修改范围"
                                                value={scope}
                                                className="w-full sm:w-44"
                                                disabled={locked}
                                                onChange={setScope}
                                                options={[{ value: "all", label: "重新编写全稿" }, ...shots.map((s, i) => ({ value: s.id, label: `只改镜头 ${i + 1}` }))]}
                                            />
                                            <Input aria-label="AI修改要求" className="min-w-0 flex-1" value={request} disabled={locked} onChange={(e) => setRequest(e.target.value)} placeholder="例如：缩短台词，保留画面" />
                                            <Button
                                                disabled={locked || !request.trim() || Boolean(textError()) || (scope !== "all" && !shots.some((s) => s.id === scope))}
                                                icon={<Sparkles size={14} />}
                                                onClick={() => void wb.reviseScript(JSON.stringify({ request, ...(scope !== "all" ? { ids: [scope] } : {}) }))}
                                            >
                                                预览修改
                                            </Button>
                                        </div>
                                    )}
                                    {d.storeScriptSuggestion && (
                                        <section className="space-y-3 border-l-2 pl-3" style={{ borderColor: token.colorPrimary }}>
                                            <strong className="text-sm font-medium">待采用方案</strong>
                                            <Input.TextArea readOnly aria-label="待采用方案" value={d.storeScriptSuggestion} rows={10} />
                                            <Space wrap>
                                                <Button type="primary" size="small" disabled={locked || d.storeSuggestionBase !== storePlanKey(d)} onClick={adopt}>
                                                    采用方案
                                                </Button>
                                                <Button size="small" disabled={locked} onClick={() => wb.patch({ storeScriptSuggestion: "", storeShotSuggestion: undefined })}>
                                                    保留原稿
                                                </Button>
                                            </Space>
                                            {d.storeSuggestionBase !== storePlanKey(d) && (
                                                <p className="text-xs" style={muted}>
                                                    原稿已变化，请重新生成建议。
                                                </p>
                                            )}
                                        </section>
                                    )}
                                    <p className="text-xs" style={muted}>
                                        单条片段 {cfg.videoSeconds} 秒。镜头时间为创作计划，实际转场和人物表现取决于模型。
                                    </p>
                                </div>
                            )}
                            {tab === "result" && (
                                <div className="space-y-4 py-2">
                                    {viewed && (
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-sm">历史版本 · {new Date(viewed.createdAt).toLocaleString()}</span>
                                            <Button size="small" onClick={() => setViewed(null)}>
                                                返回当前
                                            </Button>
                                        </div>
                                    )}
                                    {!viewed && (d.storeOutputStale || (d.final && d.storeFinishStale)) && <Alert type="warning" title={d.storeOutputStale ? "方案已变化，当前显示此前作品" : "声音或字幕已变化，当前显示此前成片"} />}
                                    {result ? (
                                        <>
                                            {result.mimeType.startsWith("image/") ? <img src={result.url} alt="历史首帧" className="max-h-[58vh] w-full object-contain" /> : result.mimeType.startsWith("audio/") ? (
                                                <audio controls src={result.url} className="w-full" />
                                            ) : (
                                                <video controls src={result.url} className="max-h-[58vh] min-h-40 w-full object-contain" onError={() => setPreviewError(true)} />
                                            )}
                                            {previewError && <Alert type="warning" title="浏览器无法播放此文件，可下载检查原文件" />}
                                            <Space wrap>
                                                <Button type="primary" icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                                    下载{viewed ? "本版" : d.final ? "成片" : "原片"}
                                                </Button>
                                                {!result.mimeType.startsWith("image/") && <Button icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset(result, viewed ? { title: "探店历史作品", tags: "", cover: null } : undefined)}>
                                                    保存素材
                                                </Button>}
                                                {result.mimeType.startsWith("video/") && (
                                                    <Button icon={<Grid2X2 size={15} />} onClick={() => void wb.toCanvas(result)}>
                                                        加入画布
                                                    </Button>
                                                )}
                                            </Space>
                                        </>
                                    ) : viewed?.text ? (
                                        <Input.TextArea readOnly rows={12} value={viewed.text} />
                                    ) : (
                                        <Empty description="暂无视频" />
                                    )}
                                    {!viewed && (
                                        <section className="space-y-4 border-t pt-4" style={border}>
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <h2 className="text-base font-medium">声音与字幕</h2>
                                                <Button size="small" type="text" icon={<RefreshCw size={13} />} onClick={() => void refreshCapabilities()}>
                                                    检查服务
                                                </Button>
                                            </div>
                                            <Segmented
                                                block
                                                aria-label="声音模式"
                                                disabled={locked}
                                                value={audioMode}
                                                options={[
                                                    { label: "原片声音", value: "source" },
                                                    { label: "独立旁白", value: "narration" },
                                                    { label: "去除原声", value: "mute" },
                                                ]}
                                                onChange={(storeAudioMode) => wb.edit({ storeAudioMode: storeAudioMode as VideoDraft["storeAudioMode"] }, "finish")}
                                            />
                                            {audioMode === "source" && (
                                                <p className="text-xs" style={muted}>
                                                    {profile.generateAudio && cfg.videoGenerateAudio === "true" ? "已请求模型生成声音，需核对实际结果与口型。" : "保留已有音轨；当前设置未请求模型生成声音。"}
                                                </p>
                                            )}
                                            {audioMode === "narration" && (
                                                <div className="space-y-3">
                                                    <Input.TextArea aria-label="旁白文案" rows={3} disabled={locked} value={d.narration} placeholder="独立画外旁白，不提供人物口型同步" onChange={(e) => wb.edit({ narration: e.target.value }, "speech")} />
                                                    <Space wrap>
                                                        <Button
                                                            size="small"
                                                            disabled={locked || !shots.some((s) => s.dialogue)}
                                                            onClick={() =>
                                                                wb.edit(
                                                                    {
                                                                        narration: shots
                                                                            .map((s) => s.dialogue)
                                                                            .filter(Boolean)
                                                                            .join("\n"),
                                                                    },
                                                                    "speech",
                                                                )
                                                            }
                                                        >
                                                            从镜头台词填入
                                                        </Button>
                                                        <Select
                                                            aria-label="旁白音色"
                                                            value={d.voice}
                                                            disabled={locked}
                                                            className="w-36"
                                                            onChange={(voice) => wb.edit({ voice }, "speech")}
                                                            options={[...new Set([...voiceOptions, d.voice])].map((value) => ({ value, label: value }))}
                                                        />
                                                        <Button icon={<Sparkles size={14} />} disabled={locked || !d.narration.trim() || !config.audioModel} onClick={() => void wb.run("speech")}>
                                                            生成并试听旁白
                                                        </Button>
                                                    </Space>
                                                    {d.speech && (
                                                        <>
                                                            <audio controls src={d.speech.url} className="w-full" />
                                                            <p className="text-xs" style={muted}>
                                                                {speechCurrent ? "当前旁白" : "文案或音色已变化，需要重新生成"}
                                                                {d.speech.durationMs ? ` · 实际 ${(d.speech.durationMs / 1000).toFixed(2)} 秒` : ""}
                                                            </p>
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Switch aria-label="添加字幕" checked={d.addSubtitles} disabled={locked} onChange={(addSubtitles) => wb.edit({ addSubtitles }, "finish")} />
                                                <span className="text-sm">字幕</span>
                                                <Button size="small" disabled={locked || !capabilities.transcribe || audioMode === "mute" || !(audioMode === "narration" ? speechCurrent : d.video)} onClick={() => void wb.run("subtitles")}>
                                                    识别真实音轨
                                                </Button>
                                                <Button
                                                    size="small"
                                                    icon={<Plus size={13} />}
                                                    disabled={locked || !d.video}
                                                    onClick={() => wb.edit({ subtitles: [...d.subtitles, { start: d.subtitles.at(-1)?.end || 0, end: duration, text: "" }] }, "finish")}
                                                >
                                                    添加文字
                                                </Button>
                                            </div>
                                            {d.addSubtitles && (
                                                <div className="space-y-2">
                                                    {d.subtitles.map((s, i) => (
                                                        <div key={i} className="flex flex-wrap items-center gap-2">
                                                            {(["start", "end"] as const).map((key) => (
                                                                <InputNumber
                                                                    key={key}
                                                                    className="!w-20"
                                                                    aria-label={`字幕${i + 1}${key === "start" ? "开始" : "结束"}`}
                                                                    size="small"
                                                                    value={s[key]}
                                                                    disabled={locked}
                                                                    onChange={(v) => wb.edit({ subtitles: d.subtitles.map((row, j) => (j === i ? { ...row, [key]: v ?? 0 } : row)) }, "finish")}
                                                                />
                                                            ))}
                                                            <Input
                                                                className="min-w-0 flex-1"
                                                                aria-label={`字幕${i + 1}文字`}
                                                                value={s.text}
                                                                disabled={locked}
                                                                onChange={(e) => wb.edit({ subtitles: d.subtitles.map((v, j) => (j === i ? { ...v, text: e.target.value } : v)) }, "finish")}
                                                            />
                                                            {icon(`删除字幕${i + 1}`, <X size={13} />, () => wb.edit({ subtitles: d.subtitles.filter((_, j) => j !== i) }, "finish"))}
                                                        </div>
                                                    ))}
                                                    {d.subtitles.length > 0 && (
                                                        <Button size="small" disabled={locked} onClick={() => wb.edit({ storeSubtitleSource: storeSubtitleSource(d) }, "finish")}>
                                                            已核对当前音轨与字幕时间
                                                        </Button>
                                                    )}
                                                    {captionError && (
                                                        <p className="text-xs" style={{ color: token.colorWarningText }}>
                                                            {captionError}
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                            <Collapse
                                                ghost
                                                items={[
                                                    {
                                                        key: "style",
                                                        label: "配乐与字幕样式",
                                                        children: (
                                                            <div className="space-y-3">
                                                                <Upload
                                                                    accept="audio/*"
                                                                    showUploadList={false}
                                                                    disabled={locked}
                                                                    beforeUpload={(file) => {
                                                                        void wb.addFiles([file], "music", "audio/*");
                                                                        return Upload.LIST_IGNORE;
                                                                    }}
                                                                >
                                                                    <Button disabled={locked} icon={<Plus size={14} />}>
                                                                        添加背景音乐
                                                                    </Button>
                                                                </Upload>
                                                                {d.media
                                                                    .filter((m) => m.role === "music")
                                                                    .map((m) => (
                                                                        <div key={m.id} className="flex items-center gap-2">
                                                                            <span className="min-w-0 flex-1 truncate text-sm">{m.name}</span>
                                                                            {icon(`删除音乐${m.name}`, <X size={13} />, () => wb.removeMedia(m.id))}
                                                                        </div>
                                                                    ))}
                                                                <label className="block text-sm">
                                                                    音乐音量
                                                                    <Slider aria-label="音乐音量" disabled={locked} min={0} max={1} step={0.01} value={d.musicVolume} onChange={(musicVolume) => wb.edit({ musicVolume }, "finish")} />
                                                                </label>
                                                                <Space wrap>
                                                                    <label>
                                                                        字号 <InputNumber aria-label="字幕字号" disabled={locked} min={1} value={d.subtitleSize} onChange={(v) => wb.edit({ subtitleSize: v || 42 }, "finish")} />
                                                                    </label>
                                                                    <label>
                                                                        颜色 <input aria-label="字幕颜色" type="color" disabled={locked} value={d.subtitleColor} onChange={(e) => wb.edit({ subtitleColor: e.target.value }, "finish")} />
                                                                    </label>
                                                                    <label>
                                                                        底部距离{" "}
                                                                        <InputNumber
                                                                            aria-label="字幕底部比例"
                                                                            disabled={locked}
                                                                            min={0}
                                                                            max={0.99}
                                                                            step={0.01}
                                                                            value={d.storeSubtitleBottom ?? 0.08}
                                                                            onChange={(v) => wb.edit({ storeSubtitleBottom: v ?? 0.08 }, "finish")}
                                                                        />
                                                                    </label>
                                                                </Space>
                                                            </div>
                                                        ),
                                                    },
                                                ]}
                                            />
                                            {capabilities.error && <Alert type="warning" title={capabilities.error} />}
                                            <p className="text-xs" style={muted}>
                                                {finishError || (!capabilities.compose ? "后期服务尚未就绪" : "复用原片，修改旁白或字幕不会重新生成视频")}
                                            </p>
                                            {d.final && d.video && (
                                                <Button size="small" onClick={() => void wb.download(d.video!)}>
                                                    下载未合成原片
                                                </Button>
                                            )}
                                        </section>
                                    )}
                                </div>
                            )}
                            {tab === "history" && (
                                <div className="space-y-3 py-2">
                                    {!wb.records.length && <Empty description="暂无历史版本" />}
                                    {wb.records.map((r) => (
                                        <article key={r.id} className="space-y-2 border-b py-3" style={border}>
                                            <div className="flex flex-wrap justify-between gap-2">
                                                <strong className="text-sm font-medium">{stageLabels[r.stage] || r.stage}</strong>
                                                <span className="text-xs" style={muted}>
                                                    {states[r.status]} · {new Date(r.createdAt).toLocaleString()}
                                                </span>
                                            </div>
                                            {r.error && (
                                                <p className="text-xs" style={{ color: token.colorWarningText }}>
                                                    {publicServiceText(r.error)}
                                                </p>
                                            )}
                                            <Space wrap>
                                                {(r.result || r.text) && (
                                                    <Button
                                                        size="small"
                                                        onClick={async () => {
                                                            try {
                                                                setViewed({ ...r, ...(r.result ? { result: await restoreWorkbenchFile(r.result) } : {}) });
                                                                setTab("result");
                                                            } catch (e) {
                                                                message.error(e instanceof Error ? e.message : "作品读取失败");
                                                            }
                                                        }}
                                                    >
                                                        查看本版
                                                    </Button>
                                                )}
                                                {r.storeExploreInput && (
                                                    <Button size="small" disabled={locked} onClick={() => restoreInput(r)}>
                                                        基于本版制作
                                                    </Button>
                                                )}
                                                {["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask || r.workerJob) && (
                                                    <Button size="small" disabled={locked} onClick={() => void wb.resume(r)}>
                                                        恢复查询
                                                    </Button>
                                                )}
                                            </Space>
                                        </article>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
            <footer className="shrink-0 border-t px-4 py-3 lg:hidden" style={{ ...border, background: token.colorBgContainer }}>
                {controls}
            </footer>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(p) => void insertAsset(p)} />
            <Modal
                open={analysisOpen}
                title="素材观察"
                width={1040}
                style={{ top: 16, maxWidth: "calc(100vw - 24px)" }}
                styles={{
                    container: { maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column" },
                    header: { flexShrink: 0 },
                    body: { height: "min(68dvh, 760px)", minHeight: 0, flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 12 },
                    footer: { flexShrink: 0 },
                }}
                onCancel={() => { setAnalysisOpen(false); setAnalysisDraft(null); }}
                footer={
                    analysisDraft ? (
                        <Space wrap>
                            <Button onClick={() => setAnalysisDraft(null)}>取消编辑</Button>
                            <Button type="primary" icon={<Save size={15} />} disabled={locked} onClick={() => {
                                if (analysisDraft.base !== d.analysis) {
                                    message.warning("当前观察已变化，请复制编辑内容后重新核对");
                                    return;
                                }
                                if (analysisDraft.value !== d.analysis) edit("analysis", analysisDraft.value);
                                setAnalysisDraft(null);
                            }}>保存观察</Button>
                        </Space>
                    ) : viewingAnalysisSuggestion ? (
                        <Space wrap>
                            <Button disabled={locked} onClick={() => { wb.patch({ storeAnalysisSuggestion: "" }); setAnalysisView("current"); }}>保留原文</Button>
                            <Button type="primary" disabled={locked} onClick={adoptAnalysis}>采用观察</Button>
                        </Space>
                    ) : (
                        <Space wrap>
                            <Button onClick={() => setAnalysisOpen(false)}>关闭</Button>
                            <Button type="primary" icon={<Sparkles size={15} />} disabled={locked || !d.analysis.trim() || Boolean(textError())} onClick={() => { setAnalysisOpen(false); planAction(); }}>
                                {d.script ? "重新编写拍摄方案" : "生成拍摄方案"}
                            </Button>
                        </Space>
                    )
                }
            >
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    {d.storeAnalysisSuggestion ? (
                        <Segmented
                            aria-label="素材观察版本"
                            disabled={Boolean(analysisDraft)}
                            value={viewingAnalysisSuggestion ? "suggestion" : "current"}
                            options={[{ value: "current", label: "当前观察" }, { value: "suggestion", label: "新分析 · 待采用" }]}
                            onChange={setAnalysisView}
                        />
                    ) : <span className="text-sm" style={muted}>{analysisDraft ? "编辑原文" : "当前观察"}</span>}
                    <Space size={0}>
                        {icon("复制完整分析", <Copy size={16} />, () => copyText(storeAnalysisDisplay(analysisDraft?.value ?? analysisText, labels), "分析已复制"), !(analysisDraft?.value ?? analysisText).trim())}
                        {!viewingAnalysisSuggestion && !analysisDraft && icon("编辑素材观察", <Pencil size={16} />, () => setAnalysisDraft({ base: d.analysis, value: d.analysis }))}
                    </Space>
                </div>
                {d.storeAnalysisStale && <Alert type="warning" showIcon title="素材或资料已变化，请核对当前观察" />}
                {labels.length > 0 && (
                    <div className="flex shrink-0 gap-3 overflow-x-auto pb-2" aria-label="观察对应素材">
                        {labels.map((l) => {
                            const media = d.media.find((m) => m.id === l.id)!;
                            return (
                                <button
                                    key={l.id}
                                    type="button"
                                    className="flex w-40 shrink-0 items-center gap-2 text-left"
                                    aria-label={`查看素材${l.label}`}
                                    onClick={() => modal.info({ title: `${l.label} · ${l.name}`, width: 800, content: <img src={media.url} alt={l.name} className="max-h-[65vh] w-full object-contain" /> })}
                                >
                                    <img src={media.url} alt="" className="h-12 w-12 shrink-0 rounded object-cover" />
                                    <span className="min-w-0 text-sm">
                                        <span className="block truncate">{l.label} · {media.storePerson || media.storePurpose || "未分类"}</span>
                                        <span className="block truncate text-xs" title={l.name} style={muted}>{l.name}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
                {analysisDraft ? (
                    <Input.TextArea
                        aria-label="编辑素材观察原文"
                        disabled={locked}
                        value={analysisDraft.value}
                        onChange={(e) => setAnalysisDraft({ ...analysisDraft, value: e.target.value })}
                        style={{ flex: 1, minHeight: 0, resize: "none", fontSize: 16, lineHeight: 1.8, padding: 16 }}
                    />
                ) : (
                    <div className="min-h-0 flex-1 overflow-auto pr-2" data-testid="store-analysis-document">
                        {analysisText.trim() ? analysisDocument(analysisText) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无素材观察" />}
                    </div>
                )}
            </Modal>
            <Modal open={Boolean(editor)} title={editor ? names[editor] : ""} width={960} onCancel={() => setEditor(null)} footer={<Button onClick={() => setEditor(null)}>完成</Button>}>
                {editor === "script" || editor === "instructions" ? (
                    <>
                        {editor === "script" && shots.length > 0 && <Alert className="mb-3" type="info" title="直接改写会保存为自由脚本，原分镜可撤销恢复" />}
                        {mentions(editor, 16)}
                    </>
                ) : (
                    editor && <Input.TextArea rows={16} aria-label={`放大${names[editor]}`} disabled={locked} value={d[editor] || ""} onChange={(e) => edit(editor, e.target.value)} />
                )}
            </Modal>
            <Modal open={presetsOpen} title="本浏览器门店方案" onCancel={() => setPresetsOpen(false)} footer={null}>
                <div className="space-y-4">
                    <div className="flex gap-2">
                        <Input aria-label="门店方案名称" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="门店名称" />
                        <Button
                            icon={<Save size={14} />}
                            disabled={locked || !presetName.trim()}
                            onClick={() => {
                                useVideoWorkbenchStore.getState().saveStorePreset({ id: crypto.randomUUID(), name: presetName.trim(), media: d.media.filter((m) => m.kind === "image"), facts: d.storeFacts || "", instructions: d.instructions, settings });
                                setPresetName("");
                                message.success("已保存到本浏览器");
                            }}
                        >
                            保存
                        </Button>
                    </div>
                    {presets.map((p) => (
                        <div key={p.id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            <Button
                                size="small"
                                disabled={locked}
                                onClick={() =>
                                    modal.confirm({
                                        title: `载入「${p.name}」`,
                                        content: "替换素材和资料，已有方案与作品保留并提示核对。",
                                        onOk: async () => {
                                            const media = await Promise.all(p.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                                            wb.edit({ media, storeFacts: p.facts, instructions: p.instructions, storeSettings: p.settings, storeFirstFrameId: undefined, storeLastFrameId: undefined }, "materials");
                                            setPresetsOpen(false);
                                        },
                                    })
                                }
                            >
                                载入
                            </Button>
                            {icon(`删除方案${p.name}`, <Trash2 size={14} />, () => {
                                modal.confirm({ title: `删除方案「${p.name}」？`, onOk: () => useVideoWorkbenchStore.getState().removeStorePreset(p.id) });
                            })}
                        </div>
                    ))}
                </div>
            </Modal>
            <Modal
                open={settingsOpen}
                title="制作设置"
                onCancel={() => setSettingsOpen(false)}
                footer={
                    <Button type="primary" onClick={() => setSettingsOpen(false)}>
                        完成
                    </Button>
                }
            >
                <div className="space-y-4">
                    <div className="flex gap-2">
                        <Select
                            aria-label="视频模型"
                            className="min-w-0 flex-1"
                            disabled={locked}
                            value={cfg.videoModel}
                            virtual={false}
                            optionRender={(o) => <VideoModelOption config={config} model={String(o.value)} />}
                            onChange={(videoModel) => changeSettings({ videoModel })}
                            options={selectableModelsByCapability(config, "video").map((value) => ({ value, label: videoProfile(config, value).displayName }))}
                        />
                        <Button
                            aria-label="刷新模型"
                            icon={<RefreshCw size={14} />}
                            disabled={locked}
                            loading={refreshing}
                            onClick={async () => {
                                setRefreshing(true);
                                try {
                                    await useConfigStore.getState().loadPublicSettings();
                                } finally {
                                    setRefreshing(false);
                                }
                            }}
                        />
                    </div>
                    {!cloud && (
                        <label className="block">
                            画幅
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
                        清晰度
                        <Select aria-label="视频分辨率" className="mt-2 w-full" disabled={locked} value={cfg.vquality} onChange={(vquality) => changeSettings({ vquality })} options={profile.resolutions.map((value) => ({ value, label: `${value}p` }))} />
                    </label>
                    <label className="block">
                        时长
                        {profile.seconds.length ? (
                            <Select
                                aria-label="视频时长"
                                className="mt-2 w-full"
                                disabled={locked}
                                value={cfg.videoSeconds}
                                onChange={(videoSeconds) => changeSettings({ videoSeconds })}
                                options={profile.seconds.map((value) => ({ value, label: `${value}秒` }))}
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
                            options={supportedVideoInputModes(profile).map((value) => ({ value, label: value === "reference" ? "多图参考" : value === "first_last" ? "首尾帧" : "首帧 / 文生" }))}
                        />
                    )}
                    {wan && (
                        <label className="block">
                            <Switch disabled={locked} checked={cfg.videoInterpolate === "true"} onChange={(value) => changeSettings({ videoInterpolate: String(value) })} /> 插帧
                        </label>
                    )}
                    {profile.generateAudio && (
                        <label className="block">
                            <Switch aria-label="生成模型声音" disabled={locked} checked={cfg.videoGenerateAudio === "true"} onChange={(value) => changeSettings({ videoGenerateAudio: String(value) })} /> 生成模型声音
                        </label>
                    )}
                    {profile.interface === "ark" && (
                        <label className="block">
                            <Switch disabled={locked} checked={cfg.videoWatermark === "true"} onChange={(value) => changeSettings({ videoWatermark: String(value) })} /> 平台水印
                        </label>
                    )}
                    <Collapse
                        ghost
                        items={[
                            {
                                key: "models",
                                label: "分析、文案与语音模型",
                                children: (
                                    <div className="space-y-3">
                                        <FeatureModelPicker capability="text" featureId="store-explore.analyze" />
                                        {config.managed?.enabled && config.channelMode === "remote" ? <><FeatureModelPicker capability="text" featureId="store-explore.script" /><FeatureModelPicker capability="audio" featureId="store-explore.audio" /><FeatureModelPicker capability="image" featureId="store-explore.image" /></> : <><ModelPicker config={config} capability="text" value={config.textModel} fullWidth onChange={(v) => useConfigStore.getState().updateConfig("textModel", v)} /><ModelPicker config={config} capability="audio" value={config.audioModel} fullWidth onChange={(v) => useConfigStore.getState().updateConfig("audioModel", v)} /></>}
                                        <Button onClick={() => useConfigStore.getState().openConfigDialog(true)}>渠道配置</Button>
                                    </div>
                                ),
                            },
                        ]}
                    />
                </div>
            </Modal>
        </main>
    );
}
