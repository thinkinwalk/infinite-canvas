import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Checkbox, Collapse, ConfigProvider, Dropdown, Empty, Input, InputNumber, Mentions, Modal, Segmented, Select, Slider, Space, Spin, Steps, Switch, Tabs, Tooltip, Upload, theme } from "antd";
import { ArrowLeft, ArrowRight, Check, Columns2, Copy, Download, Expand, FolderPlus, Grid2X2, Images, MoreHorizontal, Pause, Play, Plus, RefreshCw, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { FeatureModelPicker } from "@/components/feature-model-picker";
import { VideoLinkImport } from "@/components/video-link-import";
import { VideoReferenceRetention } from "@/components/video-reference-retention";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useCopyText } from "@/hooks/use-copy-text";
import { computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { formatBytes } from "@/lib/image-utils";
import { hasViralTaskContent, viralTaskDraft, viralTaskGroups } from "@/lib/viral-task";
import { materialMentionError, supportedVideoInputModes, videoInputMode, videoProfile } from "@/lib/video-capabilities";
import { VideoModelOption } from "@/components/video-model-option";
import { publicServiceText, REPLICATE_VIDEO_MODEL, isReplicateVideoModel, reconcileReplicateTask } from "@/services/api/replicate";
import { getWorkerCapabilities, workbenchMediaBlob } from "@/services/api/video-worker";
import type { VideoPrice } from "@/services/api/video";
import { VIDEO_ANALYSIS_FEATURE, videoAnalysisAvailable } from "@/services/api/video-understanding";
import { imageToDataUrl } from "@/services/image-storage";
import { configForFeature, modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { StoreVideoSettings, VideoRecord, ViralAnalysisMode, ViralAnalysisVersion, ViralEffect, ViralIntent } from "@/types/video-workbench";
import { useVideoCreationConfig } from "@/hooks/use-video-creation-config";
import { normalizeStoreSettings, storeVideoSettings } from "./store-explore-request";
import { viralAnalysisMode, viralFrameMaterials, viralImageCandidates, viralInput, viralMaterialLabels, viralReference, viralSource, viralVideoConfig, viralVideoError, viralVideoMaterials } from "./viral-recreate-request";
import { viralAdoptAnalysis, viralAdoptedAnalysisError, viralAnalysisInputKey, viralAnalysisIsCurrent, viralAnalysisNames, viralAnalysisNeedsProtection, viralAnalysisProvenance, viralCurrentAnalysis, viralEditAnalysis, viralForeignAnalysisRecovery, viralLegacyAnalysisRecovery, viralRecordAnalysis } from "./viral-analysis";
import { viralEvidence, viralEvidenceError, viralVisibleAnalysis } from "./viral-evidence";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";
import { viralKeyframeError, viralKeyframeInputKey, viralKeyframeMaterials, viralVisualRole } from "./viral-keyframe";
import { viralEffectsSource, viralIntent, viralIntentError, viralPlanEffects, viralPreserveOptions, viralReferenceImages, viralRequirements } from "./viral-plan";
import ViralScriptComparison from "./viral-script-comparison";

type Role = "reference" | "visual-reference" | "product" | "background" | "model" | "first-frame";
type Editor = "analysis" | "transcript" | "viralProductAnalysis" | "instructions" | "script";
const editorNames: Record<Editor, string> = { analysis: "原视频结构分析", transcript: "参考音轨文字", viralProductAnalysis: "参考图片分析", instructions: "复刻要求", script: "改编视频脚本" };
const suggestionFields = {
    viralProductAnalysis: { key: "viralProductSuggestion", stale: "viralProductStale" },
    script: { key: "viralScriptSuggestion", stale: "viralScriptStale" },
} as const;
const suggestionInfo = (field: Editor) => (field === "viralProductAnalysis" || field === "script" ? suggestionFields[field] : undefined);
const states = { running: "处理中", completed: "已完成", interrupted: "查询暂停", failed: "失败" };
let resumeReloadedTask = window.location.pathname === "/video/viral-recreate" && (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";

export default function ViralRecreateWorkspace() {
    const hydrated = useVideoWorkbenchStore((state) => state.hydrated);
    const taskId = useVideoWorkbenchStore((state) => state.drafts["viral-recreate"]?.viralTaskId);
    const initialized = useRef(false), [ready, setReady] = useState(false);
    const { message } = App.useApp();
    useEffect(() => {
        if (!hydrated || initialized.current) return;
        initialized.current = true;
        const state = useVideoWorkbenchStore.getState(), resume = resumeReloadedTask;
        resumeReloadedTask = false;
        if (state.storageError || state.busyTools["viral-recreate"] || resume) {
            if (!state.storageError && !state.drafts["viral-recreate"]?.viralTaskId) state.patchDraft("viral-recreate", { viralTaskId: crypto.randomUUID() });
            setReady(true);
            return;
        }
        void state.openViralTask().catch((error) => message.error(error instanceof Error ? error.message : "任务初始化失败")).finally(() => setReady(true));
    }, [hydrated]);
    return ready ? <ViralTaskWorkspace key={taskId} /> : <div className="p-12 text-center"><Spin /></div>;
}

function ViralTaskWorkspace() {
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
    const [imagesOpen, setImagesOpen] = useState(false);
    const [assetRole, setAssetRole] = useState<Role | null>(null),
        [editor, setEditor] = useState<Editor | null>(null),
        [editingField, setEditingField] = useState<Editor>("script"),
        [showCurrentAnalysis, setShowCurrentAnalysis] = useState(false),
        [suggestionView, setSuggestionView] = useState(false),
        [settingsOpen, setSettingsOpen] = useState(false),
        [optionsOpen, setOptionsOpen] = useState(false),
        [serviceOpen, setServiceOpen] = useState(false);
    const [serviceStatus, setServiceStatus] = useState(""),
        [checking, setChecking] = useState(false),
        [refreshing, setRefreshing] = useState(false);
    const [tab, setTab] = useState("current"),
        [viewed, setViewed] = useState<VideoRecord | null>(null),
        [previewError, setPreviewError] = useState(false);
    const [effectSourceOpen, setEffectSourceOpen] = useState(false), [effectSelection, setEffectSelection] = useState("");
    const [comparison, setComparison] = useState<{ kind: "source" | "revision"; target: "script" | "suggestion" } | null>(null);
    const [comparisonProgress, setComparisonProgress] = useState(0);
    const comparisonOriginal = useRef<HTMLVideoElement | null>(null), comparisonResult = useRef<HTMLVideoElement | null>(null);
    const completedStage = useRef<string | undefined>(undefined);
    const [price, setPrice] = useState<{ key: string; value: VideoPrice } | null>(null),
        [priceError, setPriceError] = useState(""),
        [quoting, setQuoting] = useState(false),
        quoteController = useRef<AbortController | null>(null);
    const legacyAnalysisRecovered = useRef(false);
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
        if (value === 1) { setEditingField("script"); setShowCurrentAnalysis(Boolean(d.analysis.trim())); setSuggestionView(false); }
    };
    const keyframe = viralImageCandidates(d).find((m) => m.id === d.viralFirstFrameId),
        keyframeError = viralKeyframeError(d),
        keyframeConfig = configForFeature(config, "image.edit", "image");
    const imageTarget = d.viralImageTarget || "opening", climaxTarget = imageTarget === "climax";
    const selectedImage = climaxTarget ? viralImageCandidates(d).find((m) => m.id === d.viralClimaxId) : keyframe;
    const selectedImageError = viralKeyframeError(d, imageTarget), imageName = climaxTarget ? "补充画面" : "首帧";
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
    const intent = viralIntent(d), effects = viralPlanEffects(d), intentError = viralIntentError(d);
    const referenceImages = viralReferenceImages(d),
        targetImages = d.media.filter((m) => m.kind === "image" && ["visual-reference", "background", "model", "product"].includes(m.role));
    const sourceRatio = reference?.width && reference?.height ? inferVideoRatio(`${reference.width}x${reference.height}`) : "";
    const sourceEffectsChanged = Boolean(d.viralEffects?.length && d.viralEffectsSource !== viralEffectsSource(d));
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask || r.workerJob));
    const taskGroups = viralTaskGroups(wb.records);
    const active = wb.records.find((r) => r.id === d.activeRecord),
        blocked = viralVideoError(d, cfg) || (pending ? "已有任务可恢复，请先查询或确认原任务状态" : "");
    const modelBlocked = (featureId: string, name: string) => {
        const scoped = configForFeature(config, featureId, "text");
        return config.channelMode === "remote" && !session ? `登录后使用${name}` : !scoped.textModel || !useConfigStore.getState().isAiConfigReady(scoped, scoped.textModel) ? `请配置${name}` : "";
    };
    const textBlocked = modelBlocked("viral-recreate.script", "脚本模型"),
        productBlocked = modelBlocked("viral-recreate.analyze", "图片分析模型");
    const analysisMode = viralAnalysisMode(d, config),
        nativeAnalysis = videoAnalysisAvailable(config),
        analysisBlocked = analysisMode === "video" ? !session ? "登录后分析参考视频" : !nativeAnalysis ? "视频与音轨分析暂不可用，请重新选择模型或改用抽样分析" : "" : modelBlocked("viral-recreate.analyze", "抽样分析模型");
    const analysisConfig = configForFeature(config, analysisMode === "video" ? VIDEO_ANALYSIS_FEATURE : "viral-recreate.analyze", "text");
    const analysisResult = d.viralAnalyses?.[analysisMode],
        analysisStale = Boolean(analysisResult && analysisResult.provenance.inputKey !== viralAnalysisInputKey(d, analysisMode)),
        adoptedError = viralAdoptedAnalysisError(d),
        scriptBlocked = adoptedError || (!d.analysis.trim() && Object.values(d.viralAnalyses || {}).some((result) => result?.text.trim() && result.provenance.source === viralSource(d)) ? "请先采用一份当前视频的分析" : ""),
        scriptWritingBlocked = scriptBlocked || viralIntentError(d) || (reference && !d.analysis.trim() ? "请先分析当前视频，再由 AI 撰写改编脚本；也可直接手写脚本" : "");
    const failedAnalysis = active?.stage === "analyze" && active.viralInput?.viralAnalysisMode === analysisMode && viralSource({ ...d, media: active.viralInput.media }) === viralSource(d) && ["failed", "interrupted"].includes(active.status) && !busy;
    const currentAnalysis = viralCurrentAnalysis(d),
        editorAnalysis = showCurrentAnalysis ? currentAnalysis : analysisResult,
        viewedAnalysis = viewed && viralRecordAnalysis(viewed);
    const fieldValue = (field: Editor) => field === "analysis" ? viralVisibleAnalysis(editorAnalysis?.text || "") : field === "instructions" ? viralRequirements(d) : d[field] || "";
    const suggestedValue = (field: Editor) => field === "analysis" ? !showCurrentAnalysis ? viralVisibleAnalysis(analysisResult?.suggestion?.text || "") : "" : suggestionInfo(field) ? d[suggestionInfo(field)!.key] || "" : "";
    const historicalReference = Boolean(d.analysis.trim() && d.viralAdoptedAnalysis && d.viralAdoptedAnalysis.provenance.source !== viralSource(d));
    const referenceStatus = d.analysis.trim()
        ? adoptedError ? "分析依据已变化" : historicalReference ? `历史借鉴 · ${d.viralAdoptedAnalysis!.provenance.sourceName}` : `已采用当前视频分析 · ${d.viralAdoptedAnalysis?.provenance.modelLabel || "来源未确认"}${d.viralAdoptedAnalysis?.provenance.edited ? "（已编辑）" : ""}`
        : "当前视频分析 · 未采用";
    const invalidMentions = materialMentionError(`${viralRequirements(d)}\n${d.script}`, labels);
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
    const original = viewed ? viralReference({ ...d, media: viewed.viralDraft?.media || viewed.viralInput?.media || [] }) : reference;
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
        if (foreign && recovery.patch.analysis === "" && step === 1) { setEditingField("script"); setTab("editor"); }
        if (versions.length) message.info(foreign ? "其他视频的分析已归入历史任务，请分析当前视频" : "旧参考分析已归入历史任务");
    }, [wb.hydrated, wb.storageError, locked, d.analysis, d.viralAdoptedAnalysis, d.viralAnalyses, reference?.id, reference?.storageKey]);
    useEffect(() => {
        quoteController.current?.abort();
        setQuoting(false);
        setPriceError("");
        return () => quoteController.current?.abort();
    }, [priceKey]);
    useEffect(() => setPreviewError(false), [result?.storageKey, result?.url]);
    useEffect(() => setComparison(null), [reference?.id, reference?.storageKey, d.analysis, d.viralAdoptedAnalysis]);
    useEffect(() => {
        if (comparison?.target === "suggestion" && !d.viralScriptSuggestion) setComparison(null);
    }, [comparison?.target, d.viralScriptSuggestion]);
    useEffect(() => {
        inputScroll.current?.scrollTo(0, 0);
        workspaceScroll.current?.scrollTo(0, 0);
    }, [step]);
    useEffect(() => {
        if (wb.hydrated && step === 1) { setTab("editor"); setEditingField("script"); setShowCurrentAnalysis(Boolean(d.analysis.trim())); }
    }, [wb.hydrated]);
    useEffect(() => {
        if (busy) { completedStage.current = active?.id; return; }
        if (!active || active.status !== "completed" || completedStage.current !== active.id) return;
        completedStage.current = undefined;
        if (viewed) return;
        if (active.stage === "analyze") {
            if (step === 0) {
                setShowCurrentAnalysis(Boolean(analysisResult && viralAnalysisIsCurrent(d, analysisResult) && !analysisResult.suggestion));
                setSuggestionView(Boolean(analysisResult?.suggestion));
                setEditingField("analysis");
                showPanel("editor");
            }
            return;
        }
        if (step !== 1) return;
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
    const changeEffect = (id: string, value: Partial<ViralEffect>) => wb.edit({ viralEffects: effects.map((effect) => effect.id === id ? { ...effect, ...value } : effect), viralEffectsSource: viralEffectsSource(d) }, "script");
    const captureEffectSelection = (input: HTMLTextAreaElement) => setEffectSelection(input.value.slice(input.selectionStart, input.selectionEnd));
    const addEffect = (description = "") => wb.edit({
        viralEffects: [...effects, { id: crypto.randomUUID(), time: "", description, action: "keep", target: "", scriptRange: "" }],
        viralNoEffects: false, viralEffectsSource: viralEffectsSource(d),
    }, "script");
    const seekComparison = (progress: number) => {
        for (const player of [comparisonOriginal.current, comparisonResult.current]) if (player && Number.isFinite(player.duration)) player.currentTime = player.duration * progress / 100;
        setComparisonProgress(progress);
    };
    const playComparison = async () => {
        const source = comparisonOriginal.current, target = comparisonResult.current;
        if (!source || !target || !Number.isFinite(source.duration) || !Number.isFinite(target.duration) || source.duration <= 0 || target.duration <= 0) { message.info("请等待两段视频加载后再对照"); return; }
        try {
            // 先处理成片重播，避免按旧的结尾进度把原片也定位到结尾。
            if (target.ended || target.currentTime >= target.duration) target.currentTime = 0;
            source.currentTime = source.duration * target.currentTime / target.duration;
            source.playbackRate = source.duration / target.duration;
            setComparisonProgress(target.currentTime / target.duration * 100);
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
        if (field === "instructions") {
            wb.edit({ instructions: value, ...(d.viralFacts ? { viralFacts: "" } : {}), ...(d.viralBrief ? { viralBrief: undefined } : {}) }, "script");
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
            field === "script" ? "video" : "script",
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
                step: "编辑稿备份", text: version.text, viralTaskId: d.viralTaskId, viralInput: viralInput(d, cfg),
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
        return `${p.source !== viralSource(d) ? "其他视频 · " : ""}${viralAnalysisNames[p.mode]} · ${p.modelLabel}${p.edited ? "（已编辑）" : ""}${p.reviewOf !== undefined ? " · 模型复核建议" : ""} · ${p.sourceName}${p.mode === "frames" && p.model ? ` · ${p.frameCount || 0} 张画面 · ${p.usesTranscript ? "采用音轨文字" : "未采用音轨文字"}` : ""}${p.createdAt ? ` · ${new Date(p.createdAt).toLocaleString()}` : ""}`;
    };
    const frameGallery = (
        <div className="grid grid-cols-3 gap-2">
            {frames.map((f, i) => (
                <button key={f.id} type="button" aria-label={`预览抽样画面${i + 1}`} onClick={() => {
                    if (comparisonOriginal.current && Number.isFinite(d.viralFrameTimes?.[i])) comparisonOriginal.current.currentTime = d.viralFrameTimes![i];
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
        const matches = (m: (typeof d.media)[number]) => role === "visual-reference" ? ["visual-reference", "product", "background"].includes(m.role) : m.role === role;
        const selected = d.media.some(matches);
        const upload = (
            <div className="space-y-2">
                <Upload.Dragger
                    height={role === "reference" ? 96 : 72}
                    accept={role === "reference" ? "video/*" : "image/*"}
                    multiple={role === "visual-reference" || role === "product" || role === "model"}
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
                    {d.media.filter(matches).length} {role === "reference" ? "个" : "张"}
                </span>
            </div>
            <div className={role === "reference" ? "space-y-2" : "grid grid-cols-1 gap-2 sm:grid-cols-2"}>
                {d.media
                    .filter(matches)
                    .map((m) => (
                        <div key={m.id} className={`min-w-0 rounded-lg border p-2 ${m.kind === "video" ? "flex items-center gap-3" : ""}`} style={{ borderColor: token.colorBorderSecondary }}>
                            {m.kind === "video" ? (
                                <button type="button" className="relative h-16 w-16 shrink-0" aria-label={`预览${m.name}`} onClick={() => showPanel("current")}>
                                    <video preload="metadata" muted playsInline src={m.url} className="h-full w-full rounded object-contain" />
                                    <span className="absolute bottom-0 right-0 rounded p-1" style={surface}><Play size={13} /></span>
                                </button>
                            ) : (
                                <button type="button" className="w-full" aria-label={`预览${m.name}`} onClick={() => modal.info({ title: m.name, width: 800, content: <img src={m.url} alt={m.name} className="max-h-[65vh] w-full object-contain" /> })}>
                                    <img src={m.url} alt={m.name} className="h-24 w-full object-contain" />
                                </button>
                            )}
                            <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1">
                                <span className="min-w-0 flex-1 truncate text-xs" title={m.name}>
                                    {labels.find((l) => l.id === m.id)?.label} · {m.name}
                                </span>
                                <Button type="text" size="small" aria-label={`移除${m.name}`} disabled={locked} icon={<X size={13} />} onClick={() => wb.removeMedia(m.id)} />
                            </div>
                            <div className="text-xs" style={muted}>
                                {formatBytes(m.bytes)}
                                {m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(1)}秒` : ""}
                                {m.kind === "video" && m.width && m.height ? ` · ${m.width} × ${m.height}` : ""}
                            </div>
                            {role === "visual-reference" && <Select size="small" className="mt-1 w-full" aria-label={`${m.name}用途`} disabled={locked} value={m.role} options={[{ value: "visual-reference", label: "自动识别用途" }, { value: "product", label: "目标商品" }, { value: "background", label: "目标场景" }]} onChange={(value) => {
                                const media = d.media.map((item) => item.id === m.id ? { ...item, role: value as Role } : item);
                                wb.edit({ media, ...(d.viralIntent ? { viralIntent: { ...intent, replacements: [...new Set([...intent.replacements.filter((item) => media.some((image) => image.role === item)), ...(value === "product" || value === "background" ? [value as "product" | "background"] : [])])] } } : {}) }, "materials");
                            }} />}
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
        const targetStep = ["analysis", "transcript"].includes(field) ? 0 : 1;
        if (step !== targetStep) goStep(targetStep);
        setViewed(null);
        setEditingField(field);
        setSuggestionView(showSuggestion);
        setTab("editor");
    };
    const textPreview = (field: Editor, placeholder: string) => ["instructions", "script"].includes(field) ? (
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
            <Space size={4} wrap className="max-w-full">
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
                    {field === "script" ? "保留已采用稿" : "保留原稿"}
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
                <Input.TextArea aria-label="历史参考分析" value={viralVisibleAnalysis(viewedAnalysis.text)} readOnly style={{ flex: 1, minHeight: 0, resize: "none", fontSize: 16 }} />
            </div>
        );
        const info = suggestionInfo(field),
            suggested = suggestedValue(field),
            viewingSuggestion = suggestionView && Boolean(suggested),
            value = viewingSuggestion ? suggested : fieldValue(field),
            evidenceError = field === "analysis" ? viralEvidenceError(value) : "",
            inputStyle = { height: "100%", fontSize: 16, lineHeight: 1.8, padding: 16, resize: "none" as const },
            disabled = locked || (field === "transcript" && !reference);
        return (
            <div className="flex h-full min-h-0 flex-col gap-3" data-testid={fullscreen ? "viral-fullscreen-editor" : "viral-document-editor"}>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-medium">{editorNames[field]}</h2>
                    <Space wrap>
                        {field === "script" && <Button size="small" icon={<Columns2 size={14} />} onClick={() => setComparison({ kind: "source", target: viewingSuggestion ? "suggestion" : "script" })}>对照原片</Button>}
                        {field === "transcript" && <Button size="small" disabled={locked || !reference} onClick={() => void wb.run("transcribe")}>转写参考音轨</Button>}
                        {field === "script" && d.script.trim() && !viewingSuggestion && <Button size="small" disabled={locked || Boolean(textBlocked || scriptWritingBlocked)} icon={<Sparkles size={14} />} onClick={() => void wb.run("script")}>重新生成</Button>}
                        <Tooltip title="复制全文"><Button type="text" aria-label="复制全文" icon={<Copy size={15} />} disabled={!value} onClick={() => copyText(value, "文案已复制")} /></Tooltip>
                        {!fullscreen && (
                            <Tooltip title="全屏编辑"><Button type="text" aria-label="全屏编辑" icon={<Expand size={15} />} onClick={() => setEditor(field)} /></Tooltip>
                        )}
                    </Space>
                </div>
                {reference && field === "analysis" && (
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
                        {evidenceError && <Alert type="warning" title={evidenceError} />}
                        {showCurrentAnalysis && adoptedError && <Alert type="warning" title={adoptedError} />}
                        {showCurrentAnalysis && historicalReference && !adoptedError && <Alert type="warning" title="正在借鉴其他视频的历史分析" description={`原视频：${d.viralAdoptedAnalysis!.provenance.sourceName}。这份内容不是当前视频的分析结果。`} />}
                        {showCurrentAnalysis && d.viralAdoptedAnalysis && !adoptedError && d.viralAdoptedAnalysis.inputKey !== d.viralAdoptedAnalysis.provenance.inputKey && <p className="text-xs" style={muted}>已确认沿用原分析，未重新分析当前输入</p>}
                        {showCurrentAnalysis && analysisResult?.suggestion && <Button onClick={() => { setShowCurrentAnalysis(false); setSuggestionView(true); }}>查看新分析建议</Button>}
                        {!showCurrentAnalysis && analysisStale && !viewingSuggestion && <Alert type="warning" title="分析依据已变化，原稿已保留" />}
                        {!value.trim() && !busy && <p className="text-xs" style={muted}>{reference ? "当前视频尚未分析" : "请先添加参考视频"}</p>}
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
                {info && d[info.stale] && fieldValue(field) && <Alert type="warning" title="输入已变化，原稿已保留；请核对或更新" action={field === "script" && !viewingSuggestion ? <Button size="small" disabled={locked} onClick={() => wb.edit({ viralScriptStale: false }, "video")}>确认沿用当前脚本</Button> : undefined} />}
                {suggested && (
                    <div className="shrink-0">
                        <Tabs
                            className="shrink-0"
                            activeKey={viewingSuggestion ? "suggestion" : "draft"}
                            onChange={(key) => setSuggestionView(key === "suggestion")}
                            items={[
                                { key: "draft", label: field === "script" ? "已采用脚本" : "当前原稿" },
                                { key: "suggestion", label: "新建议（待采用）" },
                            ]}
                        />
                        {field === "script" && <Button type="link" size="small" className="!px-0" icon={<Columns2 size={14} />} onClick={() => setComparison({ kind: "revision", target: "suggestion" })}>查看本次修改</Button>}
                    </div>
                )}
                <div className="min-h-0 flex-1">
                    {!viewingSuggestion && (field === "script" || field === "instructions") ? (
                        <Mentions
                            aria-label={`编辑${editorNames[field]}`}
                            value={value}
                            disabled={disabled}
                            options={labels.map((l) => ({ value: l.label, label: `${l.label} · ${l.name}` }))}
                            onChange={(next) => edit(field, next)}
                            placeholder={field === "script" ? reference && !d.analysis.trim() ? "尚未生成脚本。分析原视频后可由 AI 撰写，也可直接填写自己的镜头、画面与台词。" : "填写镜头顺序、画面与台词，或由 AI 撰写改编脚本。" : "填写复刻要求"}
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
            return;
        }
        try {
            const media = await Promise.all((r.viralDraft?.media || r.viralInput?.media || []).map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
            setViewed({ ...r, ...(r.viralInput ? { viralInput: { ...r.viralInput, media } } : {}), ...(r.viralDraft ? { viralDraft: { ...r.viralDraft, media } } : {}), ...(r.result ? { result: await restoreWorkbenchFile(r.result) } : {}) });
            setTab("current");
        } catch (e) {
            message.error(e instanceof Error ? e.message : "作品读取失败");
        }
    };
    const restoreInput = (r: VideoRecord) => {
        const input = viralTaskDraft(r);
        if (!input) return;
        const restore = async () => {
            try {
                const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) }))),
                    frames = await Promise.all(input.frames.map(restoreWorkbenchFile));
                const outputs = input.video ? { video: await restoreWorkbenchFile(input.video) } : {};
                const state = useVideoWorkbenchStore.getState();
                if (state.busyTools["viral-recreate"] || state.drafts["viral-recreate"]?.viralRevision !== d.viralRevision) {
                    message.warning("草稿已变化，请重新选择历史记录");
                    return;
                }
                await state.openViralTask({ ...input, ...outputs, media, frames });
                setViewed(null);
                setTab(input.viralStep === 1 ? "editor" : "current");
                setEditingField("script");
                setShowCurrentAnalysis(Boolean(input.analysis.trim()));
                setSuggestionView(false);
                setImagesOpen(false);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "任务恢复失败");
            }
        };
        if (hasViralTaskContent(d)) modal.confirm({
            title: "继续这条历史任务？",
            content: "当前内容会先保存到历史任务，再恢复所选任务的素材、脚本与进度。",
            okText: "继续任务", cancelText: "取消", onOk: restore,
        });
        else void restore();
    };
    const newTask = () => {
        const create = () => useVideoWorkbenchStore.getState().openViralTask();
        if (hasViralTaskContent(d)) modal.confirm({
            title: "新建任务？", content: "当前内容会保存到历史任务，可随时继续。",
            okText: "新建任务", cancelText: "取消", onOk: create,
        });
        else void create().catch((error) => message.error(error instanceof Error ? error.message : "新建任务失败"));
    };
    const spec = `${cloud ? "跟随首帧 / 平台默认" : inferVideoRatio(cfg.size)} · ${wan ? "约 " : ""}${cfg.videoSeconds}秒 · ${cfg.vquality}p`;
    const intentFields = <div className="space-y-3">
        <div className="space-y-2 text-sm">
            <span>重点保留原片</span>
            <Checkbox.Group className="flex flex-wrap gap-2" disabled={locked} value={intent.preserve} options={[...new Set([...viralPreserveOptions, ...intent.preserve])]} onChange={(preserve) => changeIntent({ preserve: preserve as string[] })} />
        </div>
        <div className="space-y-2 text-sm">
            <span>使用目标图片替换</span>
            <Checkbox.Group disabled={locked} value={intent.replacements} options={[{ value: "model", label: "人物" }, { value: "background", label: "场景" }, { value: "product", label: "商品" }]} onChange={(replacements) => changeIntent({ replacements: replacements as ViralIntent["replacements"] })} />
        </div>
        <label className="block space-y-2 text-sm">
            <span>画面文字</span>
            <Select aria-label="原片画面文字处理" className="w-full" disabled={locked} value={intent.textMode} options={[{ value: "pending", label: "自动跟随原片与复刻要求" }, { value: "keep", label: "保留原字" }, { value: "replace", label: "替换准确字样" }, { value: "remove", label: "去除文字" }, { value: "none", label: "无相关文字" }]} onChange={(textMode) => changeIntent({ textMode })} />
        </label>
        {intent.textMode === "replace" && <>
            <Input aria-label="准确替换字样" disabled={locked} value={intent.text} placeholder="需要替换的准确文字" onChange={(e) => changeIntent({ text: e.target.value })} />
            <Input.TextArea aria-label="文字承载位置与时机" disabled={locked} value={intent.textSurface} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="位置与时机（可选，默认跟随原片）" onChange={(e) => changeIntent({ textSurface: e.target.value })} />
        </>}
        {viralIntentError(d) && <p className="text-xs" style={{ color: token.colorWarning }}>{viralIntentError(d)}</p>}
    </div>;
    const effectsPanel = (
        <div className="space-y-4" data-testid="viral-effects-panel">
            {intentFields}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-medium">复刻要点（可选调整）</strong>
                <Space wrap>
                    <Button disabled={locked || !d.analysis.trim() || Boolean(adoptedError)} onClick={() => { setEffectSelection(""); setEffectSourceOpen(true); }}>从分析补充</Button>
                    <Tooltip title="添加复刻要点"><Button aria-label="添加复刻要点" icon={<Plus size={15} />} disabled={locked} onClick={() => addEffect()} /></Tooltip>
                </Space>
            </div>
            {sourceEffectsChanged && <Collapse items={[{ key: "previous-effects", label: "之前的自定义要点（已保留，未用于当前分析）", children: <div className="space-y-2">
                {d.viralEffects?.map((effect) => <p key={effect.id} className="break-words text-sm">{effect.description}{effect.target ? ` → ${effect.target}` : ""}</p>)}
                <Button disabled={locked || Boolean(adoptedError)} onClick={() => wb.edit({ viralEffectsSource: viralEffectsSource(d) }, "script")}>沿用这些自定义要点</Button>
            </div> }]} />}
            {!effects.length && <p className="text-sm" style={muted}>脚本将采用完整原片分析，无需另填要点。</p>}
            {effects.map((effect, index) => <section key={effect.id} className="space-y-2 border-b pb-4" style={{ borderColor: token.colorBorderSecondary }}>
                <div className="flex items-center justify-between">
                    <strong className="text-sm">要点 {index + 1}</strong>
                    <Tooltip title="移除此要点"><Button aria-label={`移除要点${index + 1}`} type="text" size="small" disabled={locked} icon={<X size={14} />} onClick={() => wb.edit({ viralEffects: effects.filter((item) => item.id !== effect.id), viralEffectsSource: viralEffectsSource(d) }, "script")} /></Tooltip>
                </div>
                <label className="block space-y-1 text-xs"><span>原片时间（估计）</span><Input aria-label={`要点${index + 1}原片时间`} value={effect.time} disabled={locked} placeholder="例如 00:01–00:02" onChange={(e) => changeEffect(effect.id, { time: e.target.value })} /></label>
                <label className="block space-y-1 text-xs"><span>原片要点</span><Input.TextArea aria-label={`要点${index + 1}内容`} autoSize={{ minRows: 2, maxRows: 6 }} value={effect.description} disabled={locked} placeholder="需要保留或改编的内容、镜头或表现特点" onChange={(e) => changeEffect(effect.id, { description: e.target.value })} /></label>
                <Segmented block aria-label={`要点${index + 1}处理`} value={effect.action} disabled={locked} options={[{ value: "keep", label: "保留" }, { value: "replace", label: "改编" }, { value: "remove", label: "删除效果" }]} onChange={(value) => changeEffect(effect.id, { action: value as ViralEffect["action"] })} />
                {effect.action === "replace" && <Input.TextArea aria-label={`要点${index + 1}改编内容`} value={effect.target} disabled={locked} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="改成什么，需要保留哪些特点" onChange={(e) => changeEffect(effect.id, { target: e.target.value })} />}
            </section>)}
        </div>
    );
    const analysisOptions = <div className="space-y-3">
        <Segmented
            block aria-label="参考视频分析方式" disabled={locked} value={analysisMode}
            options={[{ value: "video", label: "视频与音轨" }, { value: "frames", label: "抽样画面" }]}
            onChange={(value) => changeAnalysisMode(value as ViralAnalysisMode)}
        />
        {modelPicker(analysisMode === "video" ? VIDEO_ANALYSIS_FEATURE : "viral-recreate.analyze", "分析模型")}
        {analysisBlocked && <p role="alert" className="text-xs" style={{ color: token.colorWarning }}>{analysisBlocked}</p>}
        {analysisMode === "frames" && <div className="space-y-3">
            <label className="flex flex-wrap items-center gap-2 text-sm">
                抽样数量
                <InputNumber aria-label="抽样数量" min={1} precision={0} disabled={locked} value={d.frameCount} onChange={(value) => wb.edit({ frameCount: value || 1 }, "materials")} />
            </label>
            <label className="flex items-center gap-2 text-sm">
                <Switch aria-label="使用音轨文字" disabled={locked} checked={Boolean(d.viralUseTranscript)} onChange={(viralUseTranscript) => wb.edit({ viralUseTranscript })} />
                使用音轨文字
            </label>
            {d.viralUseTranscript && <Button size="small" onClick={() => openEditor("transcript")}>查看 / 校对音轨文字</Button>}
            <Button size="small" disabled={locked || !reference} icon={<Images size={13} />} onClick={() => void wb.run("frames")}>{frames.length ? "重新抽取画面" : "预览抽样画面"}</Button>
            {frameGallery}
            <p className="text-xs" style={muted}>抽样、转写按处理服务账单计费，模型分析单独确认费用。</p>
        </div>}
    </div>;
    const openAnalysis = () => {
        setShowCurrentAnalysis(Boolean(d.analysis.trim()));
        openEditor("analysis", Boolean(analysisResult?.suggestion));
        showPanel("editor");
    };
    const analyzeReference = () => {
        setShowCurrentAnalysis(false);
        openEditor("analysis");
        showPanel("editor");
        void wb.run("analyze");
    };
    const analyzing = busy && active?.stage === "analyze";
    const preparationBusyLabel = analyzing ? "正在解析视频…" : busy && active?.stage === "frames" ? "正在抽取画面…" : busy && active?.stage === "transcribe" ? "正在转写音轨…" : "";
    const preparationAction = reference && (adoptedError || analysisResult?.suggestion || (!d.analysis.trim() && analysisResult?.text.trim())) ? {
        label: "查看并确认原片分析", disabled: false, run: openAnalysis,
    } : reference && !d.analysis.trim() ? {
        label: failedAnalysis ? "重新解析视频" : "开始解析视频", disabled: Boolean(analysisBlocked), run: analyzeReference,
    } : {
        label: "下一步：改编脚本",
        disabled: false,
        run: () => goStep(1),
    };
    const analysisStatus = <section className="space-y-3 border-t pt-4" style={{ borderColor: token.colorBorderSecondary }} aria-label="原视频解析">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="font-medium">原视频解析</strong>
            {d.analysis.trim() && <Button type="link" size="small" disabled={locked} onClick={openAnalysis}>查看分析</Button>}
        </div>
        <p className="text-sm" role="status" aria-live="polite" style={adoptedError ? { color: token.colorWarning } : muted}>
            {!reference ? "添加原视频后开始解析" : preparationBusyLabel ? active?.step || preparationBusyLabel : adoptedError || (analysisResult?.suggestion ? "新分析待确认，原分析已保留" : d.analysis.trim() ? referenceStatus : failedAnalysis ? "解析未完成" : analysisMode === "frames" && frames.length ? `抽样完成 · ${frames.length} 张画面，尚未解析` : "尚未解析")}
        </p>
        {d.analysis.trim() && <Button block size="large" loading={analyzing} disabled={locked || !reference || Boolean(analysisBlocked)} icon={<RefreshCw size={16} />} onClick={analyzeReference}>{analyzing ? "正在解析视频…" : "重新解析视频"}</Button>}
        {reference && <p className="break-words text-xs" style={muted}>{viralAnalysisNames[analysisMode]} · {modelOptionLabel(analysisConfig, analysisConfig.textModel) || "未配置分析模型"}</p>}
        {failedAnalysis && <Alert type="warning" showIcon title={d.analysis.trim() ? "本次解析未完成，原分析已保留" : "原视频解析未完成"} description={<div className="space-y-2">
            <p className="break-words">{publicServiceText(active?.error || "请核对分析模型和渠道后再试")}</p>
            {analysisMode === "video" && <Button size="small" disabled={locked} onClick={() => { changeAnalysisMode("frames"); openEditor("analysis"); showPanel("editor"); }}>改用抽样画面分析</Button>}
        </div>} />}
        {analysisBlocked && <p role="alert" className="text-xs" style={{ color: token.colorWarning }}>{analysisBlocked}</p>}
        <Collapse size="small" items={[{ key: "analysis-options", label: "解析设置", children: analysisOptions }]} />
        {reference && !d.analysis.trim() && <Button type="link" size="small" className="!px-0" disabled={locked} onClick={() => openEditor("script")}>直接编写脚本</Button>}
    </section>;
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
            <p className="text-xs" style={muted}>{referenceMode ? "多素材参考：按下列实际输入生成，首帧作为画面参考。" : "首帧驱动：从确认的画面生成，动作依照脚本重建。"} {profile.description}</p>
        </div>
    );
    const nextAction = reference && ((!d.analysis.trim() && !d.script.trim()) || adoptedError) ? {
        label: adoptedError || analysisResult?.suggestion ? "返回第一步确认原片分析" : "返回第一步解析原视频", disabled: false,
        run: openAnalysis,
    } : intentError ? {
        label: "完善自定义要求", disabled: false, run: () => showPanel("plan"),
    } : !d.script.trim() ? {
        label: "AI 撰写改编脚本", disabled: Boolean(textBlocked || scriptWritingBlocked), run: () => void wb.run("script"),
    } : d.viralScriptSuggestion ? {
        label: "查看并采用脚本建议", disabled: false, run: () => openEditor("script", true),
    } : d.viralScriptStale ? {
        label: "AI 根据要求修改脚本", disabled: Boolean(textBlocked || scriptWritingBlocked), run: () => void wb.run("script"),
    } : keyframeError || ((d.viralClimaxUse === "reference" || d.viralClimaxUse === "last") && viralKeyframeError(d, "climax")) || (profile.firstFrameRequired && !keyframe) ? {
        label: "准备视频画面", disabled: false, run: () => { wb.patch({ viralImageTarget: keyframeError || !keyframe ? "opening" : "climax" }); showPanel("keyframe"); },
    } : { label: "下一步：生成视频", disabled: Boolean(scriptBlocked), run: () => goStep(2) };
    const scriptPanel = tab === "editor" && editingField === "script" && !viewed;
    const actionHint = !busy && (step === 0 && preparationAction.disabled || step === 1 && scriptPanel && nextAction.disabled) ? <p className="mb-2 text-xs" style={{ color: token.colorWarning }}>{step === 0 ? analysisBlocked : scriptBlocked || textBlocked || scriptWritingBlocked}</p> : null;
    const controls = step === 1 && !scriptPanel ? (
        <Button type="primary" block icon={<ArrowLeft size={15} />} onClick={() => openEditor("script", Boolean(d.viralScriptSuggestion))}>返回改编脚本</Button>
    ) : step !== 2 ? (
        <div className="flex items-center gap-2">
            {step > 0 && <Button aria-label="上一步" icon={<ArrowLeft size={15} />} disabled={locked} onClick={() => goStep(step - 1)} />}
            <Button type="primary" block size={step === 0 ? "large" : "middle"} loading={step === 0 && Boolean(preparationBusyLabel)} disabled={locked || (step === 0 ? preparationAction.disabled : nextAction.disabled)} icon={step === 0 && reference && !d.analysis.trim() ? <Sparkles size={16} /> : <ArrowRight size={15} />} onClick={() => step === 0 ? preparationAction.run() : nextAction.run()}>
                {step === 0 ? preparationBusyLabel || preparationAction.label : nextAction.label}
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
                    {(!d.script.trim() || keyframeError || adoptedError || intentError || viralKeyframeError(d, "climax")) && <Button type="link" size="small" disabled={locked} onClick={() => { goStep(1); if (intentError) setTab("plan"); }}>去完善</Button>}
                </div>
            )}
        </div>
    );
    const keyframePanel = (
        <div className="space-y-4">
            {climaxTarget && <Button size="small" icon={<ArrowLeft size={14} />} disabled={locked} onClick={() => wb.patch({ viralImageTarget: "opening" })}>返回开场画面</Button>}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">{climaxTarget ? "补充画面" : "视频首帧"}</h2>
                {selectedImage && <span className="text-xs" style={selectedImageError ? { color: token.colorWarning } : { color: token.colorSuccess }}>{selectedImageError ? "待确认" : "已确认"}</span>}
            </div>
            <div className="flex flex-wrap gap-3">
                {viralKeyframeMaterials(d, imageTarget).map((m) => <figure key={m.id} className="w-24">
                    <img src={m.url} alt={m.name} className="h-24 w-full rounded object-contain" />
                    <figcaption className="mt-1 truncate text-xs" title={m.name}>{m.id.startsWith("frame:") ? "动作与效果参考" : viralVisualRole(m.role)} · {m.name}</figcaption>
                </figure>)}
            </div>
            <Collapse items={[{ key: "image-details", label: "画面细节（可选）", children: <div className="space-y-3">
            <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">原视频构图参考（可选）</span>
                    <Button size="small" icon={<Images size={14} />} disabled={locked || !reference} onClick={() => void wb.run("frames")}>{frames.length ? "重新抽样" : "抽取参考画面"}</Button>
                </div>
                <Select aria-label={`${imageName}构图参考`} className="w-full" allowClear disabled={locked} value={climaxTarget ? d.viralClimaxReferenceId : d.viralKeyframeReferenceId} placeholder="选择参考时刻的构图与状态" onChange={(value) => wb.edit(climaxTarget ? { viralClimaxReferenceId: value } : { viralKeyframeReferenceId: value }, "video")} options={frames.map((m, i) => ({ value: m.id, label: `${m.name}${Number.isFinite(d.viralFrameTimes?.[i]) ? ` · ${d.viralFrameTimes![i].toFixed(2)}秒` : ""}` }))} />
                {frames.length > 0 && <Collapse items={[{ key: "pose-gallery", label: "查看动作参考画面", children: frameGallery }]} />}
            </div>
            <Input.TextArea aria-label={climaxTarget ? "补充画面要求" : "首帧画面要求"} disabled={locked} autoSize={{ minRows: 3, maxRows: 8 }} value={(climaxTarget ? d.viralClimaxPrompt : d.viralKeyframePrompt) || ""} placeholder={climaxTarget ? "需要呈现的时刻、状态或构图，留空采用脚本结尾" : "补充开场画面要求，留空跟随脚本"} onChange={(e) => wb.edit(climaxTarget ? { viralClimaxPrompt: e.target.value } : { viralKeyframePrompt: e.target.value }, "video")} />
            <label className="flex flex-wrap items-center gap-2 text-sm">
                关键画面画幅
                <Select aria-label="首帧画幅" disabled={locked} value={inferVideoRatio(cfg.size)} onChange={(ratio) => changeSettings({ size: computeVideoSize(cfg.vquality, ratio) })} options={["9:16", "16:9", "1:1", "3:4", "4:3", "21:9"].map((value) => ({ value, label: value }))} />
            </label>
            <div className="space-y-2">
                <span className="text-xs" style={muted}>关键画面合成模型 · 图片编辑独立计费</span>
                {keyframeConfig.managed?.enabled && config.channelMode === "remote" ? <FeatureModelPicker featureId="image.edit" capability="image" /> : <ModelPicker config={keyframeConfig} capability="image" value={keyframeConfig.imageModel} fullWidth onChange={(value) => updateConfig("imageModel", value)} />}
            </div>
            </div> }]} />
            <Button icon={<Sparkles size={15} />} loading={busy && active?.stage === "keyframe"} disabled={locked || !d.script.trim() || !viralKeyframeMaterials(d, imageTarget).some((m) => !m.id.startsWith("frame:")) || Boolean(viralIntentError(d))} onClick={() => void wb.run("keyframe")}>合成{imageName}</Button>
            {selectedImage ? <div className="space-y-3">
                <img src={selectedImage.url} alt={`待确认的${imageName}`} className="max-h-[45vh] w-full object-contain" />
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="primary" disabled={locked || !selectedImageError} icon={<Check size={15} />} onClick={() => wb.edit({ ...(climaxTarget ? { viralClimax: { ...d.viralClimax, id: selectedImage.id, inputKey: viralKeyframeInputKey(d, imageTarget), confirmed: true } } : { viralKeyframe: { ...d.viralKeyframe, id: selectedImage.id, inputKey: viralKeyframeInputKey(d), confirmed: true } }), viralOutputStale: true })}>{selectedImageError ? `确认使用这张${imageName}` : `${imageName}已确认`}</Button>
                    <Button icon={<Download size={14} />} onClick={() => void wb.download(selectedImage)}>下载{imageName}</Button>
                    <Button disabled={locked} onClick={() => wb.edit(climaxTarget ? { viralClimaxId: undefined, viralClimax: undefined, viralClimaxUse: "preview" } : { viralFirstFrameId: undefined, viralKeyframe: undefined }, "video")}>取消选用</Button>
                </div>
                {selectedImageError && <p className="text-xs" style={{ color: token.colorWarning }}>请核对画面内容与本次素材、脚本要求是否一致。</p>}
            </div> : <Empty description={`合成或上传${imageName}后，在这里确认`} />}
            {climaxTarget && <div className="space-y-2">
                <label className="block text-sm">补充图用途</label>
                <Select aria-label="补充图用途" className="w-full" disabled={locked} value={d.viralClimaxUse || "preview"} onChange={(viralClimaxUse) => wb.edit({ viralClimaxUse }, "video")} options={[
                    { value: "preview", label: "仅用于人工确认，不发送视频模型" },
                    { value: "reference", label: "作为普通参考图发送，不锁定时间位置", disabled: !referenceMode || profile.maxImages < 1 },
                    { value: "last", label: "作为尾帧发送，目标结束时保持该画面", disabled: mode !== "first_last" || wan },
                ]} />
                <p className="text-xs" style={muted}>普通参考图不锁定出现时间；尾帧应为目标结束画面。</p>
            </div>}
            <p className="text-xs" style={muted}>素材未展示的外观与空间由模型补全，以返回画面为准。</p>
            <Collapse items={[{ key: "existing-frame", label: `上传或选择已有${imageName}`, children: <div className="space-y-3">
                <Select aria-label={climaxTarget ? "选择补充画面" : "生成首帧"} className="w-full" allowClear disabled={locked} value={selectedImage?.id} placeholder="选择已有画面" onChange={(value) => wb.edit(climaxTarget ? { viralClimaxId: value, viralClimax: undefined } : { viralFirstFrameId: value, viralKeyframe: undefined }, "video")} options={viralImageCandidates(d).map((m) => ({ value: m.id, label: `${labels.find((l) => l.id === m.id)?.label} · ${m.name}` }))} />
                {materialField("first-frame", `上传${imageName}`, "上传符合脚本要求的完整画面")}
            </div> }]} />
            {!climaxTarget && <Collapse items={[{ key: "optional-climax", label: `补充画面（可选）${d.viralClimaxId ? " · 已准备" : ""}`, children: <Button disabled={locked} icon={<Images size={14} />} onClick={() => wb.patch({ viralImageTarget: "climax" })}>准备补充画面</Button> }]} />}
        </div>
    );
    if (!wb.hydrated)
        return (
            <div className="p-12 text-center">
                <Spin />
            </div>
        );
    return (
        <ConfigProvider theme={{ cssVar: { key: "viral-workspace" }, token: { colorTextPlaceholder: token.colorTextSecondary } }}>
        <main className="flex h-full min-h-0 flex-col" style={{ color: token.colorText }}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <Link to="/video" className="inline-flex items-center gap-1 text-sm" style={muted}>
                        <ArrowLeft size={15} />
                        视频制作
                    </Link>
                    <h1 className="text-lg font-semibold">爆款复刻</h1>
                </div>
                <div className="flex items-center gap-1">
                <Button type="text" size="small" disabled={locked || Boolean(wb.storageError)} icon={<Plus size={14} />} onClick={newTask}>新建任务</Button>
                {step === 0 && <Button type="text" size="small" icon={<Play size={14} />} onClick={() => showPanel("current")}>预览素材</Button>}
                {step !== 1 && <Dropdown trigger={["click"]} menu={{ items: [
                    { key: "history", label: "历史任务" },
                    { key: "guide", label: "使用说明" },
                    { type: "divider" },
                    { key: "options", label: "高级设置" },
                ], onClick: ({ key }) => key === "options" ? setOptionsOpen(true) : showPanel(key) }}>
                    <Tooltip title="更多"><Button type="text" aria-label="更多" icon={<MoreHorizontal size={18} />} /></Tooltip>
                </Dropdown>}
                </div>
            </header>
            <nav aria-label="复刻步骤" className={`mx-auto w-full ${step === 1 ? "max-w-[1100px]" : "max-w-[1800px]"} shrink-0 px-4 pb-3 sm:px-6`}>
                <Steps size="small" current={step} responsive={false} onChange={goStep} items={["素材与解析", "改编脚本", "生成视频"].map((title, index) => ({ title: <><span className="sm:hidden">{["解析", "脚本", "成片"][index]}</span><span className="hidden sm:inline">{title}</span></>, disabled: locked }))} />
            </nav>
            <div ref={workspaceScroll} className={`min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 ${step === 1 ? "" : "lg:overflow-hidden"}`} data-testid="viral-scroll">
                <div className={`mx-auto grid min-h-full grid-cols-1 gap-5 ${step === 1 ? "max-w-[1052px]" : "max-w-[1800px] lg:h-full lg:min-h-0 lg:grid-cols-[420px_minmax(0,1fr)]"}`}>
                    <section className={`${step === 1 ? "hidden" : "flex"} min-h-0 min-w-0 flex-col rounded-lg border`} style={surface} aria-label="复刻素材与设置">
                        <div ref={inputScroll} className="flex min-h-0 flex-1 flex-col gap-5 p-4 lg:overflow-y-auto [&>*]:shrink-0" data-testid="viral-input-scroll">
                            <div hidden={step !== 0} className="space-y-4">
                            {materialField("reference", "参考视频", "参考内容结构、镜头、节奏与创意")}
                            {analysisStatus}
                            </div>
                            <div hidden={step !== 2} className="space-y-5">
                            {videoSettings}
                            <section className="space-y-2">
                                {intent.textMode === "replace" && <p className="text-sm">画面文字：{intent.text}</p>}
                                {d.viralClimaxId && <p className="text-xs" style={muted}>补充图：{d.viralClimaxUse === "reference" ? "作为普通参考发送" : d.viralClimaxUse === "last" ? "作为尾帧发送" : "仅人工预览，不发送"}</p>}
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
                                <Alert type={d.viralUseVideo ? "info" : "warning"} title={d.viralUseVideo ? "原视频将作为内容与节奏参考" : "本次不传原视频，按脚本生成"} description={d.viralUseVideo ? "实际复刻效果以成片为准。" : referenceMode ? "视觉内容以实际发送的参考图片为准，不能保证逐帧复制原片。" : "视觉内容以已选画面与脚本为准，不能保证逐帧复制原片。"} />
                            </section>
                            </div>
                        </div>
                        <div className="hidden shrink-0 border-t p-4 lg:block" style={{ borderColor: token.colorBorderSecondary }}>
                            {actionHint}
                            {controls}
                        </div>
                    </section>
                    <aside ref={previewPanel} className={`flex min-h-0 min-w-0 flex-col ${step === 1 ? "" : "rounded-lg border p-4"}`} style={step === 1 ? undefined : surface} aria-label="作品与说明">
                        {step === 1 && <div className="mb-4 flex shrink-0 flex-col gap-2 border-b pb-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: token.colorBorderSecondary }}>
                            <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
                                {reference && <button type="button" className="min-w-0 flex-1 truncate text-left text-sm" style={{ ...muted, overflow: "hidden" }} title={reference.name} onClick={() => showPanel("current")}>{reference.name}</button>}
                                <div className="flex shrink-0 gap-1">
                                    {targetImages.slice(0, 3).map((m) => <img key={m.id} src={m.url} alt={m.name} className="h-8 w-8 rounded object-cover" />)}
                                </div>
                            </div>
                            <Button type="text" size="small" className="self-end sm:self-auto" disabled={locked} onClick={() => goStep(0)}>更换原视频</Button>
                        </div>}
                        {step === 1 && <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
                            <div className="min-w-0 flex-1">
                                {scriptPanel ? <Button type="link" size="small" className="!h-auto !max-w-full !px-0" title={referenceStatus} onClick={() => { setShowCurrentAnalysis(Boolean(d.analysis.trim())); openEditor("analysis", Boolean(analysisResult?.suggestion)); }}>
                                    <span className="truncate" style={adoptedError || historicalReference ? { color: token.colorWarning } : undefined}>{adoptedError ? "原片分析待确认" : historicalReference ? `借鉴历史分析 · ${d.viralAdoptedAnalysis!.provenance.sourceName}` : analysisResult?.suggestion ? "新分析待采用" : d.analysis.trim() ? "原片已分析 · 查看" : "原片尚未分析"}</span>
                                </Button> : <Button type="text" size="small" icon={<ArrowLeft size={14} />} onClick={() => openEditor("script", Boolean(d.viralScriptSuggestion))}>返回脚本</Button>}
                            </div>
                            <Button size="small" type="text" disabled={locked} icon={<SlidersHorizontal size={14} />} onClick={() => setSettingsOpen(true)}>{spec}</Button>
                            <Dropdown trigger={["click"]} menu={{ items: [
                                { key: "analysis", label: "原视频分析" },
                                { key: "keyframe", label: `视频画面${profile.firstFrameRequired ? "（当前模型需要）" : "（可选）"}` },
                                { key: "plan", label: "复刻细节（可选）" },
                                { type: "divider" },
                                { key: "history", label: "历史任务" },
                                { key: "guide", label: "使用说明" },
                                { key: "options", label: "高级设置" },
                            ], onClick: ({ key }) => key === "options" ? setOptionsOpen(true) : key === "analysis" ? openEditor(key) : showPanel(key) }}>
                                <Tooltip title="更多"><Button size="small" type="text" aria-label="更多" icon={<MoreHorizontal size={16} />} /></Tooltip>
                            </Dropdown>
                        </div>}
                        {step === 1 && scriptPanel && sourceRatio && sourceRatio !== inferVideoRatio(cfg.size) && !cloud && <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs" style={muted}>
                            <span>原片 {sourceRatio}，本次 {inferVideoRatio(cfg.size)}</span>
                            <Button type="link" size="small" disabled={locked} onClick={() => changeSettings({ size: computeVideoSize(cfg.vquality, sourceRatio) })}>采用原片比例</Button>
                        </div>}
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
                        {!busy && active?.error && active.stage !== "analyze" && <Alert className="mb-3" type="warning" title="上次处理未完成" description={publicServiceText(active.error)} />}
                        {step === 1 && scriptPanel && <div className="mb-5 space-y-4 border-b pb-5" style={{ borderColor: token.colorBorderSecondary }} aria-label="复刻改编输入">
                            <section className="space-y-3">
                                <strong className="block font-medium">复刻要求（选填）</strong>
                                {textPreview("instructions", "想改什么、保留什么？也可写名称、准确文字或其他资料；留空参考原片。")}
                                {intentError && <p role="alert" className="text-xs" style={{ color: token.colorWarning }}>{intentError}</p>}
                            </section>
                            <Collapse activeKey={imagesOpen ? ["images"] : []} onChange={(keys) => setImagesOpen(keys.includes("images"))} items={[{ key: "images", forceRender: true, label: <span className="flex items-center justify-between gap-2"><span>补充图片（可选）</span>{targetImages.length > 0 && <span className="shrink-0 text-xs" style={muted}>{targetImages.length} 张</span>}</span>, children: <div className="space-y-4">
                                {materialField("visual-reference", "参考图片", "商品、场景、主体或风格参考")}
                                {materialField("model", "人物图片", "需要指定人物时添加")}
                                {(referenceImages.length > 0 || d.viralProductAnalysis || d.viralProductSuggestion) && <Collapse items={[{ key: "product", label: "参考图片分析（可选）", children: <div className="space-y-3">
                                    {heading("viralProductAnalysis", textAction("product-analyze", "分析参考图片", !referenceImages.length))}
                                    <Collapse size="small" items={[{ key: "product-model", label: "分析模型", children: modelPicker("viral-recreate.analyze", "图片分析模型") }]} />
                                    {productBlocked && <p className="text-xs" style={{ color: token.colorWarning }}>{productBlocked}</p>}
                                    {textPreview("viralProductAnalysis", "参考图片的可见信息")}
                                    {suggestion("viralProductAnalysis")}
                                </div> }]} />}
                            </div> }]} />
                        </div>}
                        {step !== 1 && <Tabs
                            activeKey={tab}
                            onChange={(value) => value === "editor" ? openEditor(step === 0 ? "analysis" : "script") : setTab(value)}
                            tabBarExtraContent={step === 0 ? <Button type="text" size="small" aria-label="返回素材填写" icon={<ArrowLeft size={14} />} className="lg:!hidden" onClick={() => { workspaceScroll.current?.scrollTo({ top: 0, behavior: "smooth" }); inputScroll.current?.scrollTo(0, 0); }} /> : undefined}
                            items={[
                                { key: "current", label: step === 0 ? "素材预览" : "视频对照" },
                                { key: "editor", label: step === 0 ? editingField === "transcript" ? "音轨文字" : editingField === "viralProductAnalysis" ? "参考图片分析" : "原片分析" : "改编脚本" },
                                { key: "history", label: "历史任务" },
                            ]}
                        />}
                        <div className={`min-h-0 flex-1 ${step === 1 ? tab === "editor" ? `h-[60vh] ${editingField === "analysis" ? "min-h-[700px]" : "min-h-[460px]"}` : "" : tab === "editor" ? "h-[65vh] min-h-96 lg:h-auto lg:min-h-0" : "lg:overflow-y-auto"}`}>
                            {tab === "editor" && editorBody(editingField)}
                            {tab === "plan" && effectsPanel}
                            {tab === "keyframe" && keyframePanel}
                            {tab === "current" && (
                                <div className="space-y-3">
                                    {viewed && (
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-sm">
                                                查看历史 · {viewed.stage === "draft" ? "任务草稿" : stageLabels[viewed.stage]} · {new Date(viewed.createdAt).toLocaleString()}
                                            </span>
                                            <Button size="small" onClick={() => setViewed(null)}>
                                                返回当前制作
                                            </Button>
                                        </div>
                                    )}
                                    {!viewed && d.viralOutputStale && d.video && <Alert type="warning" title="输入已变化，以下为上一次制作结果" />}
                                    <div className={`grid gap-3 ${!viewed && step === 0 && !targetImages.length ? "" : "xl:grid-cols-2"}`}>
                                        <section className="min-w-0 space-y-2">
                                            <h2 className="text-sm font-medium">参考视频</h2>
                                            {original ? (
                                                <video ref={comparisonOriginal} controls muted src={original.url} className={`max-h-[55vh] w-full rounded object-contain ${!viewed && step === 0 && !targetImages.length ? "mx-auto max-w-3xl" : ""}`} />
                                            ) : (
                                                <div className="flex min-h-52 items-center justify-center">
                                                    <Empty description="上传后预览原视频" />
                                                </div>
                                            )}
                                        </section>
                                        {(viewed || step !== 0 || targetImages.length > 0) && <section className="min-w-0 space-y-2">
                                            <h2 className="text-sm font-medium">{!viewed && step === 0 ? "目标素材" : viewed?.stage === "keyframe" ? viewed.viralInput?.viralImageTarget === "climax" ? "合成补充画面" : "合成首帧" : "改编作品"}</h2>
                                            {!viewed && step === 0 ? (
                                                <div className="grid grid-cols-2 gap-3">
                                                    {targetImages.map((m) => <figure key={m.id} className="min-w-0 space-y-1">
                                                        <img src={m.url} alt={m.name} className="h-40 w-full object-contain" />
                                                        <figcaption className="truncate text-xs" title={m.name}>{viralVisualRole(m.role)} · {m.name}</figcaption>
                                                    </figure>)}
                                                </div>
                                            ) : result ? (
                                                result.mimeType.startsWith("image/") ? <img src={result.url} alt="历史关键画面" className="max-h-[55vh] w-full object-contain" /> : <video ref={comparisonResult} controls src={result.url} className="max-h-[55vh] w-full rounded object-contain" onTimeUpdate={(e) => { const player = e.currentTarget; if (Number.isFinite(player.duration) && player.duration > 0) setComparisonProgress(player.currentTime / player.duration * 100); }} onError={() => setPreviewError(true)} />
                                            ) : viewed?.text ? (
                                                <Input.TextArea aria-label="历史文案" rows={12} value={viewed.stage === "analyze" ? viralVisibleAnalysis(viewed.text || "") : viewed.text} readOnly />
                                            ) : (
                                                <div className="flex min-h-52 items-center justify-center">
                                                    <Empty description="生成后在这里对照预览" />
                                                </div>
                                            )}
                                        </section>}
                                    </div>
                                    {(step !== 0 || viewed) && original && result?.mimeType.startsWith("video/") && <div className="flex items-center gap-3">
                                        <Tooltip title="按时长比例联动播放"><Button aria-label="联动播放对照视频" icon={<Play size={15} />} onClick={() => void playComparison()} /></Tooltip>
                                        <Tooltip title="暂停对照"><Button aria-label="暂停对照视频" icon={<Pause size={15} />} onClick={() => { comparisonOriginal.current?.pause(); comparisonResult.current?.pause(); }} /></Tooltip>
                                        <div className="min-w-0 flex-1"><Slider aria-label="对照进度（按时长比例）" value={comparisonProgress} onChange={seekComparison} tooltip={{ formatter: (value) => `${Math.round(value || 0)}%` }} /></div>
                                    </div>}
                                    {previewError && <Alert type="warning" title="当前浏览器无法播放此编码，仍可下载原文件" />}
                                    {result && (
                                        <Space wrap>
                                            {!viewed && step !== 0 && result.mimeType.startsWith("video/") && (
                                                <Button icon={<ArrowLeft size={15} />} disabled={locked} onClick={() => { goStep(1); openEditor("script"); }}>
                                                    修改脚本
                                                </Button>
                                            )}
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
                                    <p className="text-xs" style={muted}>记录与草稿仅保存在当前浏览器，不会同步到其他设备。清理浏览器数据前请下载需要保留的作品。</p>
                                    {!taskGroups.length && <Empty description="暂无历史任务" />}
                                    {taskGroups.map((group) => (
                                        <div key={group.id} className="min-w-0 space-y-3 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }} data-testid="viral-history-task">
                                            <div className="grid min-w-0 gap-1 sm:flex sm:items-start sm:justify-between sm:gap-2">
                                                <strong className="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]">{group.title}</strong>
                                                <span className="shrink-0 text-xs" style={muted}>{new Date(group.updatedAt).toLocaleString()}</span>
                                            </div>
                                            <p className="text-xs" style={muted}>{group.current.stage === "draft" ? "草稿已保存" : `${stageLabels[group.current.stage] || group.current.stage} · ${states[group.current.status]}`}{group.records.length > 0 ? ` · ${group.records.length} 条步骤记录` : ""}</p>
                                            <Space wrap>
                                                <Button size="small" disabled={locked || !group.result} onClick={() => group.result && void showRecord(group.result)}>查看结果</Button>
                                                {(group.current.viralDraft || group.current.viralInput) && <Button size="small" disabled={locked || Boolean(wb.storageError)} onClick={() => restoreInput(group.current)}>继续任务</Button>}
                                            </Space>
                                            {group.records.length > 0 && <Collapse ghost size="small" items={[{ key: "steps", label: "步骤记录", children: <div className="space-y-3">
                                    {group.records.map((r) => (
                                        <div key={r.id} className="space-y-2 border-t pt-3" style={{ borderColor: token.colorBorderSecondary }}>
                                            <div className="flex flex-wrap justify-between gap-2">
                                                <strong className="font-medium">
                                                    {r.stage === "analyze" ? r.step === "旧稿归档" ? "历史参考分析 · 旧稿" : r.step === "其他视频分析归档" ? "历史参考分析 · 其他视频" : r.step === "编辑稿备份" ? "参考分析编辑稿" : "参考视频分析" : r.stage === "frames" ? "抽取参考画面" : r.stage === "keyframe" && r.viralInput?.viralImageTarget === "climax" ? "补充画面合成" : r.stage === "product-analyze" ? "参考图片分析" : stageLabels[r.stage]} · {states[r.status]}
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
                                                        wb.edit({ media: [...d.media, { ...file, id, name: climax ? "历史补充画面" : "历史合成首帧", role: "first-frame", kind: "image" }], ...(climax ? { viralClimaxId: id, viralClimax: undefined, viralImageTarget: "climax" } : { viralFirstFrameId: id, viralKeyframe: undefined, viralImageTarget: "opening" }) }, "video");
                                                        goStep(1);
                                                        setTab("keyframe");
                                                    } catch (error) { message.error(error instanceof Error ? error.message : "首帧读取失败"); }
                                                }}>使用这张{r.viralInput?.viralImageTarget === "climax" ? "补充画面" : "首帧"}</Button>}
                                                {r.viralInput && (
                                                    <Button size="small" disabled={locked} onClick={() => restoreInput(r)}>
                                                        从这一步继续
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
                                            </div> }]} />}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {tab === "guide" && (
                                <div className="space-y-4 text-sm">
                                    <p>视频与音轨分析将参考视频发送到所选模型渠道；抽样画面分析只发送图片和已提供的转写文字。两种分析的时间与镜头边界都需核对。</p>
                                    <p>第 1 步添加原视频并解析，查看或校对原片分析。第 2 步填写复刻要求、添加可选参考图片或人物图片，生成或修改改编脚本，按当前模型需要准备画面；也可直接编写自己的脚本。</p>
                                    <p>参考图片可提供商品、场景、主体或风格，人物图按需添加；已知用途可在图片下选择。脚本按原片实际类型借鉴结构与表现特点，不要求每次都有商品、人物、文字或特殊效果。</p>
                                    <p>新分析中的复刻要点自动带入，无需导入或填写脚本位置；完整分析仍用于改编。个别要点可在「细节调整」修改，真实效果需查看成片。</p>
                                    <p>只有当前模型需要首帧时，才必须准备视频画面；支持多素材参考的模型可以直接使用参考图片。补充画面可供预览，或按模型能力明确选为普通参考、结束尾帧，普通参考不能锁定时刻。图片合成与视频分别计费。</p>
                                    <p>第 3 步核对实际输入与费用。首帧驱动只接收已选画面，多素材与原视频参考按当前模型已配置的能力发送；没有发送原视频时，动作依照文字重建，不能保证逐帧复现。</p>
                                    <p>两种分析分别保存，未人工编辑的新结果自动用于后续改编；人工编辑稿在替换前保留到历史。更换视频后，其他视频的分析归入历史任务；主动借鉴时须核对原视频与当前视频，不代表已分析当前视频。同一视频改变抽样参数后可确认沿用。手写脚本和合规首帧可直接生成，不依赖抽样或Whisper服务。</p>
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
            <footer className={`shrink-0 border-t px-4 py-3 ${step === 1 ? "" : "lg:hidden"}`} style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}>
                <div className={step === 1 ? "mx-auto max-w-[1052px]" : ""}>
                    {actionHint}
                    <div className={step === 1 ? "lg:ml-auto lg:max-w-sm" : ""}>{controls}</div>
                </div>
            </footer>
            <AssetPickerModal open={Boolean(assetRole)} onClose={() => setAssetRole(null)} onInsert={(payload) => void insertAsset(payload)} />
            <Modal
                title={comparison?.kind === "revision" ? "本次修改对照" : "原片与改编对照"}
                width={1200}
                open={Boolean(comparison)}
                onCancel={() => setComparison(null)}
                destroyOnHidden
                style={{ top: 20 }}
                styles={{ container: { height: "calc(100dvh - 40px)", display: "flex", flexDirection: "column" }, body: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }, header: { flexShrink: 0 }, footer: { flexShrink: 0 } }}
                footer={<div className="flex flex-wrap items-center justify-between gap-2">
                    <Button onClick={() => setComparison(null)}>返回编辑</Button>
                    {comparison?.target === "suggestion" && suggestionActions("script")}
                </div>}
            >
                {comparison && <>
                    {d.viralScriptStale && d.script.trim() && <Alert className="mb-3 shrink-0" type="warning" title="输入已变化，已采用脚本尚未更新" />}
                    {comparison.kind === "source" ? <div className="mb-3 shrink-0 space-y-2">
                        <p className="break-words text-xs" style={muted}>
                            {d.analysis.trim() ? `${analysisSource(currentAnalysis)}。依据已采用的原片分析还原，并非拍摄者的原始脚本。` : "尚未采用原片分析。"}
                        </p>
                        {adoptedError && <Alert type="warning" title={adoptedError} />}
                        {historicalReference && <Alert type="warning" title="左侧为历史视频内容" description={`来源：${currentAnalysis.provenance.sourceName}；当前视频：${reference?.name || "未添加"}。不是当前视频的分析。`} />}
                        {!d.analysis.trim() && <Button size="small" disabled={locked} onClick={() => { setComparison(null); setShowCurrentAnalysis(false); openEditor("analysis"); }}>查看 / 分析原视频</Button>}
                    </div> : <p className="mb-3 shrink-0 text-xs" style={muted}>对比已采用的改编脚本与本次新建议；新建议尚未替换已采用稿。</p>}
                    {comparison.kind === "source" && !d.analysis.trim() ? <div className="flex min-h-0 flex-1 items-center justify-center"><Empty description="分析原视频后，可在这里对照改编脚本" /></div> : <ViralScriptComparison
                        key={`${comparison.kind}-${comparison.target}`}
                        before={comparison.kind === "source" ? viralVisibleAnalysis(d.analysis) : d.script}
                        after={comparison.target === "suggestion" ? d.viralScriptSuggestion || "" : d.script}
                        beforeLabel={comparison.kind === "revision" ? "已采用脚本" : `${historicalReference ? "历史视频" : "原片"}内容（${!currentAnalysis.provenance.model ? "已采用分析" : currentAnalysis.provenance.edited ? "AI 还原·已校对" : "AI 还原"}）`}
                        afterLabel={comparison.target === "suggestion" ? "新建议（待采用）" : "改编脚本"}
                    />}
                </>}
            </Modal>
            <Modal title="高级设置" open={optionsOpen} onCancel={() => setOptionsOpen(false)} footer={<Button onClick={() => setOptionsOpen(false)}>完成</Button>}>
                <div className="space-y-4">
                    <Collapse items={[
                        { key: "analysis", label: "原视频分析设置", children: analysisOptions },
                        { key: "script", label: "脚本模型", children: modelPicker("viral-recreate.script", "脚本模型") },
                    ]} />
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={locked} onClick={() => openConfig(true)}>配置模型渠道</Button>
                        <Button disabled={locked} onClick={() => { setOptionsOpen(false); setServiceOpen(true); }}>抽样 / 转写服务</Button>
                        <Button disabled={locked} onClick={() => { setOptionsOpen(false); goStep(1); openEditor("transcript"); }}>校对音轨文字</Button>
                    </div>
                </div>
            </Modal>
            <Modal title="从已采用分析添加要点" width={760} open={effectSourceOpen} onCancel={() => setEffectSourceOpen(false)} footer={<Space><Button onClick={() => setEffectSourceOpen(false)}>取消</Button><Button type="primary" disabled={locked || !effectSelection.trim() || Boolean(adoptedError)} onClick={() => { addEffect(effectSelection.trim()); setEffectSourceOpen(false); }}>添加要点</Button></Space>}>
                <div className="space-y-3">
                    <p className="text-sm" style={muted}>参考原分析填写需要保留的动作或效果，也可选中原文后修改。</p>
                    <Input.TextArea aria-label="选择分析中的复刻要点" readOnly value={viralVisibleAnalysis(d.analysis)} rows={14} onSelect={(e) => captureEffectSelection(e.target as HTMLTextAreaElement)} onMouseUp={(e) => captureEffectSelection(e.currentTarget)} onKeyUp={(e) => captureEffectSelection(e.currentTarget)} />
                    <label className="block space-y-2 text-sm"><span>要点内容</span><Input.TextArea aria-label="待添加的复刻要点" value={effectSelection} autoSize={{ minRows: 2, maxRows: 6 }} placeholder="需要保留或改编的内容、镜头或表现特点" onChange={(e) => setEffectSelection(e.target.value)} /></label>
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
                    <label className="block space-y-2">
                        <span>视频模型</span>
                        <div className="flex items-center gap-2">
                            <Select aria-label="视频模型" className="min-w-0 flex-1" disabled={locked} value={cfg.videoModel} virtual={false} optionRender={(option) => <VideoModelOption config={config} model={String(option.value)} />} onChange={(videoModel) => changeSettings({ videoModel })} options={selectableModelsByCapability(config, "video").map((value) => ({ value, label: videoProfile(config, value).displayName }))} />
                            <Button aria-label="刷新模型" disabled={locked} loading={refreshing} icon={<RefreshCw size={14} />} onClick={() => void refreshModels()} />
                        </div>
                    </label>
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
        </ConfigProvider>
    );
}
