import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Collapse, Dropdown, Empty, Grid, Input, InputNumber, Mentions, Modal, Segmented, Select, Slider, Space, Spin, Switch, Tabs, Tooltip, Upload, theme } from "antd";
import { ArrowDown, ArrowLeft, ArrowUp, Check, Copy, Download, Expand, FolderPlus, Grid2X2, Images, Library, LoaderCircle, Mic, Pencil, Plus, RefreshCw, Save, Settings2, Sparkles, Trash2, Undo2, X } from "lucide-react";
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
import { getMediaBlob } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { configForFeature, managedModelBinding, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { emptyVideoDraft, type StoreShot, type StoreVideoSettings, type VideoDraft, type VideoRecord } from "@/types/video-workbench";
import { useVideoCreationConfig } from "@/hooks/use-video-creation-config";
import { useCopyText } from "@/hooks/use-copy-text";
import { storeAnalysisDisplay } from "./store-analysis";
import { StorePlanSkeleton, StoreTaskProgress, storeTaskTitle } from "./store-task-progress";
import { normalizeStoreSettings, storeMaterialLabels, storeVideoConfig, storeVideoError, storeVideoMaterials, storeVideoSettings } from "./store-explore-request";
import { renderStoreShots, storeCaptionError, storeKeyframeKey, storePlanKey, storeSpeechKey, storeSubtitleSource, storeSuggestedPurpose } from "./store-explore-plan";
import { storeCandidateMaterials, storeCast, storeCastReferenceError, storeMaterialKey, storeSelectedIds } from "./store-materials";
import { storePersonVoiceError, storePersonVoices, storeVoiceMinimumSeconds } from "./store-person-voice";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";
import { StoreProjectPanel, storeRecordStatus } from "./store-project-panel";
import { useStoreProjectAccess } from "./use-store-project-access";
import { stopStoreTask } from "./store-task-runtime";
import { flushWorkbenchStorage } from "@/stores/workbench-storage";

type Editor = "storeFacts" | "analysis" | "instructions" | "script";
const names = { storeFacts: "门店真实资料", analysis: "素材观察", instructions: "本次要求", script: "自由脚本" };

export default function StoreExploreWorkspace() {
    const id = useVideoWorkbenchStore((s) => s.activeStoreProjectId);
    return <StoreProjectEditor key={id} />;
}

function StoreProjectEditor() {
    const screens = Grid.useBreakpoint();
    const projectId = useVideoWorkbenchStore((s) => s.activeStoreProjectId);
    const editable = useStoreProjectAccess(projectId);
    const wb = useVideoWorkbench("store-explore", editable),
        { draft: d, busy } = wb;
    const querying = useVideoWorkbenchStore((s) => s.storeQuerying);
    const previewRecordId = useVideoWorkbenchStore((s) => s.storePreviewRecordId);
    const [adopting, setAdopting] = useState(false);
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
    const planHeading = useRef<HTMLHeadingElement>(null),
        planSuggestion = useRef<HTMLElement>(null),
        runningPlan = useRef<string | null>(null);
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
    const [assetRole, setAssetRole] = useState<"reference" | "model" | "first-frame" | "voice" | null>(null);
    const [materialPicker, setMaterialPicker] = useState<{ shotId: string | null; ids: string[] } | null>(null),
        [materialSearch, setMaterialSearch] = useState("");
    const [settingsOpen, setSettingsOpen] = useState(false),
        [presetsOpen, setPresetsOpen] = useState(false),
        [presetName, setPresetName] = useState("");
    const [viewed, setViewed] = useState<VideoRecord | null>(null),
        [previewError, setPreviewError] = useState(false);
    const [request, setRequest] = useState(""),
        [scope, setScope] = useState(d.storeFeedbackSourceRecordId ? "feedback" : "all"),
        [feedbackSeconds, setFeedbackSeconds] = useState<number | null>(null);
    const feedbackVideoRef = useRef<HTMLVideoElement>(null);
    const [analysisOpen, setAnalysisOpen] = useState(false),
        [analysisView, setAnalysisView] = useState("current"),
        [analysisDraft, setAnalysisDraft] = useState<{ base: string; value: string } | null>(null);
    const [quote, setQuote] = useState<{ key: string; value: VideoPrice } | null>(null),
        [quoting, setQuoting] = useState(false),
        quoteController = useRef<AbortController | null>(null);
    const [capabilities, setCapabilities] = useState({ compose: false, transcribe: false, error: "" });
    const [refreshing, setRefreshing] = useState(false);
    const locked = busy || uploading || adopting || !editable,
        labels = storeMaterialLabels(d),
        profile = videoProfile(cfg, cfg.videoModel);
    const mode = videoInputMode(cfg, cfg.videoModel),
        cloud = isReplicateVideoModel(cfg.videoModel),
        wan = cfg.videoModel === REPLICATE_VIDEO_MODEL;
    const candidates = storeCandidateMaterials(d),
        actualMaterials = storeVideoMaterials(d, cfg),
        selectedIds = storeSelectedIds(d),
        overLimit = mode === "reference" && actualMaterials.length > profile.maxImages;
    const cast = storeCast(d), personVoice = storePersonVoices(d)[0],
        personVoiceError = storePersonVoiceError(d, cfg);
    const active = wb.records.find((r) => r.id === d.activeRecord);
    useEffect(() => {
        if (busy && active?.stage === "script") {
            runningPlan.current = active.id;
            return;
        }
        if (busy || !runningPlan.current) return;
        const completed = active?.id === runningPlan.current && (active.status === "completed" || Boolean(d.storeScriptSuggestion));
        runningPlan.current = null;
        if (!completed || tab !== "plan") return;
        const frame = requestAnimationFrame(() => {
            const target = planSuggestion.current || planHeading.current, scroll = mainScroll.current;
            if (!target || !scroll) return;
            const top = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
            scroll.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
            target.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [busy, active?.id, active?.stage, active?.status, tab]);
    const pending = active && ["running", "interrupted"].includes(active.status) && (active.modelTask || active.replicateTask || active.workerJob) ? active : undefined;
    const blocked = storeVideoError(d, cfg);
    const textError = (analyze = false) => {
        const c = analyze ? configForFeature(config, "store-explore.analyze", "text") : config;
        return c.channelMode === "remote" && !session ? "请先登录" : !c.textModel || !useConfigStore.getState().isAiConfigReady(c, c.textModel) ? "请配置当前文案模型" : "";
    };
    const priceKey = JSON.stringify([settings, d.script, d.storeShots, d.media, d.storeAudioMode, d.instructions, d.storeFacts, d.storeFirstFrameId, d.storeLastFrameId, config.channelMode, config.managed?.revision, session]);
    const price = quote?.key === priceKey ? quote.value : null,
        result = viewed ? viewed.result : d.final || d.video;
    const muted = { color: token.colorTextSecondary },
        border = { borderColor: token.colorBorderSecondary };
    const shots = d.storeShots || [],
        audioMode = d.storeAudioMode || "source";
    const pendingScriptTurn = [...(d.storeScriptTurns || [])].reverse().find((turn) => turn.status === "pending");
    const cloudSpeech = managedModelBinding(config, config.audioModel, "audio")?.adapter === "cloud:speech";
    const voiceOptions = cloudSpeech ? cloudSpeechSpeakers : audioVoiceOptions.map((v) => v.value);
    const speechCurrent = Boolean(d.speech && d.storeSpeechKey === storeSpeechKey(d, config.audioModel));
    const duration = (d.video?.durationMs || 0) / 1000 || Number(cfg.videoSeconds),
        captionError = storeCaptionError(d, duration);
    const finishError = !d.video ? "请先生成视频" : d.storeOutputStale ? "方案已变化，请先生成当前画面" : audioMode === "narration" && !speechCurrent ? "请先生成当前旁白" : captionError;
    useEffect(() => {
        if (wb.hydrated && editable && !d.storeSettings) wb.patch({ storeSettings: normalizeStoreSettings(storeVideoSettings(config), config) });
    }, [wb.hydrated, editable, d.storeSettings, config]);
    useEffect(() => {
        quoteController.current?.abort();
        setQuoting(false);
        return () => quoteController.current?.abort();
    }, [priceKey]);
    useEffect(() => setPreviewError(false), [result?.url]);
    useEffect(() => setScope(d.storeFeedbackSourceRecordId ? "feedback" : "all"), [d.storeFeedbackSourceRecordId]);
    useEffect(() => { if (screens.lg && tab === "materials") setTab("plan"); }, [screens.lg, tab]);
    useEffect(() => {
        if (wb.hydrated && editable && config.audioModel && !voiceOptions.includes(d.voice)) wb.edit({ voice: cloudSpeech ? "Vivian" : "alloy" }, "speech");
    }, [wb.hydrated, editable, cloudSpeech, config.audioModel, d.voice]);
    useEffect(() => {
        if (wb.hydrated && editable && d.speech && !speechCurrent && d.final && !d.storeFinishStale) wb.patch({ storeFinishStale: true });
    }, [wb.hydrated, editable, speechCurrent, d.speech, d.final, d.storeFinishStale]);
    const viewRecord = async (record: VideoRecord) => {
        try {
            setViewed({ ...record, ...(record.result ? { result: await restoreWorkbenchFile(record.result) } : {}) });
            setTab("result");
        } catch (error) { message.error(error instanceof Error ? error.message : "作品读取失败"); }
    };
    useEffect(() => {
        const record = wb.records.find((r) => r.id === previewRecordId);
        if (!record) return;
        useVideoWorkbenchStore.getState().setStorePreviewRecord("");
        void viewRecord(record);
    }, [previewRecordId, wb.records]);
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
    const saveVersion = () => [...(d.storePlanVersions || []), { script: d.script, shots, referenceIds: d.storeReferenceIds, createdAt: Date.now() }];
    const edit = (field: Editor, value: string) =>
        wb.edit(
            { [field]: value, ...(field === "script" ? { storeShots: [], ...(shots.length ? { storeReferenceIds: selectedIds } : {}), storeScriptStale: false, ...(shots.length ? { storePlanVersions: saveVersion() } : {}) } : field === "analysis" ? { storeAnalysisStale: false } : {}) },
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
            message.warning("原稿、资料或素材已变化，请重新生成修改建议");
            return;
        }
        const castError = storeCastReferenceError(d, (d.storeShotSuggestion || []).flatMap((s) => s.materialIds));
        if (castError) {
            message.warning(castError);
            return;
        }
        wb.edit({
            script: d.storeScriptSuggestion!,
            storeShots: d.storeShotSuggestion || [],
            storePlanVersions: saveVersion(),
            storeScriptSuggestion: "",
            storeShotSuggestion: undefined,
            storeScriptReview: undefined,
            storeScriptUnderstanding: undefined,
            storeScriptStale: false,
            storeScriptTurns: (d.storeScriptTurns || []).map((turn) => turn.status === "pending" ? { ...turn, status: "accepted" as const } : turn),
        }, "video");
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
                const current = useVideoWorkbenchStore.getState().storeProjects[wb.projectId].draft;
                wb.patch({ media: current.media.map((m) => added.some((a) => a.id === m.id) ? { ...m, storePurpose: storeSuggestedPurpose(m.name) } : m) });
            }
            if (Array.isArray(added)) setMaterialPicker((current) => current ? { ...current, ids: [...new Set([...current.ids, ...added.map((m) => m.id)])] } : null);
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
            if (assetRole === "voice" && payload.kind === "audio") {
                const blob = payload.storageKey ? await getMediaBlob(payload.storageKey) : null;
                let fileBlob = blob;
                if (!fileBlob) {
                    const response = await fetch(payload.url);
                    if (!response.ok) throw new Error("素材读取失败");
                    fileBlob = await response.blob();
                }
                const mimeType = payload.mimeType || fileBlob.type || "audio/mpeg";
                const extension = mimeType === "audio/wav" || mimeType === "audio/x-wav" || mimeType === "audio/wave" ? ".wav" : ".mp3";
                const name = /\.(wav|mp3)$/i.test(payload.title) ? payload.title : `${payload.title}${extension}`;
                if (await addPersonVoice(new File([fileBlob], name, { type: mimeType }))) setAssetRole(null);
                return;
            }
            if (assetRole === "voice") throw new Error("请选择音频");
            if (payload.kind !== "image") throw new Error("请选择图片");
            const blob = await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob();
            if (await addFiles([new File([blob], payload.title, { type: blob.type })], assetRole)) setAssetRole(null);
        } catch (e) {
            message.error(e instanceof Error ? e.message : "素材读取失败");
        }
    };
    const addPersonVoice = async (file: File) => {
        if (locked || uploadLock.current) return false;
        uploadLock.current = true;
        setUploading(true);
        try {
            const added = await wb.addFiles([file], "voice", "audio/*");
            return Array.isArray(added);
        } finally {
            uploadLock.current = false;
            setUploading(false);
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
            content: "以本版素材、资料和脚本新建独立项目。",
            okText: "新建项目",
            cancelText: "取消",
            onOk: async () => {
                if (!r.storeExploreInput) return;
                const { channelMode: _c, baseUrl: _b, ...input } = r.storeExploreInput;
                const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                const project = useVideoWorkbenchStore.getState().storeProjects[wb.projectId];
                await useVideoWorkbenchStore.getState().createStoreProject(`${project.name} · 新版本`, { ...emptyVideoDraft("store-explore"), ...input, media, video: null, final: null, speech: null, storeSpeechKey: undefined, subtitles: [], storeOutputStale: false });
            },
        });
    const startFeedbackRevision = async (r: VideoRecord) => {
        if (!r.storeExploreInput || !r.result || r.status !== "completed" || r.stage !== "video") return;
        if (!r.storeExploreInput.storeShots?.length) {
            message.warning("该版本没有结构化镜头快照，暂不能按受影响镜头定向改稿");
            return;
        }
        try {
            const { channelMode: _channelMode, baseUrl: _baseUrl, ...input } = r.storeExploreInput;
            const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
            const video = await restoreWorkbenchFile(r.result);
            const project = useVideoWorkbenchStore.getState().storeProjects[wb.projectId];
            await useVideoWorkbenchStore.getState().createStoreProject(`${project.name} · 成片反馈`, {
                ...emptyVideoDraft("store-explore"),
                ...input,
                media,
                video,
                final: null,
                speech: null,
                storeSpeechKey: undefined,
                subtitles: [],
                storeAdoptedVideoId: r.id,
                storeFeedbackSourceRecordId: r.id,
                storeOutputStale: false,
                storeScriptSuggestion: "",
                storeShotSuggestion: undefined,
                storeScriptReview: undefined,
                storeScriptUnderstanding: undefined,
                storeSuggestionBase: undefined,
            });
            setFeedbackSeconds(null);
            setRequest("");
            message.success("已新建独立的成片反馈项目，原项目和成片保持不变");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法创建成片反馈项目");
        }
    };
    const adoptResult = (record: VideoRecord) => {
        if (locked || !record.storeExploreInput || record.status !== "completed") return;
        const snapshot = { ...emptyVideoDraft("store-explore"), ...record.storeExploreInput };
        if (record.stage !== "video" && (d.video?.storageKey || d.video?.url) !== (snapshot.video?.storageKey || snapshot.video?.url)) {
            message.warning("此结果属于另一版视频，请先采用对应原片，或基于本版新建项目");
            return;
        }
        modal.confirm({
            title: "采用本版",
            content: "采用本版的输入与结果。当前输入如有变化，会先另存为独立项目。",
            okText: "采用",
            cancelText: "取消",
            onOk: async () => {
                setAdopting(true);
                try {
                    const state = useVideoWorkbenchStore.getState(), project = state.storeProjects[wb.projectId];
                    const changed = project.revision !== record.storeProjectRevision || storePlanKey(d) !== storePlanKey(snapshot) || JSON.stringify([d.narration, d.voice, d.storeAudioMode, d.subtitles, d.addSubtitles, d.musicVolume, d.subtitleSize, d.subtitleColor, d.speech?.storageKey, d.final?.storageKey]) !== JSON.stringify([snapshot.narration, snapshot.voice, snapshot.storeAudioMode, snapshot.subtitles, snapshot.addSubtitles, snapshot.musicVolume, snapshot.subtitleSize, snapshot.subtitleColor, snapshot.speech?.storageKey, snapshot.final?.storageKey]);
                    if (changed) await state.createStoreProject(`${project.name} · 采用前草稿`, project.draft, false);
                    const media = await Promise.all(snapshot.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    for (const field of ["video", "speech", "final"] as const) {
                        if (snapshot[field]) snapshot[field] = await restoreWorkbenchFile(snapshot[field]!);
                    }
                    const output = { ...record.draftPatch };
                    if (record.result) {
                        const file = await restoreWorkbenchFile(record.result);
                        if (record.stage === "video") output.video = file;
                        if (record.stage === "compose") output.final = file;
                        if (record.stage === "speech") output.speech = file;
                    }
                    wb.patch({
                        ...snapshot, media, ...output, activeRecord: record.id, storeOutputStale: false, storeScriptStale: false, storeAnalysisStale: false,
                        ...(record.stage === "video" ? { storeAdoptedVideoId: record.id, final: null, subtitles: [], storeSubtitleSource: undefined, storeOutputStale: false, storeFinishStale: true } : {}),
                        storeScriptSuggestion: "", storeShotSuggestion: undefined, storeScriptReview: undefined, storeSuggestionBase: undefined,
                        storeAnalysisSuggestion: "", storeMaterialSuggestion: undefined, storeKeyframeSuggestion: undefined, storeKeyframeKey: undefined,
                    }, true);
                    await flushWorkbenchStorage();
                    setViewed(null);
                    message.success("已采用本版");
                } finally { setAdopting(false); }
            },
        });
    };
    const icon = (title: string, node: React.ReactNode, action: () => void, disabled = locked) => (
        <Tooltip title={title}>
            <Button aria-label={title} type="text" size="small" disabled={disabled} icon={node} onClick={action} />
        </Tooltip>
    );
    const openMaterialPicker = (shotId: string | null) => {
        setMaterialSearch("");
        setMaterialPicker({ shotId, ids: shotId ? shots.find((s) => s.id === shotId)?.materialIds || [] : d.storeReferenceIds || [] });
    };
    const materialThumbnails = (ids: string[], onClick: () => void, label: string, need?: string) => (
        <div className="flex flex-wrap items-center gap-2" aria-label={label}>
            {ids.map((id) => {
                const m = d.media.find((v) => v.id === id);
                return m ? (
                    <Tooltip key={id} title={`${m.name} · 点击更换`}>
                        <button type="button" aria-label={`更换${m.name}`} disabled={locked} onClick={onClick} className="h-14 w-14 shrink-0 overflow-hidden rounded border" style={border}>
                            <img src={m.url} alt={m.name} className="h-full w-full object-cover" />
                        </button>
                    </Tooltip>
                ) : <Button key={id} danger size="small" disabled={locked} onClick={onClick}>重新选择已移除素材</Button>;
            })}
            <Tooltip title="添加或更换参考图片">
                <Button aria-label={label} type="text" disabled={locked} icon={<Plus size={18} />} onClick={onClick} className="!h-14 !w-14 shrink-0" />
            </Tooltip>
            {!ids.length && <span className="text-xs" style={muted}>{need ? `建议补充${need}` : "根据描述生成 · 可补充实拍参考"}</span>}
        </div>
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
                            <Button aria-label={`添加${title}`} size="small" type="text" icon={<Plus size={15} />}>{role === "reference" ? "补充素材" : "添加"}</Button>
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
            {candidates.length > 0 && <p className="text-xs" style={muted}>已添加 {candidates.length} 张 · 已采用 {selectedIds.length} 张</p>}
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
                    {
                        key: "person",
                        label: `出镜人物 · ${d.media.filter((m) => m.role === "model").length} 张${personVoice ? " · 已设音色" : ""}`,
                        children: (
                            <div className="space-y-4">
                                {materialField("model", "人物参考")}
                                <section className="min-w-0 space-y-2" aria-label="人物音色">
                                    <div className="flex flex-wrap items-center justify-between gap-1">
                                        <strong className="inline-flex items-center gap-1 text-sm font-medium"><Mic size={14} />人物音色</strong>
                                        <Upload
                                            accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg"
                                            showUploadList={false}
                                            disabled={locked || !cast.length}
                                            beforeUpload={(file) => { void addPersonVoice(file); return Upload.LIST_IGNORE; }}
                                        >
                                            <Button type="text" size="small" aria-label={personVoice ? "更换人物音色" : "上传人物音色"} disabled={locked || !cast.length} icon={personVoice ? <RefreshCw size={14} /> : <Plus size={14} />}>
                                                {personVoice ? "更换" : "上传录音"}
                                            </Button>
                                        </Upload>
                                        <Button type="text" size="small" aria-label="从素材库选择人物音色" disabled={locked || !cast.length} icon={<Library size={14} />} onClick={() => setAssetRole("voice")}>
                                            素材库
                                        </Button>
                                    </div>
                                    <p className="text-xs" style={muted}>本人或已授权录音 · WAV / MP3 · {storeVoiceMinimumSeconds(cfg)}–15 秒 · 最大 15 MB</p>
                                    {!cast.length && <p className="text-xs" style={muted}>请先添加出镜人物参考</p>}
                                    {personVoice && (
                                        <>
                                            <div className="flex min-w-0 items-center gap-1">
                                                <span className="min-w-0 flex-1 truncate text-xs" title={personVoice.name}>{personVoice.name} · {((personVoice.durationMs || 0) / 1000).toFixed(1)} 秒</span>
                                                {icon("移除人物音色", <X size={13} />, () => wb.removeMedia(personVoice.id))}
                                            </div>
                                            <audio key={personVoice.id} aria-label="试听人物音色" controls preload="metadata" src={personVoice.url} className="block h-10 w-full min-w-0" />
                                            {cast.length === 1 && personVoice.storePerson === cast[0].name ? (
                                                <p className="break-words text-xs" style={muted}>对应人物：{cast[0].name}</p>
                                            ) : (
                                                <Select
                                                    aria-label="音色对应人物"
                                                    className="w-full"
                                                    placeholder="选择音色对应人物"
                                                    disabled={locked}
                                                    value={cast.some((person) => person.name === personVoice.storePerson) ? personVoice.storePerson : undefined}
                                                    options={cast.map((person) => ({ value: person.name, label: person.name }))}
                                                    onChange={(storePerson) => wb.edit({ media: d.media.map((m) => m.id === personVoice.id ? { ...m, storePerson } : m) }, "video")}
                                                />
                                            )}
                                        </>
                                    )}
                                    {personVoiceError && <p role="status" className="text-xs" style={{ color: token.colorWarningText }}>{personVoiceError}</p>}
                                </section>
                            </div>
                        ),
                    },
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
                    {spec} · {audioMode === "narration" ? "独立旁白" : audioMode === "mute" ? "去除原声" : personVoice ? "人物音色" : "保留原声"}
                </span>
                <Button size="small" type="text" icon={<Settings2 size={14} />} onClick={() => setSettingsOpen(true)}>
                    设置
                </Button>
            </div>
            {d.script && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span style={overLimit ? { color: token.colorWarningText } : muted}>本次参考图 {actualMaterials.length}/{mode === "reference" ? profile.maxImages : mode === "first_last" && !wan ? 2 : 1} 张</span>
                    {mode === "reference" && (!shots.length ? (
                        <Button type="link" size="small" disabled={locked} onClick={() => openMaterialPicker(null)}>选择参考图</Button>
                    ) : null)}
                </div>
            )}
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
                <Button block type="primary" size="large" disabled={locked || primary.disabled} loading={busy ? { icon: <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden /> } : false} icon={<Sparkles size={16} />} onClick={primary.action}>
                    {busy ? storeTaskTitle(active?.stage) : primary.label}
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
                <StoreProjectPanel disabled={uploading || adopting} />
                <Button aria-label="门店方案" type="text" icon={<Save size={15} />} onClick={() => setPresetsOpen(true)}>
                    <span className="hidden sm:inline">门店方案</span>
                </Button>
            </header>
            {wb.storageError && <Alert type="error" title={wb.storageError} showIcon />}
            {!editable && wb.hydrated && <Alert type="info" showIcon title="此项目正在另一标签页编辑，可查看进度或新建项目" />}
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
                        {busy && <StoreTaskProgress key={active?.id || "preparing"} record={active} onStop={wb.stop} />}
                        {!busy && pending && querying[pending.id] ? <StoreTaskProgress record={pending} onStop={() => stopStoreTask(pending.id)} /> : !busy && pending && (
                            <Alert
                                className="mb-3"
                                type="info"
                                title="任务已保留，可继续制作其他版本"
                                description={
                                    <Button size="small" onClick={() => void wb.resume(pending)}>
                                        查询原任务结果
                                    </Button>
                                }
                            />
                        )}
                        {!busy && active?.error && <Alert className="mb-3" type="warning" title={`${active.stage === "video" ? `${active.storeOrigin?.modelLabel || active.modelTask?.model || "视频任务"}：` : ""}${publicServiceText(active.error)}`} />}
                        <div ref={mainScroll} className="min-h-0 flex-1 overflow-y-auto pb-3" data-testid="store-main-scroll">
                            {tab === "materials" && <div className="max-w-xl py-2">{materialsPanel}</div>}
                            {tab === "plan" && (
                                <div className={`space-y-4 py-2 ${!busy && active?.stage === "script" && active.status === "completed" ? "animate-in fade-in duration-300 motion-reduce:animate-none" : ""}`} aria-busy={busy && active?.stage === "script"}>
                                    {d.storeFeedbackSourceRecordId && d.video && (
                                        <section className="space-y-3 border-b pb-4" style={border} aria-label="成片反馈来源">
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <strong className="text-sm font-medium">根据已生成成片反馈</strong>
                                                <span className="text-xs" style={muted}>来源任务：{d.storeFeedbackSourceRecordId}</span>
                                            </div>
                                            <video ref={feedbackVideoRef} controls src={d.video.url} className="max-h-[42vh] min-h-40 w-full bg-black object-contain" />
                                            <div className="flex flex-wrap items-center gap-2">
                                                <InputNumber aria-label="反馈画面时间点" disabled={!d.video.storageKey} min={0} max={(d.video.durationMs || 0) / 1000 || undefined} step={0.1} value={feedbackSeconds} onChange={setFeedbackSeconds} addonAfter="秒" />
                                                <Button size="small" disabled={!d.video.storageKey} onClick={() => setFeedbackSeconds(Number((feedbackVideoRef.current?.currentTime || 0).toFixed(2)))}>使用当前播放位置</Button>
                                                {feedbackSeconds !== null && <Button size="small" onClick={() => setFeedbackSeconds(null)}>不发送画面</Button>}
                                            </div>
                                            <p className="text-xs" style={muted}>{!d.video.storageKey ? "该视频无法从本地素材库读取画面，本轮可使用文字反馈，但不能附加成片截图。" : feedbackSeconds === null ? "未选择时间点：本轮只向文案模型发送文字反馈和原方案，不发送成片画面。" : `本轮会截取成片 ${feedbackSeconds.toFixed(2)} 秒处的一帧，随反馈发送给所选文案模型；不会上传整段视频。`}</p>
                                        </section>
                                    )}
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <h2 ref={planHeading} tabIndex={-1} className="text-base font-medium">{shots.length ? `${shots.length} 个镜头 · ${shots.at(-1)?.end} 秒` : "拍摄方案"}</h2>
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
                                                    wb.edit({ script: last.script, storeShots: last.shots, storeReferenceIds: last.referenceIds, storePlanVersions: versions.slice(0, -1) }, "video");
                                                },
                                                locked || !d.storePlanVersions?.length,
                                            )}
                                            <Button size="small" icon={<Expand size={13} />} onClick={() => setEditor("script")}>
                                                自由编辑
                                            </Button>
                                        </Space>
                                    </div>
                                    {d.storeScriptStale && d.script && <Alert type="warning" title="资料或规格已变化，原方案已保留，请核对后调整" />}
                                    {d.script && candidates.length > 0 && mode === "reference" && profile.maxImages > 0 && (overLimit || !shots.length || shots.some((s) => !s.materialIds.length)) && (
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                            <span style={muted}>{overLimit ? `已选 ${actualMaterials.length} 张，当前模型最多 ${profile.maxImages} 张` : "可用已有素材为镜头配图"}</span>
                                            <Button size="small" icon={<Sparkles size={14} />} disabled={locked || Boolean(textError())} onClick={() => void wb.run(overLimit ? "material-select" : "material-match")}>{overLimit ? "AI 精选参考图" : "AI 匹配素材"}</Button>
                                        </div>
                                    )}
                                    {d.storeMaterialSuggestion && mode === "reference" && (
                                        <section className="space-y-3 border-l-2 pl-3" style={{ borderColor: token.colorPrimary }} aria-label="待采用配图">
                                            <strong className="text-sm font-medium">配图建议 · 待采用</strong>
                                            {(shots.length ? d.storeMaterialSuggestion.shots : [{ id: "", materialIds: d.storeMaterialSuggestion.referenceIds }]).map((s) => (
                                                <div key={s.id} className="flex flex-wrap items-center gap-2">
                                                    <span className="text-xs">{s.id ? `镜头 ${shots.findIndex((v) => v.id === s.id) + 1}` : "本次参考"}</span>
                                                    {s.materialIds.length ? s.materialIds.map((id) => {
                                                        const m = d.media.find((v) => v.id === id);
                                                        return m ? <img key={id} src={m.url} alt={m.name} title={m.name} className="h-14 w-14 rounded object-cover" /> : null;
                                                    }) : <span className="text-xs" style={muted}>没有合适参考，保留描述生成</span>}
                                                </div>
                                            ))}
                                            <Space wrap>
                                                <Button type="primary" size="small" disabled={locked || d.storeMaterialSuggestion.base !== storeMaterialKey(d, profile.maxImages)} onClick={() => {
                                                    const suggestion = d.storeMaterialSuggestion!;
                                                    const next = shots.map((s) => ({ ...s, materialIds: suggestion.shots.find((v) => v.id === s.id)!.materialIds }));
                                                    wb.edit({
                                                        storePlanVersions: saveVersion(),
                                                        ...(shots.length ? { storeShots: next, script: renderStoreShots(next, d) } : { storeReferenceIds: suggestion.referenceIds }),
                                                        storeMaterialSuggestion: undefined,
                                                    }, "video");
                                                }}>采用配图</Button>
                                                <Button size="small" disabled={locked} onClick={() => wb.patch({ storeMaterialSuggestion: undefined })}>保留原选择</Button>
                                            </Space>
                                            {d.storeMaterialSuggestion.base !== storeMaterialKey(d, profile.maxImages) && <p className="text-xs" style={muted}>方案、素材或模型上限已变化，请重新匹配。</p>}
                                        </section>
                                    )}
                                    {busy && active?.stage === "script" && !d.script && !shots.length && <StorePlanSkeleton />}
                                    {!d.script && !shots.length && !(busy && active?.stage === "script") && (
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
                                                  {materialThumbnails(s.materialIds, () => openMaterialPicker(s.id), `镜头${i + 1}素材`, s.referenceNeed)}
                                                  <Input.TextArea aria-label={`镜头${i + 1}台词`} autoSize={{ minRows: 1 }} placeholder="台词（可选）" disabled={locked} value={s.dialogue} onChange={(e) => updateShot(s.id, { dialogue: e.target.value })} />
                                              </article>
                                          ))
                                        : d.script && <>{mentions("script", 12)}{mode === "reference" && materialThumbnails(d.storeReferenceIds || [], () => openMaterialPicker(null), "本次参考图")}</>}
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
                                                options={[...(d.storeFeedbackSourceRecordId ? [{ value: "feedback", label: "按成片反馈定位" }] : []), { value: "all", label: "整稿改写" }, ...shots.map((s, i) => ({ value: s.id, label: `只改镜头 ${i + 1}` }))]}
                                            />
                                            <Input aria-label="AI修改要求" className="min-w-0 flex-1" value={request} disabled={locked} onChange={(e) => setRequest(e.target.value)} placeholder={d.storeScriptSuggestion ? "继续说要怎么调整这份候选方案" : "例如：缩短台词，保留画面"} />
                                            <Dropdown disabled={locked} menu={{
                                                items: [{ key: "spoken", label: "更口语" }, { key: "shorter", label: "精简台词" }, { key: "opening", label: "换个开头" }],
                                                onClick: ({ key }) => {
                                                    setRequest(key === "spoken" ? "台词改得更口语，保留事实与画面" : key === "shorter" ? "精简台词，保留核心信息与画面" : "换一个具体自然的开头，保留事实和原时长");
                                                    if (key === "opening") setScope(shots[0]?.id || "all");
                                                },
                                            }} trigger={["click"]}>
                                                <Button aria-label="常用修改要求" title="常用修改要求" icon={<Pencil size={14} />} />
                                            </Dropdown>
                                            <Button
                                                disabled={locked || !request.trim() || Boolean(textError()) || (scope !== "all" && scope !== "feedback" && !shots.some((s) => s.id === scope))}
                                                icon={<Sparkles size={14} />}
                                                onClick={() => void wb.reviseScript(JSON.stringify({
                                                    request,
                                                    ...(scope !== "all" && d.storeFeedbackSourceRecordId ? { feedbackVideoRecordId: d.storeFeedbackSourceRecordId, ...(feedbackSeconds !== null ? { feedbackTimeSeconds: feedbackSeconds } : {}), ...(scope !== "feedback" ? { ids: [scope] } : {}) } : scope === "all" ? { rewrite: true } : { ids: [scope] }),
                                                }))}
                                            >
                                                {d.storeScriptSuggestion ? "继续调整候选" : "生成修改预览"}
                                            </Button>
                                        </div>
                                    )}
                                    {(d.storeScriptTurns || []).length > 0 && (
                                        <section className="space-y-2 border-t pt-3" style={border} aria-label="方案改编对话记录">
                                            <div className="flex items-center justify-between gap-2">
                                                <strong className="text-sm font-medium">改编记录</strong>
                                                <span className="text-xs" style={muted}>{d.storeScriptTurns!.length} 轮</span>
                                            </div>
                                            {d.storeScriptTurns!.slice(-4).map((turn, index) => (
                                                <div key={turn.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                                                    <span style={muted}>第 {Math.max(1, d.storeScriptTurns!.length - Math.min(4, d.storeScriptTurns!.length) + index + 1)} 轮 · {turn.scope}</span>
                                                    <span>{turn.request}</span>
                                                    <span style={{ color: turn.status === "pending" ? token.colorPrimary : token.colorTextSecondary }}>
                                                        {turn.status === "pending" ? "待确认" : turn.status === "accepted" ? "已采用" : turn.status === "rejected" ? "已放弃" : "被后续修改替代"}
                                                    </span>
                                                </div>
                                            ))}
                                        </section>
                                    )}
                                    {d.storeScriptSuggestion && (
                                        <section ref={planSuggestion} tabIndex={-1} aria-label="待采用方案" className="space-y-3 border-l-2 pl-3" style={{ borderColor: token.colorPrimary }}>
                                            <strong className="text-sm font-medium">待采用方案</strong>
                                            {d.storeScriptReview && <p className="text-xs" style={muted}>{d.storeScriptReview === "passed" ? "已完成脚本检查，请核对后采用。" : d.storeScriptReview === "local" ? "仅修改所选镜头，未追加整稿检查。" : d.storeScriptReview === "feedback" ? "根据反馈生成了定向修改候选，尚未应用到正式方案。" : d.storeScriptReview === "pending" && busy ? "候选已保存，正在检查事实与台词。" : "未检查候选：检查未完成，请人工核对后决定是否采用；不会自动重试。"}</p>}
                                            {d.storeScriptReview === "feedback" && d.storeScriptUnderstanding && <Alert type="info" showIcon title={`AI 对问题的理解：${d.storeScriptUnderstanding}`} description={`本次仅调整：${pendingScriptTurn?.scope || "按反馈定位的镜头"}。请对照原片确认后再采用。`} />}
                                            {pendingScriptTurn && <p className="text-xs" style={muted}>本轮范围：{pendingScriptTurn.scope} · {pendingScriptTurn.request}</p>}
                                            <div className="grid gap-3 md:grid-cols-2">
                                                <label className="block space-y-1 text-xs"><span>当前正式方案</span><Input.TextArea readOnly aria-label="当前正式方案" value={d.script} rows={8} /></label>
                                                <label className="block space-y-1 text-xs"><span>待确认候选</span><Input.TextArea readOnly aria-label="待采用方案" value={d.storeScriptSuggestion} rows={8} /></label>
                                            </div>
                                            <Space wrap>
                                                <Button type="primary" size="small" disabled={locked || d.storeSuggestionBase !== storePlanKey(d)} onClick={adopt}>
                                                    {d.storeScriptReview === "failed" || (d.storeScriptReview === "pending" && !busy) ? "采用未检查方案" : "采用方案"}
                                                </Button>
                                                <Button size="small" disabled={locked} onClick={() => wb.patch({
                                                    storeScriptSuggestion: "", storeShotSuggestion: undefined, storeScriptReview: undefined,
                                                    storeScriptUnderstanding: undefined,
                                                    storeScriptTurns: (d.storeScriptTurns || []).map((turn) => turn.status === "pending" ? { ...turn, status: "rejected" as const } : turn),
                                                })}>
                                                    {d.script ? "保留原稿" : "放弃候选"}
                                                </Button>
                                            </Space>
                                            {d.storeSuggestionBase !== storePlanKey(d) && (
                                                <p className="text-xs" style={muted}>
                                                    原稿、资料、素材或规格已变化，请重新生成建议。
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
                                    <section className="space-y-2" aria-label="生成版本">
                                        {wb.records.filter((r) => r.stage === "video" && r.status === "completed" && r.result).map((r) => (
                                            <div key={r.id} className="flex min-w-0 flex-wrap items-center gap-2 border-b py-2" style={border}>
                                                <span className="min-w-0 flex-1 break-words text-xs">{r.storeOrigin?.modelLabel || r.modelTask?.model || "视频"} · {new Date(r.createdAt).toLocaleString()}{d.storeAdoptedVideoId === r.id ? " · 当前采用" : ""}</span>
                                                <Button size="small" onClick={() => void viewRecord(r)}>预览</Button>
                                                <Button size="small" disabled={locked || d.storeAdoptedVideoId === r.id} onClick={() => adoptResult(r)}>采用本版</Button>
                                                <Button size="small" disabled={locked || !r.storeExploreInput} onClick={() => void startFeedbackRevision(r)}>根据成片反馈优化脚本</Button>
                                            </div>
                                        ))}
                                    </section>
                                    {viewed && (
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <span className="text-sm">历史版本 · {new Date(viewed.createdAt).toLocaleString()}</span>
                                            <Space wrap>
                                            {["video", "speech", "subtitles", "compose"].includes(viewed.stage) && viewed.status === "completed" && <Button size="small" disabled={locked} onClick={() => adoptResult(viewed)}>采用本版</Button>}
                                            <Button size="small" onClick={() => setViewed(null)}>
                                                返回当前
                                            </Button>
                                            </Space>
                                        </div>
                                    )}
                                    {!viewed && result && (d.storeOutputStale || (d.final && d.storeFinishStale)) && <Alert type="warning" title={d.storeOutputStale ? "方案已变化，当前显示此前作品" : "声音或字幕已变化，当前显示此前成片"} />}
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
                                    ) : viewed?.draftPatch?.subtitles ? (
                                        <Input.TextArea readOnly rows={12} value={viewed.draftPatch.subtitles.map((s) => `${s.start}–${s.end} ${s.text}`).join("\n")} />
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
                                                    {personVoice ? "已选择人物音色参考，生成后需核对实际声音与口型。" : profile.generateAudio && cfg.videoGenerateAudio === "true" ? "已请求模型生成声音，需核对实际结果与口型。" : "保留已有音轨；当前设置未请求模型生成声音。"}
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
                                                    {storeRecordStatus(r)} · {new Date(r.createdAt).toLocaleString()}
                                                </span>
                                            </div>
                                            {r.error && (
                                                <p className="text-xs" style={{ color: token.colorWarningText }}>
                                                    {publicServiceText(r.error)}
                                                </p>
                                            )}
                                            <Space wrap>
                                                {(r.result || r.text || r.draftPatch?.subtitles) && (
                                                    <Button
                                                        size="small"
                                                        onClick={() => void viewRecord(r)}
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
            <Modal
                open={Boolean(materialPicker)}
                title={materialPicker?.shotId ? `镜头 ${shots.findIndex((s) => s.id === materialPicker.shotId) + 1} · 参考图片` : "本次参考图片"}
                width={760}
                style={{ top: 16, maxWidth: "calc(100vw - 24px)" }}
                styles={{
                    container: { maxHeight: "calc(100dvh - 32px)", display: "flex", flexDirection: "column" },
                    body: { minHeight: 0, overflowY: "auto" },
                }}
                onCancel={() => { if (!uploading) setMaterialPicker(null); }}
                footer={<Space wrap>
                    <Button disabled={locked} onClick={() => setMaterialPicker(null)}>取消</Button>
                    <Button type="primary" disabled={locked} onClick={() => {
                        if (!materialPicker) return;
                        if (materialPicker.shotId) updateShot(materialPicker.shotId, { materialIds: materialPicker.ids });
                        else wb.edit({ storeReferenceIds: materialPicker.ids }, "video");
                        setMaterialPicker(null);
                    }}>采用所选{materialPicker?.ids.length ? ` ${materialPicker.ids.length} 张` : ""}</Button>
                </Space>}
            >
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Input aria-label="搜索参考图片" placeholder="搜索素材名称" className="!w-full sm:!w-56" value={materialSearch} onChange={(e) => setMaterialSearch(e.target.value)} allowClear />
                        <Upload accept="image/*" multiple showUploadList={false} disabled={locked} beforeUpload={(file, list) => {
                            if (file === list[0]) void addFiles(list, "reference");
                            return Upload.LIST_IGNORE;
                        }}><Button disabled={locked} loading={uploading} icon={<Plus size={14} />}>上传照片</Button></Upload>
                        <Button disabled={locked} icon={<Images size={14} />} onClick={() => setAssetRole("reference")}>素材库</Button>
                    </div>
                    <div className="max-h-[55vh] space-y-4 overflow-auto">
                        {[true, false].map((selected) => {
                            const items = candidates.filter((m) => Boolean(materialPicker?.ids.includes(m.id)) === selected && (!materialSearch.trim() || `${m.name} ${m.storePerson || ""} ${m.storePurpose || ""}`.toLowerCase().includes(materialSearch.trim().toLowerCase())));
                            return items.length > 0 && <section key={String(selected)} className="space-y-2">
                                <strong className="text-xs font-medium">{selected ? "已选择" : "其他素材"}</strong>
                                <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                                    {items.map((m) => <button key={m.id} type="button" disabled={locked} aria-label={`${selected ? "取消选择" : "选择"}${m.name}`} aria-pressed={selected} className="min-w-0 text-left" onClick={() => setMaterialPicker((current) => current ? { ...current, ids: selected ? current.ids.filter((id) => id !== m.id) : [...current.ids, m.id] } : null)}>
                                        <div className="relative aspect-square overflow-hidden rounded border-2" style={{ borderColor: selected ? token.colorPrimary : token.colorBorderSecondary }}>
                                            <img src={m.url} alt={m.name} className="h-full w-full object-cover" />
                                            {selected && <Check size={20} className="absolute right-1 top-1 rounded p-0.5" style={{ background: token.colorPrimary, color: token.colorTextLightSolid }} />}
                                        </div>
                                        <span className="mt-1 block truncate text-xs" title={m.name}>{m.name}</span>
                                        <span className="block truncate text-xs" style={muted}>{m.storePerson || m.storePurpose || labels.find((l) => l.id === m.id)?.label}</span>
                                    </button>)}
                                </div>
                            </section>;
                        })}
                        {!candidates.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="补充照片作为参考" />}
                    </div>
                    {materialPicker?.ids.some((id) => !candidates.some((m) => m.id === id)) && <Button danger size="small" onClick={() => setMaterialPicker((current) => current ? { ...current, ids: current.ids.filter((id) => candidates.some((m) => m.id === id)) } : null)}>移除失效引用</Button>}
                    <p className="text-xs" style={muted}>{mode === "reference" ? `整条视频图片去重后最多 ${profile.maxImages} 张，人物参考也计入。` : "镜头配图用于编写方案，生成只发送指定首帧或尾帧。"}</p>
                </div>
            </Modal>
            <AssetPickerModal open={Boolean(assetRole)} allowedKinds={assetRole === "voice" ? ["audio"] : undefined} onClose={() => setAssetRole(null)} onInsert={(p) => void insertAsset(p)} />
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
