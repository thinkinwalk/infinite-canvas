import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Checkbox, Collapse, Empty, Input, InputNumber, Mentions, Modal, Segmented, Select, Slider, Space, Spin, Steps, Switch, Tabs, Tooltip, Upload, theme } from "antd";
import { ArrowLeft, ArrowRight, Check, Download, Expand, FolderPlus, Grid2X2, Images, Pause, Play, Plus, RefreshCw, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { FeatureModelPicker } from "@/components/feature-model-picker";
import { VideoLinkImport } from "@/components/video-link-import";
import { VideoReferenceRetention } from "@/components/video-reference-retention";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useCopyText } from "@/hooks/use-copy-text";
import { computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { formatBytes } from "@/lib/image-utils";
import { materialMentionError, supportedVideoInputModes, videoInputMode, videoProfile } from "@/lib/video-capabilities";
import { VideoModelOption } from "@/components/video-model-option";
import { publicServiceText, REPLICATE_VIDEO_MODEL, isReplicateVideoModel, reconcileReplicateTask } from "@/services/api/replicate";
import { getWorkerCapabilities, workbenchMediaBlob } from "@/services/api/video-worker";
import type { VideoPrice } from "@/services/api/video";
import { VIDEO_ANALYSIS_FEATURE, videoAnalysisAvailable } from "@/services/api/video-understanding";
import { imageToDataUrl } from "@/services/image-storage";
import { configForFeature, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { StoreVideoSettings, VideoRecord, ViralAnalysisMode, ViralAnalysisVersion, ViralEffect, ViralIntent } from "@/types/video-workbench";
import { useVideoCreationConfig } from "@/hooks/use-video-creation-config";
import { normalizeStoreSettings, storeVideoSettings } from "./store-explore-request";
import { viralAnalysisMode, viralFrameMaterials, viralImageCandidates, viralInput, viralMaterialLabels, viralReference, viralSource, viralVideoConfig, viralVideoError, viralVideoMaterials } from "./viral-recreate-request";
import { viralAdoptAnalysis, viralAdoptedAnalysisError, viralAnalysisInputKey, viralAnalysisIsCurrent, viralAnalysisNames, viralAnalysisNeedsProtection, viralAnalysisProvenance, viralAnalysisResultPatch, viralCurrentAnalysis, viralEditAnalysis, viralForeignAnalysisRecovery, viralLegacyAnalysisRecovery, viralRecordAnalysis } from "./viral-analysis";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";
import { viralKeyframeError, viralKeyframeInputKey, viralKeyframeMaterials, viralVisualRole } from "./viral-keyframe";
import { viralBriefFields, viralEffectCandidates, viralEffectsSource, viralIntent, viralIntentError, viralPlanState, viralPreserveOptions, viralReviewError, viralReviewKey } from "./viral-plan";

type Role = "reference" | "product" | "background" | "model" | "first-frame";
type Editor = "analysis" | "transcript" | "viralFacts" | "viralProductAnalysis" | "instructions" | "script";
const editorNames: Record<Editor, string> = { analysis: "原视频结构分析", transcript: "参考音轨文字", viralFacts: "主体与场景资料", viralProductAnalysis: "商品分析", instructions: "复刻要求", script: "改编视频脚本" };
const suggestionFields = {
    viralProductAnalysis: { key: "viralProductSuggestion", stale: "viralProductStale" },
    script: { key: "viralScriptSuggestion", stale: "viralScriptStale" },
} as const;
const suggestionInfo = (field: Editor) => (field === "viralProductAnalysis" || field === "script" ? suggestionFields[field] : undefined);
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
    const settingsLoaded = useConfigStore((s) => Boolean(s.publicSettings));
    const openConfig = useConfigStore((s) => s.openConfigDialog),
        updateConfig = useConfigStore((s) => s.updateConfig),
        loadSettings = useConfigStore((s) => s.loadPublicSettings);
    const [uploading, setUploading] = useState(false),
        uploadLock = useRef(false),
        [errors, setErrors] = useState<Partial<Record<Role, string>>>({});
    const [expandedRoles, setExpandedRoles] = useState<Partial<Record<Role, boolean>>>({});
    const [assetRole, setAssetRole] = useState<Role | null>(null),
        [editor, setEditor] = useState<Editor | null>(null),
        [editingField, setEditingField] = useState<Editor>("analysis"),
        [showCurrentAnalysis, setShowCurrentAnalysis] = useState(false),
        [suggestionView, setSuggestionView] = useState(false),
        [settingsOpen, setSettingsOpen] = useState(false),
        [serviceOpen, setServiceOpen] = useState(false);
    const [serviceStatus, setServiceStatus] = useState(""),
        [checking, setChecking] = useState(false),
        [refreshing, setRefreshing] = useState(false);
    const [tab, setTab] = useState("current"),
        [viewed, setViewed] = useState<VideoRecord | null>(null),
        [previewError, setPreviewError] = useState(false);
    const [effectSourceOpen, setEffectSourceOpen] = useState(false), [effectSelection, setEffectSelection] = useState("");
    const [comparisonProgress, setComparisonProgress] = useState(0);
    const comparisonOriginal = useRef<HTMLVideoElement | null>(null), comparisonResult = useRef<HTMLVideoElement | null>(null);
    const completedStage = useRef<string | undefined>(undefined);
    const [price, setPrice] = useState<{ key: string; value: VideoPrice } | null>(null),
        [priceError, setPriceError] = useState(""),
        [quoting, setQuoting] = useState(false),
        quoteController = useRef<AbortController | null>(null);
    const referencePlayer = useRef<HTMLVideoElement | null>(null),
        legacyAnalysisRecovered = useRef(false);
    const inputScroll = useRef<HTMLDivElement | null>(null),
        workspaceScroll = useRef<HTMLDivElement | null>(null);
    const previewPanel = useRef<HTMLElement | null>(null);
    const showPanel = (value: string) => {
        setTab(value);
        if (!window.matchMedia("(min-width: 1024px)").matches) requestAnimationFrame(() => previewPanel.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    };
    const step = d.viralStep || 0;
    const goStep = (value: number) => {
        wb.patch({ viralStep: value });
        setViewed(null);
        setTab(value === 1 ? "editor" : "current");
        if (value === 1) { setEditingField(d.script.trim() || d.analysis.trim() ? "script" : "analysis"); setShowCurrentAnalysis(Boolean(d.analysis.trim())); setSuggestionView(false); }
    };
    const keyframe = viralImageCandidates(d).find((m) => m.id === d.viralFirstFrameId),
        keyframeError = viralKeyframeError(d),
        keyframeConfig = configForFeature(config, "image.edit", "image");
    const imageTarget = d.viralImageTarget || "opening", climaxTarget = imageTarget === "climax";
    const selectedImage = climaxTarget ? viralImageCandidates(d).find((m) => m.id === d.viralClimaxId) : keyframe;
    const selectedImageError = viralKeyframeError(d, imageTarget), imageName = climaxTarget ? "高潮画面" : "首帧";
    const cfg = viralVideoConfig(d, config),
        settings = storeVideoSettings(cfg),
        profile = videoProfile(cfg, cfg.videoModel),
        mode = videoInputMode(cfg, cfg.videoModel);
    const wan = cfg.videoModel === REPLICATE_VIDEO_MODEL,
        cloud = isReplicateVideoModel(cfg.videoModel),
        referenceMode = mode === "reference",
        locked = busy || wb.importing || uploading;
    const labels = viralMaterialLabels(d),
        materials = viralVideoMaterials(d, cfg),
        frames = viralFrameMaterials(d),
        reference = viralReference(d);
    const intent = viralIntent(d), effects = d.viralEffects || [], reviewError = viralReviewError(d, cfg);
    const sourceRatio = reference?.width && reference?.height ? inferVideoRatio(`${reference.width}x${reference.height}`) : "";
    const sourceEffectsChanged = effects.length > 0 && d.viralEffectsSource !== viralEffectsSource(d);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask || r.workerJob));
    const active = wb.records.find((r) => r.id === d.activeRecord),
        blocked = viralVideoError(d, cfg) || (pending ? "已有任务可恢复，请先查询或确认原任务状态" : "");
    const modelBlocked = (featureId: string, name: string) => {
        const scoped = configForFeature(config, featureId, "text");
        return config.channelMode === "remote" && !session ? `登录后使用${name}` : !scoped.textModel || !useConfigStore.getState().isAiConfigReady(scoped, scoped.textModel) ? `请配置${name}` : "";
    };
    const textBlocked = modelBlocked("viral-recreate.script", "脚本模型"),
        productBlocked = modelBlocked("viral-recreate.analyze", "商品分析模型");
    const analysisMode = viralAnalysisMode(d, config),
        nativeAnalysis = videoAnalysisAvailable(config),
        analysisBlocked = analysisMode === "video" ? !session ? "登录后分析参考视频" : !nativeAnalysis ? "视频与音轨分析暂不可用，请重新选择模型或改用抽样分析" : "" : modelBlocked("viral-recreate.analyze", "抽样分析模型");
    const analysisResult = d.viralAnalyses?.[analysisMode],
        analysisStale = Boolean(analysisResult && analysisResult.provenance.inputKey !== viralAnalysisInputKey(d, analysisMode)),
        adoptedError = viralAdoptedAnalysisError(d),
        scriptBlocked = adoptedError || (!d.analysis.trim() && Object.values(d.viralAnalyses || {}).some((result) => result?.text.trim() && result.provenance.source === viralSource(d)) ? "请先采用一份当前视频的分析" : ""),
        scriptWritingBlocked = scriptBlocked || viralIntentError(d) || (reference && !d.analysis.trim() ? "请先分析当前视频，再由 AI 撰写改编脚本；也可直接手写脚本" : "");
    const failedAnalysis = active?.stage === "analyze" && active.viralInput?.viralAnalysisMode === "video" && viralSource({ ...d, media: active.viralInput.media }) === viralSource(d) && ["failed", "interrupted"].includes(active.status) && analysisMode === "video" && !busy;
    const currentAnalysis = viralCurrentAnalysis(d),
        editorAnalysis = showCurrentAnalysis ? currentAnalysis : analysisResult,
        viewedAnalysis = viewed && viralRecordAnalysis(viewed);
    const fieldValue = (field: Editor) => field === "analysis" ? editorAnalysis?.text || "" : d[field] || "";
    const suggestedValue = (field: Editor) => field === "analysis" ? !showCurrentAnalysis ? analysisResult?.suggestion?.text || "" : "" : suggestionInfo(field) ? d[suggestionInfo(field)!.key] || "" : "";
    const historicalReference = Boolean(d.analysis.trim() && d.viralAdoptedAnalysis && d.viralAdoptedAnalysis.provenance.source !== viralSource(d));
    const referenceStatus = d.analysis.trim()
        ? adoptedError ? "分析依据已变化" : historicalReference ? `历史借鉴 · ${d.viralAdoptedAnalysis!.provenance.sourceName}` : `已采用当前视频分析 · ${d.viralAdoptedAnalysis?.provenance.modelLabel || "来源未确认"}${d.viralAdoptedAnalysis?.provenance.edited ? "（已编辑）" : ""}`
        : "当前视频分析 · 未采用";
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
        d.viralAdoptedAnalysis,
        d.viralKeyframe,
        d.viralKeyframePrompt,
        d.viralKeyframeReferenceId,
        d.viralProductStale,
        d.viralBrief, d.viralIntent, d.viralEffects, d.viralNoEffects, d.viralReviewKey,
        d.viralClimax, d.viralClimaxId, d.viralClimaxUse,
        config.channelMode,
        config.baseUrl,
        config.videoModels,
        config.models,
        modelCosts,
        config.managed?.revision,
        session,
    ]);
    const quote = price?.key === priceKey ? price.value : null,
        result = viewed ? viewed.result : d.video;
    const original = viewed ? viralReference({ ...d, media: viewed.viralInput?.media || [] }) : reference;
    const resultRecord = viewed ? wb.records.find((r) => r.id === viewed.id) || viewed : (d.video ? wb.records.find((r) => r.stage === "video" && r.result && (r.result.storageKey ? r.result.storageKey === d.video?.storageKey : r.result.url === d.video?.url)) : undefined);
    const acceptanceInput = resultRecord?.viralInput;
    const acceptanceItems = [
        ...(acceptanceInput?.viralEffects || []).map((effect) => ({ id: effect.id, label: `${effect.action === "remove" ? "已去除" : effect.action === "replace" ? `已改为${effect.target}` : "已保留"}：${effect.description}` })),
        { id: "identity", label: "人物、服装、场景与标识符合目标素材" },
        { id: "text", label: acceptanceInput?.viralIntent?.textMode === "replace" ? `物体显示「${acceptanceInput.viralIntent.text}」；${acceptanceInput.viralIntent.textSurface}` : acceptanceInput?.viralIntent?.textMode === "remove" ? "原片要求去除的文字已去除" : acceptanceInput?.viralIntent?.textMode === "none" ? "未增加不需要的画面文字" : "物体文字的字样、位置与出现时机符合要求" },
        { id: "spec", label: `比例、时长与清晰度符合本次规格${acceptanceInput?.viralSettings ? `（${inferVideoRatio(acceptanceInput.viralSettings.size)} / ${acceptanceInput.viralSettings.videoSeconds}秒 / ${acceptanceInput.viralSettings.vquality}p）` : ""}` },
    ];
    const muted = { color: token.colorTextSecondary },
        surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };
    useEffect(() => {
        if (wb.hydrated && !d.viralSettings) wb.patch({ viralSettings: normalizeStoreSettings(storeVideoSettings(config), config) });
    }, [wb.hydrated, d.viralSettings, config]);
    useEffect(() => {
        if (wb.hydrated && !busy && reference && !d.viralAnalysisMode && (config.channelMode === "local" || settingsLoaded))
            wb.patch({ viralAnalysisMode: analysisMode });
    }, [wb.hydrated, busy, reference?.id, d.viralAnalysisMode, analysisMode, config.channelMode, settingsLoaded]);
    useEffect(() => {
        const store = useVideoWorkbenchStore.getState(), draft = store.drafts["viral-recreate"];
        if (!store.hydrated || store.storageError || locked || store.busyTools["viral-recreate"] || !draft) return;
        const foreign = viralForeignAnalysisRecovery(draft);
        const legacy = !foreign && !legacyAnalysisRecovered.current ? viralLegacyAnalysisRecovery(draft, store.records) : undefined;
        if (!foreign) legacyAnalysisRecovered.current = true;
        const recovery = foreign || legacy;
        if (!recovery) return;
        const versions = foreign?.archived || (legacy?.archived ? [legacy.archived] : []);
        const records = [...store.records];
        for (const archived of versions) {
            if (records.some((r) => {
                const saved = viralRecordAnalysis(r);
                return saved?.text === archived.text && JSON.stringify(saved.provenance) === JSON.stringify(archived.provenance);
            })) continue;
            records.unshift({
                id: crypto.randomUUID(), tool: "viral-recreate", stage: "analyze", status: "completed", createdAt: Date.now(),
                step: foreign ? "其他视频分析归档" : "旧稿归档", text: archived.text,
                draftPatch: { viralAnalysisMode: archived.provenance.mode, viralAnalyses: { [archived.provenance.mode]: archived } },
            });
        }
        useVideoWorkbenchStore.setState({
            drafts: { ...store.drafts, "viral-recreate": { ...draft, ...recovery.patch, viralRevision: (draft.viralRevision || 0) + 1 } },
            records,
        });
        setShowCurrentAnalysis(Boolean(recovery.patch.analysis?.trim() || recovery.patch.viralAdoptedAnalysis));
        if (foreign && recovery.patch.analysis === "" && step === 1) { setEditingField("analysis"); setTab("editor"); }
        if (versions.length) message.info(foreign ? "其他视频的分析已归入本浏览器作品，请分析当前视频" : "旧参考分析已归入本浏览器作品");
    }, [wb.hydrated, wb.storageError, locked, d.analysis, d.viralAdoptedAnalysis, d.viralAnalyses, reference?.id, reference?.storageKey]);
    useEffect(() => {
        quoteController.current?.abort();
        setQuoting(false);
        setPriceError("");
        return () => quoteController.current?.abort();
    }, [priceKey]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);
    useEffect(() => {
        inputScroll.current?.scrollTo(0, 0);
        workspaceScroll.current?.scrollTo(0, 0);
    }, [step]);
    useEffect(() => {
        if (wb.hydrated && step === 1) { setTab("editor"); setEditingField(d.script.trim() ? "script" : "analysis"); setShowCurrentAnalysis(Boolean(d.analysis.trim())); }
    }, [wb.hydrated]);
    useEffect(() => {
        if (busy) { completedStage.current = active?.id; return; }
        if (!active || active.status !== "completed" || completedStage.current !== active.id) return;
        completedStage.current = undefined;
        if (step !== 1 || viewed) return;
        if (active.stage === "analyze") { setShowCurrentAnalysis(Boolean(d.analysis.trim())); openEditor("analysis"); }
        if (active.stage === "script") openEditor("script", Boolean(d.viralScriptSuggestion));
        if (active.stage === "keyframe") showPanel("keyframe");
    }, [busy, active?.id, active?.status]);
    useEffect(() => {
        setComparisonProgress(0);
        return () => {
            for (const player of [comparisonOriginal.current, comparisonResult.current]) if (player) { player.pause(); player.playbackRate = 1; }
        };
    }, [result?.url, original?.url, tab]);
    const changeSettings = (value: Partial<StoreVideoSettings>) => {
        wb.edit({ viralSettings: normalizeStoreSettings({ ...settings, ...value }, config) }, "video");
        if (d.script.trim()) message.info("规格已更新，原脚本已保留，请重新核对节奏与关键画面");
    };
    const changeIntent = (value: Partial<ViralIntent>) => wb.edit({ viralIntent: { ...intent, ...value } }, "script");
    const changeEffect = (id: string, value: Partial<ViralEffect>) => wb.edit({ viralEffects: effects.map((effect) => effect.id === id ? { ...effect, ...value } : effect) }, Object.keys(value).every((key) => key === "scriptRange") ? undefined : "script");
    const captureEffectSelection = (input: HTMLTextAreaElement) => setEffectSelection(input.value.slice(input.selectionStart, input.selectionEnd));
    const addEffect = (description = "") => wb.edit({
        viralEffects: [...effects, { id: crypto.randomUUID(), time: "", description, action: "keep", target: "", scriptRange: "" }],
        viralNoEffects: false, ...(!effects.length ? { viralEffectsSource: viralEffectsSource(d) } : {}),
    }, "script");
    const seekComparison = (progress: number) => {
        for (const player of [comparisonOriginal.current, comparisonResult.current]) if (player && Number.isFinite(player.duration)) player.currentTime = player.duration * progress / 100;
        setComparisonProgress(progress);
    };
    const playComparison = async () => {
        const source = comparisonOriginal.current, target = comparisonResult.current;
        if (!source || !target || !Number.isFinite(source.duration) || !Number.isFinite(target.duration) || target.duration <= 0) { message.info("请等待两段视频加载后再对照"); return; }
        try {
            source.currentTime = source.duration * target.currentTime / target.duration;
            source.playbackRate = source.duration / target.duration;
            await Promise.all([source.play(), target.play()]);
        } catch {
            source.pause(); target.pause(); source.playbackRate = 1;
            message.warning("当前浏览器无法联动播放，可分别播放或拖动对照进度");
        }
    };
    const edit = (field: Editor, value: string) => {
        if (field === "analysis") {
            wb.edit(viralEditAnalysis(d, editorAnalysis || { text: "", provenance: viralAnalysisProvenance(d, analysisMode) }, value, showCurrentAnalysis));
            return;
        }
        wb.edit(
            {
                [field]: value,
                ...(field === "viralProductAnalysis"
                      ? { viralProductStale: false }
                      : field === "script"
                        ? { viralScriptStale: false, viralScriptSuggestion: d.viralScriptSuggestion }
                        : field === "transcript"
                          ? { viralTranscriptSource: viralSource(d) }
                          : {}),
            },
            field === "viralFacts" ? "materials" : field === "script" ? "video" : "script",
        );
    };
    const changeAnalysisMode = (value: ViralAnalysisMode) => {
        wb.edit({ viralAnalysisMode: value });
        setShowCurrentAnalysis(false);
        setSuggestionView(false);
    };
    const saveAnalysisDrafts = (versions: (ViralAnalysisVersion | undefined)[]) => {
        const store = useVideoWorkbenchStore.getState();
        for (const version of versions) {
            if (!version?.text.trim() || useVideoWorkbenchStore.getState().records.some((r) => {
                const saved = viralRecordAnalysis(r);
                return saved?.text === version.text && JSON.stringify(saved.provenance) === JSON.stringify(version.provenance);
            })) continue;
            store.addRecord({
                id: crypto.randomUUID(), tool: "viral-recreate", stage: "analyze", status: "completed", createdAt: Date.now(),
                step: "编辑稿备份", text: version.text, viralInput: viralInput(d, cfg),
                draftPatch: { viralAnalysisMode: version.provenance.mode, viralAnalyses: { [version.provenance.mode]: { text: version.text, provenance: version.provenance } } },
            });
        }
    };
    const adoptAnalysis = (version: ViralAnalysisVersion, fromHistory = false) => {
        const previous = d.viralAnalyses?.[version.provenance.mode];
        const replaceCurrent = !viralAnalysisIsCurrent(d, version) && viralAnalysisNeedsProtection(d);
        const replaceEdited = previous?.provenance.edited && previous.text !== version.text;
        const apply = () => {
            const state = useVideoWorkbenchStore.getState();
            if (state.busyTools["viral-recreate"] || state.drafts["viral-recreate"]?.viralRevision !== d.viralRevision) {
                message.warning("草稿已变化，请重新选择分析");
                return;
            }
            saveAnalysisDrafts([replaceCurrent ? currentAnalysis : undefined, replaceEdited ? previous : undefined]);
            wb.edit({
                ...viralAdoptAnalysis(d, version), viralAnalysisMode: version.provenance.mode,
                viralAnalyses: { ...d.viralAnalyses, [version.provenance.mode]: { text: version.text, provenance: version.provenance } },
            }, "script");
            setShowCurrentAnalysis(true);
            openEditor("analysis");
            message.success("已用于当前脚本，已有脚本正文保留");
        };
        const differentInput = version.provenance.inputKey !== viralAnalysisInputKey(d, version.provenance.mode);
        const differentVideo = version.provenance.source !== viralSource(d);
        if (replaceCurrent || replaceEdited || differentInput || (fromHistory && differentVideo)) {
            modal.confirm({
                title: differentVideo ? "借鉴其他视频的历史分析？" : "将这份分析用于改编脚本",
                content: `${replaceCurrent || replaceEdited ? "当前有人工编辑的分析，替换前会保存到本浏览器历史。" : ""}${differentVideo ? `原分析视频：「${version.provenance.sourceName}」。当前视频：「${reference?.name || "未上传"}」。采用后仅借鉴历史结构，不代表已分析当前视频。` : differentInput ? "当前分析参数已变化；采用后沿用原分析，不会重新分析。" : ""}已有脚本将标记为待更新，素材和生成参数保留，不会发起收费请求。`,
                okText: differentVideo ? "仅借鉴历史分析" : "确认采用", cancelText: "取消", onOk: apply,
            });
        } else apply();
    };
    const modelPicker = (featureId: string, label: string) => {
        const scoped = configForFeature(config, featureId, "text");
        return (
            <div className="space-y-1" aria-label={label}>
                <span className="text-xs" style={muted}>{label}</span>
                <div className={locked ? "pointer-events-none opacity-60" : ""} inert={locked}>
                    {config.managed?.enabled && config.channelMode === "remote"
                        ? <FeatureModelPicker capability="text" featureId={featureId} />
                        : <ModelPicker config={scoped} capability="text" value={scoped.textModel} fullWidth onChange={(value) => updateConfig("textModel", value)} onMissingConfig={() => openConfig(true)} />}
                </div>
            </div>
        );
    };
    const analysisSource = (version: ViralAnalysisVersion) => {
        const p = version.provenance;
        if (!p.inputKey) return `历史参考分析 · 来源未确认${p.edited ? "（已编辑）" : ""}`;
        return `${p.source !== viralSource(d) ? "其他视频 · " : ""}${viralAnalysisNames[p.mode]} · ${p.modelLabel}${p.edited ? "（已编辑）" : ""} · ${p.sourceName}${p.mode === "frames" && p.model ? ` · ${p.frameCount || 0} 张画面 · ${p.usesTranscript ? "采用音轨文字" : "未采用音轨文字"}` : ""}${p.createdAt ? ` · ${new Date(p.createdAt).toLocaleString()}` : ""}`;
    };
    const frameGallery = (
        <div className="grid grid-cols-3 gap-2">
            {frames.map((f, i) => (
                <button key={f.id} type="button" aria-label={`预览抽样画面${i + 1}`} onClick={() => {
                    if (referencePlayer.current && Number.isFinite(d.viralFrameTimes?.[i])) referencePlayer.current.currentTime = d.viralFrameTimes![i];
                    modal.info({
                        title: `抽样画面${i + 1} · ${Number.isFinite(d.viralFrameTimes?.[i]) ? `${d.viralFrameTimes![i].toFixed(2)}秒` : "未返回采样时间"}`,
                        content: <img src={f.url} alt={f.name} className="w-full object-contain" />,
                    });
                }}>
                    <img src={f.url} alt={f.name} className="h-20 w-full rounded object-contain" />
                    <span className="text-xs">{Number.isFinite(d.viralFrameTimes?.[i]) ? `${d.viralFrameTimes![i].toFixed(2)}秒` : "时间未返回"}</span>
                </button>
            ))}
        </div>
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
            if (Array.isArray(added) && role === "first-frame") wb.edit(climaxTarget ? { viralClimaxId: added[0]?.id, viralClimax: undefined } : { viralFirstFrameId: added[0]?.id, viralKeyframe: undefined }, "video");
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
    const materialField = (role: Role, title: string, hint: string) => {
        const selected = d.media.some((m) => m.role === role);
        const upload = (
            <div className="space-y-2">
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
                        {uploading ? <Spin size="small" /> : <Images size={18} className="shrink-0" />}<span>{role === "reference" ? "点击或拖放上传视频" : "上传图片"}</span>
                    </div>
                    <div className="mt-1 px-2 text-xs" style={muted}>
                        {hint}
                    </div>
                </Upload.Dragger>
                <Button type="text" size="small" disabled={locked} onClick={() => setAssetRole(role)}>
                    从我的素材选择
                </Button>
                {role === "reference" && <div className="text-xs" style={muted}>原视频上限 300MB；生成时按模型要求准备参考片段。</div>}
                {errors[role] && <div role="alert" className="text-xs" style={{ color: token.colorError }}>{errors[role]}</div>}
            </div>
        );
        return <section className="space-y-2" data-material-role={role}>
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
                                <video ref={referencePlayer} controls src={m.url} className="max-h-28 w-full rounded object-contain" />
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
            {selected && <Button type="text" size="small" disabled={locked} onClick={() => setExpandedRoles((value) => ({ ...value, [role]: !value[role] }))}>{expandedRoles[role] ? "收起上传入口" : role === "reference" ? "更换参考视频" : "继续添加图片"}</Button>}
            <div hidden={selected && !expandedRoles[role]}>
            {role === "reference" ? (
                <Tabs
                    size="small"
                    defaultActiveKey="upload"
                    aria-label="参考视频导入方式"
                    items={[
                        { key: "upload", label: "上传视频", disabled: locked, children: upload },
                        { key: "link", label: "链接提取", disabled: locked, children: <VideoLinkImport disabled={locked} source={reference?.source} showRetention={false} onImport={(text, signal) => wb.importLink(text, role, signal)} /> },
                    ]}
                />
            ) : upload}
            </div>
            {role === "reference" && <VideoReferenceRetention media={reference} completed={Boolean(d.video)} disabled={locked} onReimport={(text, signal) => wb.importLink(text, role, signal)} />}
        </section>;
    };
    const textAction = (stage: string, label: string, missing: boolean) => (
        <Button size="small" disabled={locked || Boolean(stage === "analyze" ? analysisBlocked : stage === "product-analyze" ? productBlocked : textBlocked || scriptWritingBlocked) || missing} icon={<Sparkles size={13} />} onClick={() => void wb.run(stage)}>
            {label}
        </Button>
    );
    const openEditor = (field: Editor, showSuggestion = false) => {
        setViewed(null);
        setEditingField(field);
        setSuggestionView(showSuggestion);
        if (window.matchMedia("(min-width: 1024px)").matches) setTab("editor");
        else setEditor(field);
    };
    const textPreview = (field: Editor, placeholder: string) => ["viralFacts", "instructions", "script"].includes(field) ? (
        <Input.TextArea
            aria-label={editorNames[field]} value={fieldValue(field)} placeholder={placeholder}
            autoSize={{ minRows: field === "script" ? 6 : 3, maxRows: 12 }} disabled={locked}
            onChange={(e) => edit(field, e.target.value)}
        />
    ) : (
        <button type="button" aria-label={`查看 / 编辑全文：${editorNames[field]}`} className="block w-full rounded-lg border p-3 text-left" style={surface} onClick={() => openEditor(field)}>
            <span className="line-clamp-6 whitespace-pre-wrap break-words text-sm leading-6" style={fieldValue(field) ? undefined : muted}>
                {fieldValue(field) || placeholder}
            </span>
            <span className="mt-2 block text-xs" style={muted}>
                {Array.from(fieldValue(field)).length.toLocaleString()} 字 · 点击编辑全文
            </span>
        </button>
    );
    const heading = (field: Editor, action?: ReactNode) => (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <strong className="font-medium">{editorNames[field]}</strong>
            <Space size={4}>
                {action}
                <Button type="text" size="small" icon={<Expand size={13} />} onClick={() => {
                    if (field === "analysis") setShowCurrentAnalysis(false);
                    openEditor(field, field === "analysis" && Boolean(analysisResult?.suggestion));
                }}>
                    查看 / 编辑全文
                </Button>
            </Space>
        </div>
    );
    const suggestionActions = (field: Editor) => {
        if (field === "analysis") {
            const suggested = analysisResult?.suggestion;
            if (!suggested) return null;
            return (
                <Space wrap>
                    <Button disabled={locked} onClick={() => adoptAnalysis(suggested)}>采用新分析</Button>
                    <Button disabled={locked} onClick={() => {
                        wb.edit({ viralAnalyses: { ...d.viralAnalyses, [analysisMode]: { ...analysisResult, suggestion: undefined } } });
                        setSuggestionView(false);
                    }}>保留原稿</Button>
                </Space>
            );
        }
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
    const suggestion = (field: "viralProductAnalysis" | "script") => {
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
        if (field === "analysis" && viewedAnalysis) return (
            <div className="flex h-full min-h-0 flex-col gap-3" data-testid="viral-history-analysis">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <strong className="text-sm font-medium">历史参考分析</strong>
                    <Space wrap>
                        <Button disabled={locked} onClick={() => adoptAnalysis(viewedAnalysis, true)}>{viewedAnalysis.provenance.source !== viralSource(d) ? "借鉴历史分析" : "用于当前脚本"}</Button>
                        <Button onClick={() => openEditor("analysis")}>返回当前分析</Button>
                    </Space>
                </div>
                <p className="break-words text-xs" style={muted}>{analysisSource(viewedAnalysis)}</p>
                <Input.TextArea aria-label="历史参考分析" value={viewedAnalysis.text} readOnly style={{ flex: 1, minHeight: 0, resize: "none", fontSize: 16 }} />
            </div>
        );
        const info = suggestionInfo(field),
            suggested = suggestedValue(field),
            viewingSuggestion = suggestionView && Boolean(suggested),
            value = viewingSuggestion ? suggested : fieldValue(field),
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
                {reference && (field === "analysis" || field === "script") && (
                    <p className="shrink-0 break-words text-xs" style={muted} data-testid="viral-current-video">
                        当前参考视频：{reference.name}{reference.durationMs ? ` · ${(reference.durationMs / 1000).toFixed(1)}秒` : ""}
                    </p>
                )}
                {field === "analysis" && (
                    <div className="shrink-0 space-y-2">
                        <Segmented block aria-label="编辑器分析方式" disabled={locked} value={showCurrentAnalysis ? "current" : analysisMode} options={[...(d.analysis.trim() || showCurrentAnalysis ? [{ value: "current", label: historicalReference ? "历史借鉴" : "已采用分析" }] : []), { value: "video", label: "视频音轨" }, { value: "frames", label: "抽样画面" }]} onChange={(value) => {
                            setViewed(null);
                            if (value === "current") { setShowCurrentAnalysis(true); setSuggestionView(false); }
                            else changeAnalysisMode(value as ViralAnalysisMode);
                        }} />
                        {(viewingSuggestion ? analysisResult?.suggestion : editorAnalysis) && <p className="break-words text-xs" style={muted}>{analysisSource((viewingSuggestion ? analysisResult?.suggestion : editorAnalysis)!)}</p>}
                        {showCurrentAnalysis && adoptedError && <Alert type="warning" title={adoptedError} />}
                        {showCurrentAnalysis && historicalReference && !adoptedError && <Alert type="warning" title="正在借鉴其他视频的历史分析" description={`原视频：${d.viralAdoptedAnalysis!.provenance.sourceName}。这份内容不是当前视频的分析结果。`} />}
                        {showCurrentAnalysis && d.viralAdoptedAnalysis && !adoptedError && d.viralAdoptedAnalysis.inputKey !== d.viralAdoptedAnalysis.provenance.inputKey && <p className="text-xs" style={muted}>已确认沿用原分析，未重新分析当前输入</p>}
                        {showCurrentAnalysis && analysisResult?.suggestion && <Button onClick={() => { setShowCurrentAnalysis(false); setSuggestionView(true); }}>查看新分析建议</Button>}
                        {!showCurrentAnalysis && analysisStale && !viewingSuggestion && <Alert type="warning" title="分析依据已变化，原稿已保留" />}
                        {!value.trim() && !busy && <Alert type="info" title={reference ? "当前视频尚未分析" : "请先添加参考视频"} action={<Button size="small" disabled={locked || !reference || Boolean(analysisBlocked)} onClick={() => void wb.run("analyze")}>分析当前视频</Button>} />}
                        {viewingSuggestion ? suggestionActions("analysis") : editorAnalysis?.text.trim() && (
                            <div className="flex flex-wrap items-center gap-2">
                                <Button disabled={locked || (viralAnalysisIsCurrent(d, editorAnalysis) && !adoptedError)} onClick={() => adoptAnalysis(editorAnalysis)}>
                                    {viralAnalysisIsCurrent(d, editorAnalysis) && !adoptedError ? "已用于当前脚本" : editorAnalysis.provenance.source !== viralSource(d) ? "借鉴这份历史分析" : showCurrentAnalysis && adoptedError ? "确认沿用当前稿" : analysisStale ? "确认沿用并采用此分析" : "用于当前脚本"}
                                </Button>
                                {!viralAnalysisIsCurrent(d, editorAnalysis) && <span className="text-xs" style={muted}>尚未用于当前脚本</span>}
                            </div>
                        )}
                    </div>
                )}
                {info && d[info.stale] && fieldValue(field) && <Alert type="warning" title="输入已变化，原稿已保留；请核对或更新" />}
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
                {viewingSuggestion && field !== "analysis" && <div className="shrink-0">{suggestionActions(field)}</div>}
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
        if (viralRecordAnalysis(r)) {
            setViewed(r);
            setEditingField("analysis");
            setTab("editor");
            if (!window.matchMedia("(min-width: 1024px)").matches) setEditor("analysis");
            return;
        }
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
                const state = useVideoWorkbenchStore.getState();
                if (state.busyTools["viral-recreate"] || state.drafts["viral-recreate"]?.viralRevision !== d.viralRevision) {
                    message.warning("草稿已变化，请重新选择历史记录");
                    return;
                }
                saveAnalysisDrafts([viralAnalysisNeedsProtection(d) ? currentAnalysis : undefined, ...Object.values(d.viralAnalyses || {}).filter((v) => v?.provenance.edited)]);
                const restored = { ...d, ...input, ...viralPlanState(input), media, frames };
                const analysis = viralRecordAnalysis(r);
                wb.patch({ ...input, ...viralPlanState(input), viralAnalyses: input.viralAnalyses, viralAdoptedAnalysis: input.viralAdoptedAnalysis, viralUseTranscript: input.viralUseTranscript, media, frames, ...(analysis ? viralAnalysisResultPatch(restored, analysis) : {}), viralOutputStale: true, viralAnalysisSuggestion: "", viralProductSuggestion: "", viralScriptSuggestion: "", viralRevision: (d.viralRevision || 0) + 1 });
                setViewed(null);
                setTab("current");
            },
        });
    };
    const spec = `${cloud ? "跟随首帧 / 平台默认" : inferVideoRatio(cfg.size)} · ${wan ? "约 " : ""}${cfg.videoSeconds}秒 · ${cfg.vquality}p`;
    const intentFields = <div className="space-y-3">
        <label className="block space-y-2 text-sm">
            <span>重点保留原片</span>
            <Checkbox.Group className="flex flex-wrap gap-2" disabled={locked} value={intent.preserve} options={viralPreserveOptions} onChange={(preserve) => changeIntent({ preserve: preserve as string[] })} />
        </label>
        <label className="block space-y-2 text-sm">
            <span>使用目标图片替换</span>
            <Checkbox.Group disabled={locked} value={intent.replacements} options={[{ value: "model", label: "人物" }, { value: "background", label: "场景" }, { value: "product", label: "商品" }]} onChange={(replacements) => changeIntent({ replacements: replacements as ViralIntent["replacements"] })} />
        </label>
        <label className="block space-y-2 text-sm">
            <span>原片画面文字</span>
            <Select aria-label="原片画面文字处理" className="w-full" disabled={locked} value={intent.textMode} options={[{ value: "pending", label: "待确认" }, { value: "keep", label: "保留原字" }, { value: "replace", label: "替换准确字样" }, { value: "remove", label: "去除文字" }, { value: "none", label: "无相关文字" }]} onChange={(textMode) => changeIntent({ textMode })} />
        </label>
        {intent.textMode === "replace" && <>
            <Input aria-label="准确替换字样" disabled={locked} value={intent.text} placeholder="准确字样，不自动使用主体名称替换" onChange={(e) => changeIntent({ text: e.target.value })} />
            <Input.TextArea aria-label="文字承载位置与时机" disabled={locked} value={intent.textSurface} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="例如：裙摆完全展开后的扇面中央，保持展示时出现；不是屏幕字幕" onChange={(e) => changeIntent({ textSurface: e.target.value })} />
        </>}
        {viralIntentError(d) && <p className="text-xs" style={{ color: token.colorWarning }}>{viralIntentError(d)}</p>}
    </div>;
    const effectsPanel = (
        <div className="space-y-4" data-testid="viral-effects-panel">
            {intentFields}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-medium">复刻关键效果</strong>
                <Space wrap>
                    <Button disabled={locked || !d.analysis.trim() || Boolean(adoptedError)} onClick={() => {
                        const candidates = viralEffectCandidates(d.analysis);
                        if (!effects.length && candidates.length) wb.edit({ viralEffects: candidates, viralEffectsSource: viralEffectsSource(d), viralNoEffects: false }, "script");
                        else { setEffectSelection(""); setEffectSourceOpen(true); }
                    }}>从已采用分析添加</Button>
                    <Tooltip title="添加关键效果"><Button aria-label="添加关键效果" icon={<Plus size={15} />} disabled={locked} onClick={() => addEffect()} /></Tooltip>
                </Space>
            </div>
            <p className="text-xs" style={muted}>逐项确认动作、展开或变形、高潮及物体文字。脚本对应位置由你核对，不代表系统已验证成片效果。</p>
            {sourceEffectsChanged && <Alert type="warning" title="要点来自之前的参考分析" description={<div className="space-y-2"><p>原要点已保留，请对照当前分析检查内容。</p><Button disabled={locked || !d.analysis.trim() || Boolean(adoptedError)} onClick={() => wb.edit({ viralEffectsSource: viralEffectsSource(d), viralReviewKey: undefined })}>已按当前分析重新核对</Button></div>} />}
            {!effects.length && <Empty description="添加原片必须保留的关键效果" />}
            {effects.map((effect, index) => <section key={effect.id} className="space-y-2 border-b pb-4" style={{ borderColor: token.colorBorderSecondary }}>
                <div className="flex items-center justify-between">
                    <strong className="text-sm">要点 {index + 1}</strong>
                    <Tooltip title="移除此要点"><Button aria-label={`移除要点${index + 1}`} type="text" size="small" disabled={locked} icon={<X size={14} />} onClick={() => wb.edit({ viralEffects: effects.filter((item) => item.id !== effect.id) }, "script")} /></Tooltip>
                </div>
                <label className="block space-y-1 text-xs"><span>原片时间（估计）</span><Input aria-label={`要点${index + 1}原片时间`} value={effect.time} disabled={locked} placeholder="例如 00:01–00:02" onChange={(e) => changeEffect(effect.id, { time: e.target.value })} /></label>
                <label className="block space-y-1 text-xs"><span>原片关键效果</span><Input.TextArea aria-label={`要点${index + 1}内容`} autoSize={{ minRows: 2, maxRows: 6 }} value={effect.description} disabled={locked} placeholder="具体动作、物体变化、形态、大小、位置及可见文字" onChange={(e) => changeEffect(effect.id, { description: e.target.value })} /></label>
                <Segmented block aria-label={`要点${index + 1}处理`} value={effect.action} disabled={locked} options={[{ value: "keep", label: "保留" }, { value: "replace", label: "改编" }, { value: "remove", label: "删除效果" }]} onChange={(value) => changeEffect(effect.id, { action: value as ViralEffect["action"] })} />
                {effect.action === "replace" && <Input.TextArea aria-label={`要点${index + 1}改编内容`} value={effect.target} disabled={locked} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="改成什么，仍需保留的形态与展示过程" onChange={(e) => changeEffect(effect.id, { target: e.target.value })} />}
                {effect.action !== "remove" && <label className="block space-y-1 text-xs"><span>改编脚本对应位置</span><Input aria-label={`要点${index + 1}脚本位置`} value={effect.scriptRange} disabled={locked} placeholder="例如 1–3 秒：展开成巨型折扇" onChange={(e) => changeEffect(effect.id, { scriptRange: e.target.value })} /></label>}
            </section>)}
            {!effects.length && <Checkbox disabled={locked} checked={Boolean(d.viralNoEffects)} onChange={(e) => wb.edit({ viralNoEffects: e.target.checked, viralReviewKey: undefined })}>已检查，没有需要单独列出的关键效果</Checkbox>}
            <div className="space-y-3 border-t pt-4" style={{ borderColor: token.colorBorderSecondary }}>
                <strong className="font-medium">脚本核对</strong>
                <p className="text-sm">本次目标：{spec}</p>
                <Button disabled={!d.script.trim()} onClick={() => openEditor("script", Boolean(d.viralScriptSuggestion))}>查看改编脚本{d.viralScriptSuggestion ? "新建议" : ""}</Button>
                {reviewError && <p className="text-xs" style={{ color: token.colorWarning }}>{reviewError}</p>}
                <Button type="primary" icon={<Check size={15} />} disabled={locked || Boolean(viralReviewError({ ...d, viralReviewKey: viralReviewKey(d, cfg) }, cfg)) || !reviewError} onClick={() => wb.edit({ viralReviewKey: viralReviewKey(d, cfg), viralScriptStale: false })}>{reviewError ? "确认脚本覆盖要点与目标规格" : "脚本与要点已确认"}</Button>
            </div>
        </div>
    );
    const videoSettings = (
        <div className="space-y-3">
            <strong className="font-medium">视频生成设置</strong>
            <div className="flex items-center gap-2">
                <Select
                    aria-label="视频模型" className="min-w-0 flex-1" disabled={locked} value={cfg.videoModel} virtual={false}
                    optionRender={(option) => <VideoModelOption config={config} model={String(option.value)} />}
                    onChange={(videoModel) => changeSettings({ videoModel })}
                    options={selectableModelsByCapability(config, "video").map((value) => ({ value, label: videoProfile(config, value).displayName }))}
                />
                <Button aria-label="刷新模型" disabled={locked} loading={refreshing} icon={<RefreshCw size={14} />} onClick={() => void refreshModels()} />
                <Button aria-label="视频设置" disabled={locked} icon={<SlidersHorizontal size={14} />} onClick={() => setSettingsOpen(true)} />
            </div>
            <p className="text-xs" style={muted}>{spec}</p>
            {step === 1 && <div className="grid grid-cols-3 gap-2">
                <label className="min-w-0 space-y-1 text-xs">比例
                    {cloud ? <p>跟随首帧</p> : <Select aria-label="目标视频比例" className="w-full" disabled={locked} value={inferVideoRatio(cfg.size)} onChange={(value) => changeSettings({ size: computeVideoSize(cfg.vquality, value) })} options={["9:16", "16:9", "1:1", "3:4", "4:3", "21:9"].map((value) => ({ value, label: value }))} />}
                </label>
                <label className="min-w-0 space-y-1 text-xs">时长
                    {profile.seconds.length ? <Select aria-label="目标视频时长" className="w-full" disabled={locked} value={cfg.videoSeconds} options={profile.seconds.map((value) => ({ value, label: `${value}秒` }))} onChange={(videoSeconds) => changeSettings({ videoSeconds })} /> : <Input aria-label="目标视频时长" disabled={locked} value={cfg.videoSeconds} onChange={(e) => changeSettings({ videoSeconds: e.target.value })} />}
                </label>
                <label className="min-w-0 space-y-1 text-xs">清晰度
                    <Select aria-label="目标视频清晰度" className="w-full" disabled={locked} value={cfg.vquality} options={profile.resolutions.map((value) => ({ value, label: `${value}p` }))} onChange={(vquality) => changeSettings({ vquality })} />
                </label>
            </div>}
            <p className="text-xs" style={muted}>{referenceMode ? "多素材参考：按下列实际输入生成，首帧作为画面参考。" : "首帧驱动：从确认的画面生成，动作依照脚本重建。"} {profile.description}</p>
        </div>
    );
    const nextAction = reference && (!d.analysis.trim() || adoptedError) ? {
        label: "分析 / 确认当前视频", disabled: false, run: () => { setShowCurrentAnalysis(Boolean(d.analysis.trim())); openEditor("analysis"); },
    } : intent.textMode === "pending" || (!effects.length && !d.viralNoEffects) || sourceEffectsChanged ? {
        label: "确认复刻要点", disabled: false, run: () => showPanel("plan"),
    } : !d.script.trim() ? {
        label: "AI 撰写改编脚本", disabled: Boolean(textBlocked || scriptWritingBlocked), run: () => void wb.run("script"),
    } : d.viralScriptSuggestion ? {
        label: "查看并采用脚本建议", disabled: false, run: () => openEditor("script", true),
    } : reviewError ? {
        label: "核对脚本与关键效果", disabled: false, run: () => showPanel("plan"),
    } : keyframeError || viralKeyframeError(d, "climax") || (profile.firstFrameRequired && !keyframe) ? {
        label: "确认关键画面", disabled: false, run: () => { wb.patch({ viralImageTarget: keyframeError || !keyframe ? "opening" : "climax" }); showPanel("keyframe"); },
    } : { label: "下一步：生成视频", disabled: Boolean(scriptBlocked), run: () => goStep(2) };
    const controls = step !== 2 ? (
        <div className="flex items-center gap-2">
            {step > 0 && <Button aria-label="上一步" icon={<ArrowLeft size={15} />} disabled={locked} onClick={() => goStep(step - 1)} />}
            <Button type="primary" block disabled={locked || (step === 0 ? !reference && !d.script.trim() && !d.instructions.trim() && !d.viralFacts?.trim() && !Object.values(d.viralBrief || {}).some((value) => value.trim()) : nextAction.disabled)} icon={<ArrowRight size={15} />} onClick={() => step === 0 ? goStep(1) : nextAction.run()}>
                {step === 0 ? "下一步：确认脚本与画面" : nextAction.label}
            </Button>
        </div>
    ) : (
        <div className="space-y-2">
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
                <div className="flex items-start justify-between gap-1 text-xs" style={muted}>
                    <span>{blocked}</span>
                    {(!d.script.trim() || keyframeError || adoptedError || reviewError || viralKeyframeError(d, "climax")) && <Button type="link" size="small" disabled={locked} onClick={() => { goStep(1); if (reviewError) setTab("plan"); }}>去完善</Button>}
                </div>
            )}
        </div>
    );
    const keyframePanel = (
        <div className="space-y-4">
            <Segmented block aria-label="关键画面类型" value={imageTarget} disabled={locked} options={[{ value: "opening", label: "开场画面" }, { value: "climax", label: "高潮画面" }]} onChange={(value) => wb.patch({ viralImageTarget: value as "opening" | "climax" })} />
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{climaxTarget ? "确认展开形态、文字与高潮姿态" : "确认人物、场景与开场姿势"}</h2>
                {selectedImage && <span className="text-xs" style={selectedImageError ? { color: token.colorWarning } : { color: token.colorSuccess }}>{selectedImageError ? "待确认" : "已确认"}</span>}
            </div>
            <div className="flex flex-wrap gap-3">
                {viralKeyframeMaterials(d, imageTarget).map((m) => <figure key={m.id} className="w-24">
                    <img src={m.url} alt={m.name} className="h-24 w-full rounded object-contain" />
                    <figcaption className="mt-1 truncate text-xs" title={m.name}>{m.id.startsWith("frame:") ? "动作与效果参考" : viralVisualRole(m.role)} · {m.name}</figcaption>
                </figure>)}
            </div>
            <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">原视频{climaxTarget ? "高潮效果" : "开场姿势"}（可选）</span>
                    <Button size="small" icon={<Images size={14} />} disabled={locked || !reference} onClick={() => void wb.run("frames")}>{frames.length ? "重新抽样" : "抽取参考画面"}</Button>
                </div>
                <Select aria-label={`${imageName}姿势参考`} className="w-full" allowClear disabled={locked} value={climaxTarget ? d.viralClimaxReferenceId : d.viralKeyframeReferenceId} placeholder={climaxTarget ? "借鉴展开形态、姿势与构图" : "仅借鉴姿势、机位与构图"} onChange={(value) => wb.edit(climaxTarget ? { viralClimaxReferenceId: value } : { viralKeyframeReferenceId: value }, "video")} options={frames.map((m, i) => ({ value: m.id, label: `${m.name}${Number.isFinite(d.viralFrameTimes?.[i]) ? ` · ${d.viralFrameTimes![i].toFixed(2)}秒` : ""}` }))} />
                {frames.length > 0 && <Collapse items={[{ key: "pose-gallery", label: "查看动作参考画面", children: frameGallery }]} />}
            </div>
            <Input.TextArea aria-label={climaxTarget ? "高潮画面要求" : "首帧画面要求"} disabled={locked} autoSize={{ minRows: 3, maxRows: 8 }} value={(climaxTarget ? d.viralClimaxPrompt : d.viralKeyframePrompt) || ""} placeholder={climaxTarget ? "展开后的形态、大小、准确文字、人物姿态及展示位置" : "开场姿态、人物位置、全身构图、标识与裙摆等画面要求"} onChange={(e) => wb.edit(climaxTarget ? { viralClimaxPrompt: e.target.value } : { viralKeyframePrompt: e.target.value }, "video")} />
            <label className="flex flex-wrap items-center gap-2 text-sm">
                关键画面画幅
                <Select aria-label="首帧画幅" disabled={locked} value={inferVideoRatio(cfg.size)} onChange={(ratio) => changeSettings({ size: computeVideoSize(cfg.vquality, ratio) })} options={["9:16", "16:9", "1:1", "3:4", "4:3", "21:9"].map((value) => ({ value, label: value }))} />
            </label>
            <div className="space-y-2">
                <span className="text-xs" style={muted}>关键画面合成模型 · 图片编辑独立计费</span>
                {keyframeConfig.managed?.enabled && config.channelMode === "remote" ? <FeatureModelPicker featureId="image.edit" capability="image" /> : <ModelPicker config={keyframeConfig} capability="image" value={keyframeConfig.imageModel} fullWidth onChange={(value) => updateConfig("imageModel", value)} />}
                <Button icon={<Sparkles size={15} />} loading={busy && active?.stage === "keyframe"} disabled={locked || !d.script.trim() || !viralKeyframeMaterials(d, imageTarget).some((m) => !m.id.startsWith("frame:")) || Boolean(viralIntentError(d))} onClick={() => void wb.run("keyframe")}>合成{imageName}</Button>
            </div>
            {selectedImage ? <div className="space-y-3">
                <img src={selectedImage.url} alt={`待确认的${imageName}`} className="max-h-[45vh] w-full object-contain" />
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="primary" disabled={locked || !selectedImageError} icon={<Check size={15} />} onClick={() => wb.edit({ ...(climaxTarget ? { viralClimax: { ...d.viralClimax, id: selectedImage.id, inputKey: viralKeyframeInputKey(d, imageTarget), confirmed: true } } : { viralKeyframe: { ...d.viralKeyframe, id: selectedImage.id, inputKey: viralKeyframeInputKey(d), confirmed: true } }), viralOutputStale: true })}>{selectedImageError ? `确认使用这张${imageName}` : `${imageName}已确认`}</Button>
                    <Button icon={<Download size={14} />} onClick={() => void wb.download(selectedImage)}>下载{imageName}</Button>
                    <Button disabled={locked} onClick={() => wb.edit(climaxTarget ? { viralClimaxId: undefined, viralClimax: undefined, viralClimaxUse: "preview" } : { viralFirstFrameId: undefined, viralKeyframe: undefined }, "video")}>取消选用</Button>
                </div>
                {selectedImageError && <p className="text-xs" style={{ color: token.colorWarning }}>请核对人物、服饰、建筑标识、{climaxTarget ? "展开效果与文字" : "开场姿势"}及画幅。</p>}
            </div> : <Empty description={`合成或上传${imageName}后，在这里确认`} />}
            {climaxTarget && <div className="space-y-2">
                <label className="block text-sm">高潮图用途</label>
                <Select aria-label="高潮图用途" className="w-full" disabled={locked} value={d.viralClimaxUse || "preview"} onChange={(viralClimaxUse) => wb.edit({ viralClimaxUse }, "video")} options={[
                    { value: "preview", label: "仅用于人工确认，不发送视频模型" },
                    { value: "reference", label: "作为普通参考图发送，不锁定时间位置", disabled: !referenceMode || profile.maxImages < 1 },
                    { value: "last", label: "作为尾帧发送，目标结束时保持该画面", disabled: mode !== "first_last" || wan },
                ]} />
                <p className="text-xs" style={muted}>普通参考图不等于指定中间帧。高潮不在结尾时，请勿设为尾帧。</p>
            </div>}
            <p className="text-xs" style={muted}>半身照未展示的全身、裙摆和背面需要生成补全；以确认后的画面为准。</p>
            <Collapse items={[{ key: "existing-frame", label: `上传或选择已有${imageName}`, children: <div className="space-y-3">
                <Select aria-label={climaxTarget ? "选择高潮画面" : "生成首帧"} className="w-full" allowClear disabled={locked} value={selectedImage?.id} placeholder="选择已有画面" onChange={(value) => wb.edit(climaxTarget ? { viralClimaxId: value, viralClimax: undefined } : { viralFirstFrameId: value, viralKeyframe: undefined }, "video")} options={viralImageCandidates(d).map((m) => ({ value: m.id, label: `${labels.find((l) => l.id === m.id)?.label} · ${m.name}` }))} />
                {materialField("first-frame", `上传${imageName}`, "上传已包含目标人物与场景的完整画面")}
            </div> }]} />
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
                    {["准备参考视频与目标素材", "确认脚本、人物与开场画面", "核对输入与费用，生成视频"][step]}
                </span>
            </header>
            <nav aria-label="复刻步骤" className="mx-auto w-full max-w-[1800px] shrink-0 px-4 pb-3 sm:px-6">
                <Steps size="small" current={step} responsive={false} onChange={goStep} items={["准备素材", "确认脚本与画面", "生成视频"].map((title) => ({ title, disabled: locked }))} />
            </nav>
            <div ref={workspaceScroll} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="viral-scroll">
                <div className="mx-auto grid min-h-full max-w-[1800px] grid-cols-1 gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[420px_minmax(0,1fr)]">
                    <section className="flex min-h-0 min-w-0 flex-col rounded-lg border" style={surface} aria-label="复刻素材与设置">
                        <div ref={inputScroll} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 [&>*]:shrink-0" data-testid="viral-input-scroll">
                            <div hidden={step !== 0} className="space-y-4">
                            {materialField("reference", "参考视频", "借鉴动作、节奏与表达；上传后不会自动收费")}
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                                {materialField("background", "场景图片", "目标楼宇、门店或环境")}
                                {materialField("model", "人物图片", "目标人物身份与服饰")}
                            </div>
                            <section>
                                <strong className="mb-2 block font-medium">主体与场景资料</strong>
                                <div className="space-y-3">
                                    {(Object.keys(viralBriefFields) as (keyof typeof viralBriefFields)[]).map((field) => <label key={field} className="block space-y-1 text-sm">
                                        <span>{viralBriefFields[field]}</span>
                                        <Input aria-label={viralBriefFields[field]} value={d.viralBrief?.[field] || ""} disabled={locked} onChange={(e) => wb.edit({ viralBrief: { subject: "", person: "", scene: "", marks: "", ...d.viralBrief, [field]: e.target.value } }, "script")} placeholder={{ subject: "例如：辉科胜邦", person: "指定人物，需保留的服装与外观", scene: "例如：使用场景图中的楼宇正面", marks: "准确名称、建筑标识等；不确定的资料留空" }[field]} />
                                    </label>)}
                                    <Collapse items={[{ key: "extra-facts", label: d.viralFacts?.trim() ? "补充资料 · 已填写" : "补充资料（可选）", children: textPreview("viralFacts", "补充已知事实；图片推测的资料请先核实") }]} />
                                </div>
                            </section>
                            <section>
                                <strong className="mb-2 block font-medium">复刻要求</strong>
                                {intentFields}
                                <label className="mt-3 block space-y-2 text-sm"><span>补充要求（可选）</span>{textPreview("instructions", "补充风格、动作与细节；@引用素材")}</label>
                            </section>
                            <Collapse items={[{ key: "product", label: `商品图片与分析（可选）${d.media.some((m) => m.role === "product") ? " · 已添加" : ""}`, children: <div className="space-y-3">
                                {materialField("product", "商品图片", "需要展示具体商品时添加")}
                                {heading("viralProductAnalysis", textAction("product-analyze", "分析新商品", !d.media.some((m) => m.role === "product")))}
                                {modelPicker("viral-recreate.analyze", "商品分析模型")}
                                {productBlocked && <p className="text-xs" style={{ color: token.colorWarning }}>{productBlocked}</p>}
                                {textPreview("viralProductAnalysis", "只分析商品可见信息")}
                                {suggestion("viralProductAnalysis")}
                            </div> }]} />
                            </div>
                            <div hidden={step !== 1} className="space-y-5">
                            <section className="space-y-2">
                                {videoSettings}
                                {reference && <p className="text-xs" style={muted}>原片：{sourceRatio || "比例待读取"}{reference.durationMs ? ` · ${(reference.durationMs / 1000).toFixed(1)}秒` : ""}</p>}
                                {sourceRatio && sourceRatio !== inferVideoRatio(cfg.size) && !cloud && <Alert type="warning" title="目标画幅与原片不同" description={<div className="space-y-2"><p>保留当前目标画幅，或调整后再确认脚本和关键画面。</p><Button size="small" disabled={locked} onClick={() => changeSettings({ size: computeVideoSize(cfg.vquality, sourceRatio) })}>采用原片比例</Button></div>} />}
                            </section>
                            <section className="space-y-2">
                                {heading("analysis")}
                                <p className="break-words text-xs" style={muted}>当前参考视频：{reference?.name || "未添加"}{reference?.durationMs ? ` · ${(reference.durationMs / 1000).toFixed(1)}秒` : ""}</p>
                                <span className="text-xs" style={muted}>分析方式</span>
                                <Segmented
                                    block aria-label="参考视频分析方式" disabled={locked} value={analysisMode}
                                    options={[{ value: "video", label: "视频与音轨" }, { value: "frames", label: "抽样画面" }]}
                                    onChange={(value) => changeAnalysisMode(value as ViralAnalysisMode)}
                                />
                                {modelPicker(analysisMode === "video" ? VIDEO_ANALYSIS_FEATURE : "viral-recreate.analyze", "分析模型")}
                                {!nativeAnalysis && analysisMode === "frames" && <p className="text-xs" style={muted}>视频与音轨分析暂不可用，当前采用抽样方式</p>}
                                {analysisBlocked && <div role="alert" className="text-xs" style={{ color: token.colorWarning }}>{analysisBlocked}</div>}
                                {analysisMode === "frames" && (
                                    <div className="space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-xs">抽样数量</span>
                                            <InputNumber aria-label="抽样数量" min={1} precision={0} disabled={locked} value={d.frameCount} onChange={(value) => wb.edit({ frameCount: value || 1 }, "materials")} />
                                        </div>
                                        <label className="flex items-center gap-2 text-xs" aria-label="抽样音轨文字">
                                            <Switch aria-label="使用音轨文字" disabled={locked} checked={Boolean(d.viralUseTranscript)} onChange={(viralUseTranscript) => wb.edit({ viralUseTranscript })} />
                                            使用音轨文字
                                        </label>
                                        {d.viralUseTranscript && <Collapse items={[{
                                            key: "transcript", label: d.transcript && d.viralTranscriptSource === viralSource(d) ? "音轨文字 · 已准备" : "音轨文字 · 待转写",
                                            children: <div className="space-y-2">
                                                {heading("transcript", <Button size="small" disabled={locked || !reference} onClick={() => void wb.run("transcribe")}>重新转写</Button>)}
                                                {textPreview("transcript", "可手动填写；未准备时开始分析会先转写")}
                                            </div>,
                                        }]} />}
                                        <Collapse items={[{
                                            key: "frames", label: `抽样预览${frames.length ? ` · ${frames.length} 张` : ""}`,
                                            children: <div className="space-y-2">
                                                <Button size="small" disabled={locked || !reference} icon={<Images size={13} />} onClick={() => void wb.run("frames")}>{frames.length ? "重新抽取画面" : "预览抽样画面"}</Button>
                                                {frameGallery}
                                            </div>,
                                        }]} />
                                    </div>
                                )}
                                {textAction("analyze", "开始分析", !reference)}
                                <p className="text-xs" style={muted}>{analysisMode === "video" ? "分析费用提交前确认" : `含画面抽样${d.viralUseTranscript ? "、缺失音轨文字转写" : ""}及模型分析；处理服务按其账单计费，模型分析单独确认费用`}</p>
                                {failedAnalysis && <Alert
                                    type="warning" title={active.status === "interrupted" ? "视频分析已停止等待" : "视频分析失败"}
                                    description={<div className="space-y-2">
                                        <p className="break-words">{active.error}</p>
                                        <Space wrap>
                                            <Button size="small" disabled={locked || Boolean(analysisBlocked)} onClick={() => void wb.run("analyze")}>重试视频分析</Button>
                                            <Button size="small" disabled={locked} onClick={() => changeAnalysisMode("frames")}>改用抽样分析</Button>
                                        </Space>
                                    </div>}
                                />}
                                <p className="break-words text-xs" style={muted}>
                                    {analysisResult?.suggestion ? "新分析待采用，人工编辑稿已保留" : analysisResult?.text.trim() ? viralAnalysisIsCurrent(d, analysisResult) && !adoptedError ? historicalReference ? "已借鉴历史分析 · 当前视频尚未分析" : "分析完成 · 已用于当前脚本" : "已有分析 · 可在右侧查看并采用" : "当前视频尚未分析"}
                                </p>
                            </section>
                            <section className="space-y-2">
                                <strong className="font-medium">复刻关键效果</strong>
                                <p className="text-xs" style={muted}>{effects.length ? `${effects.length} 项 · ${reviewError ? "待核对" : "脚本已确认覆盖"}` : d.viralNoEffects ? "已确认无需单列效果" : "待确认保留、改编、删除及画面文字"}</p>
                                <Button disabled={locked} onClick={() => showPanel("plan")}>确认要点与脚本对应位置</Button>
                            </section>
                            <section>
                                {heading("script", textAction("script", "AI 撰写脚本", !d.viralFacts?.trim() && !d.instructions.trim() && !d.analysis.trim() && !Object.values(d.viralBrief || {}).some((value) => value.trim()) && !d.media.some((m) => m.role === "product")))}
                                {modelPicker("viral-recreate.script", "脚本模型")}
                                <div className="my-2 flex min-w-0 items-center justify-between gap-2" aria-label="当前脚本参考分析">
                                    <span className="min-w-0 truncate text-xs" style={adoptedError ? { color: token.colorWarning } : muted} title={referenceStatus}>{referenceStatus}</span>
                                    <Button type="link" size="small" onClick={() => { setShowCurrentAnalysis(Boolean(d.analysis.trim())); openEditor("analysis"); }}>查看</Button>
                                </div>
                                {(textBlocked || scriptWritingBlocked) && <p className="text-xs" style={{ color: token.colorWarning }}>{textBlocked || scriptWritingBlocked}</p>}
                                <p className="text-sm" style={muted}>{d.script.trim() ? `已有 ${Array.from(d.script).length} 字脚本` : "脚本待填写"}</p>
                                <Button className="mt-2" disabled={locked} onClick={() => { setEditingField("script"); setSuggestionView(false); setTab("editor"); }}>编辑视频脚本</Button>
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
                            <section className="space-y-2">
                                <strong className="font-medium">关键画面{profile.firstFrameRequired ? "（当前模型首帧必填）" : "（可选）"}</strong>
                                <p className="text-xs" style={muted}>开场：{keyframe ? keyframeError ? "待确认" : "已确认" : "未准备"} · 高潮：{d.viralClimaxId ? viralKeyframeError(d, "climax") ? "待确认" : "已确认" : "未准备"}</p>
                                <Button icon={<Images size={14} />} onClick={() => showPanel("keyframe")}>准备开场 / 高潮画面</Button>
                            </section>
                            </div>
                            <div hidden={step !== 2} className="space-y-5">
                            {videoSettings}
                            <section className="space-y-2">
                                <strong className="font-medium">本次复刻核对</strong>
                                <p className="text-xs" style={reviewError ? { color: token.colorWarning } : muted}>{reviewError || `${effects.length} 项关键效果已人工核对 · ${intent.textMode === "replace" ? `画面文字替换为「${intent.text}」` : intent.textMode === "keep" ? "保留原字" : intent.textMode === "remove" ? "去除原字" : "无相关文字"}`}</p>
                                <Button size="small" disabled={locked} onClick={() => { goStep(1); setTab("plan"); }}>查看 / 修改要点</Button>
                                {d.viralClimaxId && <p className="text-xs" style={muted}>高潮图：{d.viralClimaxUse === "reference" ? "作为普通参考发送" : d.viralClimaxUse === "last" ? "作为尾帧发送" : "仅人工预览，不发送"}</p>}
                            </section>
                            {!referenceMode && <section className="space-y-2">
                                    <strong className="font-medium">已选首帧</strong>
                                    {keyframe ? <img src={keyframe.url} alt="本次首帧" className="max-h-40 w-full object-contain" /> : <p className="text-xs" style={muted}>未选择首帧</p>}
                                    <Button size="small" onClick={() => { goStep(1); setTab("keyframe"); }}>核对 / 更换首帧</Button>
                                    {mode === "first_last" && !wan && (
                                        <Select
                                            aria-label="生成尾帧"
                                            className="w-full"
                                            allowClear
                                            disabled={locked}
                                            value={d.viralClimaxUse === "last" ? d.viralClimaxId : d.viralLastFrameId}
                                            placeholder="尾帧以当前模型能力为准"
                                            onChange={(value) => wb.edit({ viralLastFrameId: value, viralClimaxUse: "preview" }, "video")}
                                            options={viralImageCandidates(d).map((m) => ({ value: m.id, label: m.name }))}
                                        />
                                    )}
                                </section>}
                            <section className="space-y-2">
                                <strong className="font-medium">本次视频模型输入</strong>
                                {materials.length ? (
                                    materials.map((m) => (
                                        <div key={m.id} className="flex items-center gap-2 text-xs">
                                            {m.kind === "image" && <img src={m.url} alt={m.name} className="h-10 w-12 object-contain" />}
                                            <span>
                                                {m.kind === "video" ? "参考视频" : viralVisualRole(m.role)} · {labels.find((l) => l.id === m.id)?.label} · {m.name}
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
                                <Alert type={d.viralUseVideo ? "info" : "warning"} title={d.viralUseVideo ? "原视频将作为动作与节奏参考" : "本次不传原视频，动作按脚本重建"} description={d.viralUseVideo ? "输入能力校验通过不代表动作与身份能精确复现，需检查成片。" : referenceMode ? "人物与场景按实际发送的参考图片生成；无法保证逐帧复制原动作。" : "场景和人物需已在首帧中体现；无法保证逐帧复制原视频动作。"} />
                            </section>
                            </div>
                            <Collapse
                                items={[
                                    {
                                        key: "advanced",
                                        label: "渠道与处理服务",
                                        children: (
                                            <div className="space-y-3">
                                                <Button disabled={locked} onClick={() => openConfig(true)}>
                                                    配置模型渠道
                                                </Button>
                                                <Button disabled={locked} onClick={() => setServiceOpen(true)}>
                                                    抽样 / 转写服务
                                                </Button>
                                                {analysisMode === "video" && <Collapse items={[{
                                                    key: "proofread", label: "口播文字校对",
                                                    children: <div className="space-y-2">
                                                        {heading("transcript", <Button size="small" disabled={locked || !reference} onClick={() => void wb.run("transcribe")}>转写参考音轨</Button>)}
                                                        {textPreview("transcript", "可单独转写并校对口播原文")}
                                                    </div>,
                                                }]} />}
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
                    <aside ref={previewPanel} className="flex min-h-0 min-w-0 flex-col rounded-lg border p-4" style={surface} aria-label="作品与说明">
                        {wb.storageError && <Alert className="mb-3" type="error" title="本地保存异常" description={wb.storageError} />}
                        {busy && (
                            <Alert
                                className="mb-3"
                                type="info"
                                showIcon
                                icon={<Spin size="small" />}
                                role="status"
                                aria-live="polite"
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
                                { key: "current", label: step === 0 ? "素材预览" : "视频对照" },
                                { key: "editor", label: "脚本与分析" },
                                ...(step === 1 ? [{ key: "plan", label: "复刻要点" }, { key: "keyframe", label: "关键画面" }] : []),
                                { key: "history", label: "本浏览器作品" },
                                { key: "guide", label: "使用说明" },
                            ]}
                        />
                        <div className={`min-h-0 flex-1 ${tab === "editor" ? "h-[65vh] min-h-96 lg:h-auto lg:min-h-0" : "overflow-y-auto"}`}>
                            {tab === "editor" && editorBody(editingField)}
                            {tab === "plan" && effectsPanel}
                            {tab === "keyframe" && keyframePanel}
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
                                                <video ref={comparisonOriginal} controls muted src={original.url} className="max-h-[55vh] w-full rounded object-contain" />
                                            ) : (
                                                <div className="flex min-h-52 items-center justify-center">
                                                    <Empty description="上传后预览原视频" />
                                                </div>
                                            )}
                                        </section>
                                        <section className="min-w-0 space-y-2">
                                            <h2 className="text-sm font-medium">{!viewed && step === 0 ? "目标素材" : viewed?.stage === "keyframe" ? viewed.viralInput?.viralImageTarget === "climax" ? "合成高潮画面" : "合成首帧" : "改编作品"}</h2>
                                            {!viewed && step === 0 ? (
                                                <div className="grid grid-cols-2 gap-3">
                                                    {d.media.filter((m) => m.kind === "image" && ["background", "model", "product"].includes(m.role)).map((m) => <figure key={m.id} className="min-w-0 space-y-1">
                                                        <img src={m.url} alt={m.name} className="h-40 w-full object-contain" />
                                                        <figcaption className="truncate text-xs" title={m.name}>{viralVisualRole(m.role)} · {m.name}</figcaption>
                                                    </figure>)}
                                                    {!d.media.some((m) => m.kind === "image") && <div className="col-span-2 flex min-h-52 items-center justify-center"><Empty description="添加场景、人物或商品图片" /></div>}
                                                </div>
                                            ) : result ? (
                                                result.mimeType.startsWith("image/") ? <img src={result.url} alt="历史关键画面" className="max-h-[55vh] w-full object-contain" /> : <video ref={comparisonResult} controls src={result.url} className="max-h-[55vh] w-full rounded object-contain" onTimeUpdate={(e) => { const player = e.currentTarget; if (Number.isFinite(player.duration) && player.duration > 0) setComparisonProgress(player.currentTime / player.duration * 100); }} onError={() => setPreviewError(true)} />
                                            ) : viewed?.text ? (
                                                <Input.TextArea aria-label="历史文案" rows={12} value={viewed.text} readOnly />
                                            ) : (
                                                <div className="flex min-h-52 items-center justify-center">
                                                    <Empty description="生成后在这里对照预览" />
                                                </div>
                                            )}
                                        </section>
                                    </div>
                                    {original && result?.mimeType.startsWith("video/") && <div className="flex items-center gap-3">
                                        <Tooltip title="按时长比例联动播放"><Button aria-label="联动播放对照视频" icon={<Play size={15} />} onClick={() => void playComparison()} /></Tooltip>
                                        <Tooltip title="暂停对照"><Button aria-label="暂停对照视频" icon={<Pause size={15} />} onClick={() => { comparisonOriginal.current?.pause(); comparisonResult.current?.pause(); }} /></Tooltip>
                                        <div className="min-w-0 flex-1"><Slider aria-label="对照进度（按时长比例）" value={comparisonProgress} onChange={seekComparison} tooltip={{ formatter: (value) => `${Math.round(value || 0)}%` }} /></div>
                                    </div>}
                                    {result?.mimeType.startsWith("video/") && resultRecord?.stage === "video" && <section className="space-y-3 border-t pt-3" style={{ borderColor: token.colorBorderSecondary }}>
                                        <div className="flex flex-wrap items-center justify-between gap-2"><strong className="font-medium">成片验收</strong><span className="text-xs" style={muted}>{acceptanceInput ? "按本次制作快照人工核对" : "该作品未保存要点快照，核对通用项目"}</span></div>
                                        {acceptanceItems.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="min-w-0 flex-1 break-words text-sm">{item.label}</span>
                                            <Select aria-label={`验收：${item.label}`} className="w-28 shrink-0" value={resultRecord.viralAcceptance?.[item.id] || "pending"} options={[{ value: "pending", label: "待检查" }, { value: "pass", label: "符合" }, { value: "fail", label: "需修改" }]} onChange={(value) => useVideoWorkbenchStore.getState().patchRecord(resultRecord.id, { viralAcceptance: { ...resultRecord.viralAcceptance, [item.id]: value } })} />
                                        </div>)}
                                        {Object.values(resultRecord.viralAcceptance || {}).includes("fail") && <Alert type="warning" title="任务已生成，复刻效果仍需修改" description="原视频和结果已保留，返回对应环节调整后再确认费用。" />}
                                        {!viewed && <Button disabled={locked} onClick={() => { goStep(1); setTab("plan"); }}>返回要点与脚本修改</Button>}
                                    </section>}
                                    {previewError && <Alert type="warning" title="当前浏览器无法播放此编码，仍可下载原文件" />}
                                    {result && (
                                        <Space wrap>
                                            <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                                下载{result.mimeType.startsWith("image/") ? "图片" : "视频"}
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
                                    <p hidden={!viewed && step === 0} className="text-xs" style={muted}>
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
                                                    {r.stage === "analyze" ? r.step === "旧稿归档" ? "历史参考分析 · 旧稿" : r.step === "其他视频分析归档" ? "历史参考分析 · 其他视频" : r.step === "编辑稿备份" ? "参考分析编辑稿" : "参考视频分析" : r.stage === "frames" ? "抽取参考画面" : r.stage === "keyframe" && r.viralInput?.viralImageTarget === "climax" ? "高潮画面合成" : stageLabels[r.stage]} · {states[r.status]}
                                                </strong>
                                                <span className="text-xs" style={muted}>
                                                    {new Date(r.createdAt).toLocaleString()}
                                                </span>
                                            </div>
                                            {r.stage === "video" && r.viralInput?.viralSettings && (
                                                <p className="text-xs" style={muted}>
                                                    {r.viralInput.viralSettings.videoModel} · {r.viralInput.viralSettings.videoSeconds}秒 · {r.viralInput.viralSettings.vquality}p
                                                </p>
                                            )}
                                            {r.stage === "analyze" && (viralRecordAnalysis(r) || r.viralInput?.viralAnalysisMode) && (
                                                <p className="break-words text-xs" style={muted}>
                                                    {viralRecordAnalysis(r) ? analysisSource(viralRecordAnalysis(r)!) : viralAnalysisNames[r.viralInput!.viralAnalysisMode!]}
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
                                                {viralRecordAnalysis(r)?.text.trim() && (
                                                    <Button size="small" disabled={locked} onClick={() => adoptAnalysis(viralRecordAnalysis(r)!, true)}>{viralRecordAnalysis(r)!.provenance.source !== viralSource(d) ? "借鉴历史分析" : "用于当前脚本"}</Button>
                                                )}
                                                {r.stage === "keyframe" && r.result && <Button size="small" disabled={locked} onClick={async () => {
                                                    try {
                                                        const file = await restoreWorkbenchFile(r.result!);
                                                        const state = useVideoWorkbenchStore.getState(), current = state.drafts["viral-recreate"];
                                                        if (state.busyTools["viral-recreate"] || current?.viralRevision !== d.viralRevision) { message.warning("草稿已变化，请重新选择首帧"); return; }
                                                        const id = crypto.randomUUID();
                                                        const climax = r.viralInput?.viralImageTarget === "climax";
                                                        wb.edit({ media: [...d.media, { ...file, id, name: climax ? "历史高潮画面" : "历史合成首帧", role: "first-frame", kind: "image" }], ...(climax ? { viralClimaxId: id, viralClimax: undefined, viralImageTarget: "climax" } : { viralFirstFrameId: id, viralKeyframe: undefined, viralImageTarget: "opening" }) }, "video");
                                                        goStep(1);
                                                        setTab("keyframe");
                                                    } catch (error) { message.error(error instanceof Error ? error.message : "首帧读取失败"); }
                                                }}>使用这张{r.viralInput?.viralImageTarget === "climax" ? "高潮画面" : "首帧"}</Button>}
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
                                                        onClick={() => {
                                                            let predictionId = "";
                                                            modal.confirm({
                                                                title: "核对并关联已有平台任务",
                                                                content: <Input aria-label="Replicate 上游任务编号" placeholder="Replicate 上游任务编号" onChange={(event) => { predictionId = event.target.value.trim(); }} />,
                                                                okText: "核对关联",
                                                                cancelText: "取消",
                                                                onOk: async () => {
                                                                    try {
                                                                        if (!predictionId) throw new Error("请填写已在 Replicate 核对的任务编号");
                                                                        if (useUserStore.getState().token !== session) throw new Error("登录状态已变化，请重新操作");
                                                                        await reconcileReplicateTask(r.replicateTask!.id, predictionId);
                                                                        message.success("已核对原任务，可恢复查询取得结果");
                                                                    } catch (error) {
                                                                        message.error(publicServiceText(error instanceof Error ? error.message : "关联失败"));
                                                                        throw error;
                                                                    }
                                                                },
                                                            });
                                                        }}
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
                                    <p>视频与音轨分析将参考视频发送到所选模型渠道；抽样画面分析只发送图片和已提供的转写文字。两种分析的时间与镜头边界都需核对。</p>
                                    <p>第 1 步添加参考视频、场景、人物及可选商品，填写主体资料，选择保留内容、替换素材与文字处理。第 2 步先确认规格和原视频分析，再列出关键效果，生成或编辑脚本，填写要点对应位置并人工确认。</p>
                                    <p>在「关键画面」分别准备开场与高潮。高潮图可仅作人工预览；模型支持时可明确选择普通参考或尾帧，普通参考不能锁定某一时刻。图片合成与视频分别计费。</p>
                                    <p>第 3 步核对实际输入与费用。首帧驱动只接收已选画面，多素材与原视频参考按当前模型已配置的能力发送；没有发送原视频时，动作依照文字重建，不能保证逐帧复现。</p>
                                    <p>两种分析分别保存，未人工编辑的新结果自动用于后续改编；人工编辑稿在替换前保留到历史。更换视频后，其他视频的分析归入本浏览器作品；主动借鉴时须核对原视频与当前视频，不代表已分析当前视频。同一视频改变抽样参数后可确认沿用。手写脚本和合规首帧可直接生成，不依赖抽样或Whisper服务。</p>
                                    <p>分析、脚本、关键画面与视频分别确认费用；停止等待不等于取消平台任务。恢复查询只查原任务，不再次提交收费任务。成片验收按制作时的要点快照保存，联动对照按时长比例播放，不代表镜头已自动对齐。</p>
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
            <Modal title="从已采用分析添加要点" width={760} open={effectSourceOpen} onCancel={() => setEffectSourceOpen(false)} footer={<Space><Button onClick={() => setEffectSourceOpen(false)}>取消</Button><Button type="primary" disabled={locked || !effectSelection.trim() || Boolean(adoptedError)} onClick={() => { addEffect(effectSelection.trim()); setEffectSourceOpen(false); }}>添加要点</Button></Space>}>
                <div className="space-y-3">
                    <p className="text-sm" style={muted}>参考原分析填写需要保留的动作或效果，也可选中原文后修改。</p>
                    <Input.TextArea aria-label="选择分析中的关键效果" readOnly value={d.analysis} rows={14} onSelect={(e) => captureEffectSelection(e.target as HTMLTextAreaElement)} onMouseUp={(e) => captureEffectSelection(e.currentTarget)} onKeyUp={(e) => captureEffectSelection(e.currentTarget)} />
                    <label className="block space-y-2 text-sm"><span>要点内容</span><Input.TextArea aria-label="待添加的关键效果" value={effectSelection} autoSize={{ minRows: 2, maxRows: 6 }} placeholder="具体动作、展开形态、高潮展示或物体文字" onChange={(e) => setEffectSelection(e.target.value)} /></label>
                </div>
            </Modal>
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
