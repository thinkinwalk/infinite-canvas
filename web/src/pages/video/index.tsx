import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, LoaderCircle, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { App, Button, Checkbox, Empty, Input, Mentions, Modal, Select, Switch, Tabs, Tag, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import type { MentionsRef } from "antd/es/mentions";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { VideoModelOption } from "@/components/video-model-option";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { normalizeVideoResolutionValue, normalizeVideoSizeValue, videoSizeLabel } from "@/components/video-settings-panel";
import { clampVideoSeconds } from "@/lib/media-size";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { deleteStoredMedia, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { createVideoGenerationTask, isVideoTaskFailed, quoteVideoModel, storeGeneratedVideo, waitForVideoGenerationTask, type VideoGenerationTask, type VideoTaskWaitState, type VideoPrice } from "@/services/api/video";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { boolConfig, modelOptionLabel, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { videoInputMode, videoProfile, videoReferenceError, videoInputDescription, remapMaterialMentions, materialMentionError } from "@/lib/video-capabilities";
import { inferVideoRatio, computeVideoSize } from "@/lib/media-size";
import { publicServiceText, REPLICATE_VIDEO_MODEL, HAILUO_VIDEO_MODEL, isReplicateVideoModel } from "@/services/api/replicate";
import { useReplicateConfirmation } from "@/hooks/use-replicate-confirmation";
import { useVideoCreationConfig } from "./use-video-creation-config";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import { imageToDataUrl } from "@/services/image-storage";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import type { ReferenceVideo, ReferenceAudio } from "@/types/media";
import i18n from "@/i18n";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    waitState?: VideoTaskWaitState;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoInputMode" | "videoInterpolate">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:video_generation_logs";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

export default function VideoPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const audioInputRef = useRef<HTMLInputElement>(null);
    const promptInputRef = useRef<MentionsRef>(null);
    const token = useUserStore((state) => state.token);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const activeLogControllersRef = useRef<Map<string, AbortController>>(new Map());
    const effectiveConfig = useVideoCreationConfig();
    const loadingModels = useConfigStore((state) => state.isPublicSettingsLoading);
    const modelsError = useConfigStore((state) => state.publicSettingsError);
    const confirmReplicate = useReplicateConfirmation();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [videoReferences, setVideoReferences] = useState<ReferenceVideo[]>([]);
    const [audioReferences, setAudioReferences] = useState<ReferenceAudio[]>([]);
    const [writing, setWriting] = useState(false);
    const [writingError, setWritingError] = useState("");
    const [writingPreview, setWritingPreview] = useState("");
    const writingControllerRef = useRef<AbortController | null>(null);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [resultView, setResultView] = useState("results");
    const [writingOpen, setWritingOpen] = useState(false);
    const [writingBrief, setWritingBrief] = useState("");
    const [price, setPrice] = useState<VideoPrice | null>(null);
    const [priceError, setPriceError] = useState("");
    const [priceLoading, setPriceLoading] = useState(false);
    const [quoteRevision, setQuoteRevision] = useState(0);
    const pricingRevision = useConfigStore((state) => JSON.stringify(state.publicSettings?.modelChannel.modelCosts));
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const videoModels = selectableModelsByCapability(effectiveConfig, "video");
    const model = effectiveConfig.videoModel;
    const validVideoModel = Boolean(model && videoModels.includes(model));
    const isWan = model === REPLICATE_VIDEO_MODEL;
    const isHailuo = model === HAILUO_VIDEO_MODEL;
    const isCloudVideo = isReplicateVideoModel(model);
    const modelDirectoryUnavailable = Boolean(modelsError && (isCloudVideo || effectiveConfig.channelMode === "remote" || !isAiConfigReady(effectiveConfig, model)));
    const profile = videoProfile(effectiveConfig, model);
    const inputMode = videoInputMode(effectiveConfig, model);
    const frameMode = inputMode === "first_last";
    const firstFrameOnly = inputMode === "first_frame_only";
    const singleImage = firstFrameOnly;
    const referenceLimit = frameMode ? 2 : profile.maxImages;
    const materialLabels = [
        ...references.map((item, index) => ({ id: item.id, label: `图片${index + 1}`, name: item.name })),
        ...videoReferences.map((item, index) => ({ id: item.id, label: `视频${index + 1}`, name: item.name })),
        ...audioReferences.map((item, index) => ({ id: item.id, label: `音频${index + 1}`, name: item.name })),
    ];
    const referenceError = videoReferenceError(effectiveConfig, model, references.length, videoReferences.length, audioReferences.length) || materialMentionError(prompt, materialLabels);
    const quoteKey = [model, effectiveConfig.channelMode, effectiveConfig.vquality, effectiveConfig.videoSeconds, effectiveConfig.videoInputMode, token, quoteRevision, pricingRevision].join("|");
    useEffect(() => {
        if (profile.interface === "unavailable") return;
        if (profile.resolutions.length && !profile.resolutions.includes(normalizeResolution(effectiveConfig.vquality))) updateConfig("vquality", profile.resolutions[0]);
        if (profile.seconds.length && !profile.seconds.includes(effectiveConfig.videoSeconds)) updateConfig("videoSeconds", profile.seconds[0]);
    }, [model, profile.resolutions.join("|"), profile.seconds.join("|"), effectiveConfig.vquality, effectiveConfig.videoSeconds, updateConfig]);
    useEffect(() => {
        const controller = new AbortController();
        setPrice(null);
        setPriceError("");
        if (!validVideoModel || modelDirectoryUnavailable || !token || (!isCloudVideo && effectiveConfig.channelMode !== "remote")) { setPriceLoading(false); return; }
        setPriceLoading(true);
        void quoteVideoModel(effectiveConfig, model, controller.signal).then((quote) => { if (!controller.signal.aborted) setPrice(quote); }).catch((error) => { if (!controller.signal.aborted) setPriceError(publicServiceText(error instanceof Error ? error.message : "报价读取失败")); }).finally(() => { if (!controller.signal.aborted) setPriceLoading(false); });
        return () => controller.abort();
    }, [quoteKey, validVideoModel, modelDirectoryUnavailable]);
    const insertMention = (label: string) => {
        const input = promptInputRef.current?.textarea;
        const start = input?.selectionStart ?? prompt.length;
        const end = input?.selectionEnd ?? start;
        setPrompt(`${prompt.slice(0, start)}@${label} ${prompt.slice(end)}`);
        promptInputRef.current?.focus();
    };
    const changeImages = (next: ReferenceImage[]) => {
        setPrompt((value) => remapMaterialMentions(value, materialLabels, [...next.map((item, index) => ({ id: item.id, label: `图片${index + 1}` })), ...materialLabels.filter((item) => !item.label.startsWith("图片"))]));
        setReferences(next);
    };
    const removeMaterial = (id: string) => {
        const apply = () => {
            const nextImages = references.filter((item) => item.id !== id);
            const nextVideos = videoReferences.filter((item) => item.id !== id);
            const nextAudios = audioReferences.filter((item) => item.id !== id);
            const next = [...nextImages.map((item, index) => ({ id: item.id, label: `图片${index + 1}` })), ...nextVideos.map((item, index) => ({ id: item.id, label: `视频${index + 1}` })), ...nextAudios.map((item, index) => ({ id: item.id, label: `音频${index + 1}` }))];
            setPrompt((value) => remapMaterialMentions(value, materialLabels, next));
            setReferences(nextImages); setVideoReferences(nextVideos); setAudioReferences(nextAudios);
        };
        const label = materialLabels.find((item) => item.id === id)?.label;
        const mentions = prompt.match(/@(图片|视频|音频)\d+/g) || ([] as string[]);
        if (label && mentions.includes(`@${label}`)) modal.confirm({ title: `脚本正在引用 ${label}`, content: "移除后会标记缺失引用，生成前需要修改脚本。其他素材编号会自动更新。", okText: "移除素材", cancelText: "保留", onOk: apply });
        else apply();
    };
    useEffect(() => {
        const requested = new URLSearchParams(window.location.search).get("model");
        const value = requested === "wan" ? REPLICATE_VIDEO_MODEL : requested === "hailuo" ? HAILUO_VIDEO_MODEL : "";
        if (value && effectiveConfig.models.includes(value)) updateConfig("videoModel", value);
    }, [effectiveConfig.models.join("|"), updateConfig]);
    useEffect(() => {
        if (!isWan) return;
        if (effectiveConfig.videoInputMode !== "first_last") updateConfig("videoInputMode", "first_last");
        if (!["480", "720"].includes(normalizeResolution(effectiveConfig.vquality))) updateConfig("vquality", "480");
        if (!["5", "7.5"].includes(effectiveConfig.videoSeconds)) updateConfig("videoSeconds", "5");
    }, [isWan, effectiveConfig.vquality, effectiveConfig.videoSeconds, updateConfig]);
    const canGenerate = Boolean(prompt.trim() && validVideoModel && !modelDirectoryUnavailable);

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    useEffect(
        () => () => {
            writingControllerRef.current?.abort();
            activeLogControllersRef.current.forEach((controller) => controller.abort());
            activeLogControllersRef.current.clear();
        },
        [],
    );

    const addReferences = async (files?: FileList | File[] | null) => {
        if (!referenceLimit) { message.warning("当前模型不支持图片输入"); return; }
        const selectedFiles = Array.from(files || []);
        if (!selectedFiles.length) return;
        if (selectedFiles.filter((file) => file.type.startsWith("image/")).length + references.length > referenceLimit) { message.warning(`当前模型最多支持${referenceLimit}张图片，请减少选择数量`); return; }
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, referenceLimit - references.length));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, referenceLimit));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        if (running || writing) return;
        const files = Array.from(event.dataTransfer.files);
        void addReferences(files.filter((file) => file.type.startsWith("image/")));
        void addMediaReferences(files.filter((file) => !file.type.startsWith("image/")));
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.slice(0, Math.max(0, referenceLimit - references.length)).map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, referenceLimit));
            message.success(t("videoWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("videoWorkbench.clipboardEmpty"));
        }
    };
    const addMediaReferences = async (files: FileList | File[] | null) => {
        try {
            const selected = Array.from(files || []);
            if (selected.filter((item) => item.type.startsWith("video/")).length + videoReferences.length > profile.maxVideos || selected.filter((item) => item.type.startsWith("audio/")).length + audioReferences.length > profile.maxAudios) throw new Error("当前模型不支持这些素材或素材数量已达到上限");
            for (const file of Array.from(files || [])) {
                if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) throw new Error("请选择视频或音频文件");
                const media = await uploadMediaFile(file, "video-reference");
                const item = { ...media, id: nanoid(), name: file.name, type: file.type };
                if (file.type.startsWith("video/")) setVideoReferences((items) => [...items, item]);
                else setAudioReferences((items) => [...items, item]);
            }
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "参考素材上传失败"));
        }
    };
    const writePrompt = async () => {
        if (writingControllerRef.current) return;
        setWritingError("");
        setWritingPreview("");
        if (!writingBrief.trim()) {
            setWritingError("请先输入视频主题或制作要求。");
            return;
        }
        if (effectiveConfig.channelMode === "remote" && !useUserStore.getState().token) {
            setWritingError("请先点击页面右上角“登录”，登录后再使用 AI 代为撰写。");
            return;
        }
        const textModel = effectiveConfig.textModel;
        if (!textModel || !isAiConfigReady(effectiveConfig, textModel)) {
            setWritingError(effectiveConfig.channelMode === "remote" ? "平台尚未提供可用的文字模型，请联系管理员配置。" : "请配置可用的文字模型及渠道，然后重新点击 AI 代为撰写。");
            if (effectiveConfig.channelMode === "local") openConfigDialog(true, "channels");
            return;
        }
        const controller = new AbortController();
        writingControllerRef.current = controller;
        setWriting(true);
        try {
            if (effectiveConfig.channelMode === "remote") {
                const quote = await quoteVideoModel(effectiveConfig, textModel, controller.signal);
                await new Promise<void>((resolve, reject) => modal.confirm({ title: "确认AI代写费用", content: `${modelOptionLabel(effectiveConfig, textModel)}：本次 ${quote.credits} 算力点，与视频生成分开计费。`, okText: "确认代写", cancelText: "取消", onOk: () => resolve(), onCancel: () => reject(new DOMException("已取消代写", "AbortError")) }));
            }
            const content: Exclude<AiTextMessage["content"], string> = [
                { type: "text", text: `根据用户的要求与参考图片撰写可直接提交给视频模型的中文分镜提示词。时长 ${effectiveConfig.videoSeconds} 秒。说明主体、镜头、动作、构图、光线和节奏，不虚构素材事实。已上传编号：${materialLabels.map((item) => item.label).join("、") || "无"}。保留用户指定的 @素材编号；不添加不存在的编号。视频和音频仅有编号，未提供内容，不推断其具体内容。只输出提示词。用户要求：${writingBrief}` },
            ];
            for (const image of references) content.push({ type: "image_url", image_url: { url: await imageToDataUrl(image) } });
            controller.signal.throwIfAborted();
            const answer = await requestImageQuestion({ ...effectiveConfig, model: textModel }, [{ role: "user", content }], setWritingPreview, { signal: controller.signal });
            if (!answer.trim() || answer.trim() === "没有返回内容") throw new Error("文字模型没有返回提示词，请重试或切换代写模型。原提示词已保留。");
            setWritingPreview(answer);
            message.success("脚本已撰写，请预览后应用");
        } catch (error) {
            if (!controller.signal.aborted && !(error instanceof Error && error.name === "AbortError")) setWritingError(publicServiceText(error instanceof Error ? error.message : "撰写失败，请重试。原提示词已保留。"));
        } finally {
            writingControllerRef.current = null;
            setWriting(false);
        }
    };
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        setElapsedMs(0);
        setRunning(true);
        setResultView("results");
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        let submittedLog: GenerationLog | undefined;
        try {
            let expectedCredits: number | undefined;
            if (!isCloudVideo && snapshot.config.channelMode === "remote") {
                const quote = await quoteVideoModel(snapshot.config, model);
                setPrice(quote);
                await new Promise<void>((resolve, reject) => modal.confirm({ title: "确认视频制作", content: <div className="space-y-2"><div>处理服务：{publicServiceText(profile.displayName)}</div><div>素材：{references.length}张图片、{videoReferences.length}段视频、{audioReferences.length}段音频</div><div>输出：{snapshot.config.videoSeconds}秒 · {snapshot.config.vquality}p</div><div>{publicServiceText(quote.calculation || "")}</div><div className="font-semibold">本次 {quote.credits} 算力点</div><div>取消不扣费；任务明确失败后自动返还。</div></div>, okText: "确认生成", cancelText: "取消", onOk: () => resolve(), onCancel: () => reject(new DOMException("用户取消制作", "AbortError")) }));
                expectedCredits = quote.credits;
            }
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, snapshot.videoReferences, snapshot.audioReferences, {
                expectedCredits,
                confirmReplicate,
                onTaskSubmitted: async (task) => {
                    const log = buildLog({
                        prompt: snapshot.text,
                        model,
                        config: snapshot.config,
                        references: snapshot.references,
                        videoReferences: snapshot.videoReferences,
                        audioReferences: snapshot.audioReferences,
                        durationMs: 0,
                        status: "pending",
                        task,
                    });
                    await saveLog(log, false);
                    submittedLog = log;
                },
            });
            const log =
                submittedLog ||
                buildLog({ prompt: snapshot.text, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: 0, status: "pending", task });
            await saveLog(log, false);
            void pollGenerationLog(log, snapshot.config, agentTaskId);
        } catch (error) {
            if (submittedLog) {
                message.warning("提交结果待核对，任务编号已保存；正在查询原任务，请勿重复生成。");
                void pollGenerationLog(submittedLog, snapshot.config, agentTaskId);
                return;
            }
            if (error instanceof Error && error.name === "AbortError") {
                setResults([]);
                setRunning(false);
                if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: "用户取消制作" });
                return;
            }
            const errorMessage = publicServiceText(error instanceof Error ? error.message : t("workbench.generationFailed"));
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: snapshot.config,
                    references: snapshot.references,
                    videoReferences: snapshot.videoReferences,
                    audioReferences: snapshot.audioReferences,
                    durationMs: performance.now() - batchStartedAt,
                    status: "failed",
                    error: errorMessage,
                }),
            );
            message.error(errorMessage);
            setRunning(false);
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string") setPrompt(videoCommand.prompt);
        if (videoCommand.run && running) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        if (modelDirectoryUnavailable || !validVideoModel) {
            message.warning(modelsError || "暂无可用视频模型，请刷新模型目录或联系管理员。");
            return null;
        }
        const text = prompt.trim();
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        if (referenceError || profile.interface === "unavailable") { message.warning(referenceError || profile.description); return null; }
        if (effectiveConfig.channelMode === "remote" && !useUserStore.getState().token) { message.warning("请先登录后生成视频"); return null; }
        if (isCloudVideo && !useUserStore.getState().token) {
            message.warning("请先登录后使用平台视频模型");
            return null;
        }
        if (referenceError) {
            message.warning(referenceError);
            return null;
        }
        if (!isCloudVideo && !isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...references], videoReferences: [...videoReferences], audioReferences: [...audioReferences] };
    };

    const retryResult = () => {
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (running || writing) return;
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "video") {
            if (!profile.maxVideos || videoReferences.length >= profile.maxVideos) {
                message.warning("当前模型不支持视频参考或数量已达上限");
                return;
            }
            setVideoReferences((items) => [...items, { id: nanoid(), name: payload.title, type: "video/mp4", url: payload.url, storageKey: payload.storageKey, width: payload.width, height: payload.height }]);
        } else if (payload.kind === "image") {
            if (!referenceLimit || references.length >= referenceLimit) { message.warning("参考图片数量已达上限或当前模型不支持图片"); return; }
            const stored = await uploadImage(payload.dataUrl);
            const image = { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey };
            setReferences((value) => [...value, image].slice(0, referenceLimit));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        if (running || writing) return;
        setPrompt("");
        setReferences([]);
        setVideoReferences([]);
        setAudioReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
        setResultView("results");
    };

    const deleteSelectedLogs = () => {
        selectedLogIds.forEach((id) => {
            activeLogControllersRef.current.get(id)?.abort();
            activeLogControllersRef.current.delete(id);
            activeLogIdsRef.current.delete(id);
        });
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(() => refreshLogs());
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, resumePending = true) => {
        await logStore.setItem(log.id, serializeLog(log));
        await refreshLogs(resumePending);
    };

    const refreshLogs = async (resumePending = true) => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "pending" && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, agentTaskId?: string) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        activeLogIdsRef.current.add(log.id);
        const controller = new AbortController();
        activeLogControllersRef.current.set(log.id, controller);
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            const stored = await storeGeneratedVideo(
                await waitForVideoGenerationTask(configOverride || taskConfig, log.task, {
                    signal: controller.signal,
                    onWaitState: (waitState) => setResults([{ id: log.id, status: "pending", waitState }]),
                }),
            );
            const nextVideo: GeneratedVideo = {
                id: nanoid(),
                url: stored.url,
                storageKey: stored.storageKey,
                durationMs: Date.now() - log.createdAt,
                width: stored.width || 1280,
                height: stored.height || 720,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            };
            setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "succeeded", successCount: 1, failCount: 0, error: undefined });
            await saveLog({ ...log, status: "success", durationMs: nextVideo.durationMs, video: nextVideo, error: undefined });
            message.success(t("videoWorkbench.generated"));
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") return;
            const errorMessage = publicServiceText(error instanceof Error ? error.message : t("workbench.generationFailed"));
            setResults([{ id: log.id, status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog({ ...log, status: "failed", durationMs: Date.now() - log.createdAt, error: errorMessage, task: isVideoTaskFailed(error) ? undefined : log.task });
            message.error(errorMessage);
        } finally {
            activeLogControllersRef.current.delete(log.id);
            activeLogIdsRef.current.delete(log.id);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setResultView("results");
        setPrompt(log.prompt);
        setReferences(log.references || []);
        setVideoReferences(log.videoReferences);
        setAudioReferences(log.audioReferences);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        if (log.config.videoInputMode) updateConfig("videoInputMode", log.config.videoInputMode);
        setResults(log.status === "pending" ? [{ id: log.id, status: "pending" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || t("workbench.generationFailed") }]);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            <main className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[440px_minmax(0,1fr)] lg:overflow-hidden">
                <section className="flex min-h-0 flex-col rounded-lg border border-border bg-card">
                    <div className="thin-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
                        <div className="flex items-center justify-between gap-3">
                            <h1 className="text-xl font-semibold">视频创作台</h1>
                            <Button disabled={running || writing} icon={<Plus size={14} />} onClick={createSession}>新建</Button>
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between"><span className="font-semibold">视频模型</span><Button type="text" size="small" loading={loadingModels} icon={<RefreshCw size={14} />} onClick={() => { void useConfigStore.getState().loadPublicSettings(); setQuoteRevision((value) => value + 1); }}>刷新模型 / 报价</Button></div>
                            <Select aria-label="视频模型" className="w-full" size="large" disabled={running || writing} value={model || undefined} placeholder="暂无可用视频模型" optionLabelProp="title" virtual={false} optionRender={(option) => <VideoModelOption config={effectiveConfig} model={String(option.value)} />} onChange={(value) => updateConfig("videoModel", value)} options={videoModels.map((value) => { const item = videoProfile(effectiveConfig, value); return { value, title: item.displayName, label: item.displayName }; })} />
                            {(modelsError || !validVideoModel) && <Typography.Text role="alert" type="warning">{modelsError || (loadingModels ? "正在加载视频模型…" : "暂无可用视频模型，请刷新模型目录或联系管理员。")}</Typography.Text>}
                            <p className="text-xs leading-5 text-muted-foreground">{profile.description}</p>
                            <div className="flex flex-wrap gap-1">{frameMode ? <Tag>首帧必填 · 尾帧可选</Tag> : <Tag>参考图片最多 {profile.maxImages} 张</Tag>}{profile.maxVideos > 0 && <Tag>视频最多 {profile.maxVideos} 段</Tag>}{profile.maxAudios > 0 && <Tag>音频最多 {profile.maxAudios} 段</Tag>}</div>
                            <p className="text-xs leading-5 text-muted-foreground">输入方式：{videoInputDescription(profile, inputMode)}</p>
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2"><span className="font-semibold">{frameMode ? "首尾帧图片" : isHailuo ? "首帧图片（可选）" : "参考素材"}</span><Button size="small" disabled={running || writing} icon={<FolderPlus size={14} />} onClick={() => setAssetPickerOpen(true)}>我的资产</Button></div>
                            <div className="flex flex-wrap gap-2">
                                {referenceLimit > 0 && <><Button size="small" disabled={running || writing} icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>{frameMode ? "添加首帧 / 尾帧" : singleImage && references.length ? "更换首帧" : "添加图片"}</Button><Button size="small" disabled={running || writing} icon={<ClipboardPaste size={14} />} onClick={() => void addReferencesFromClipboard()}>粘贴图片</Button></>}
                                {profile.maxVideos > 0 && <Button size="small" disabled={running || writing} onClick={() => videoInputRef.current?.click()}>添加视频</Button>}
                                {profile.maxAudios > 0 && <Button size="small" disabled={running || writing} onClick={() => audioInputRef.current?.click()}>添加音频</Button>}
                            </div>
                            <div className={`min-h-28 rounded-lg border border-dashed p-3 ${referenceDragTarget ? "border-primary bg-primary/5" : "border-border"}`} onDragEnter={handleReferenceDragEnter} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDragLeave={handleReferenceDragLeave} onDrop={handleReferenceDrop}>
                                {!materialLabels.length && <div className="py-5 text-center text-sm text-muted-foreground">{frameMode ? "首帧必填，尾帧可选；两张图片分别控制开始和结束画面" : isHailuo ? "无需图片即可文生视频；添加1张图切换为图生视频" : "上传或拖入当前模型支持的素材"}</div>}
                                <div className="grid grid-cols-3 gap-2">
                                    {references.map((item, index) => <div key={item.id} className="group relative overflow-hidden rounded-md border border-border"><button type="button" disabled={running || writing} className="block w-full cursor-pointer" onClick={() => { if (!frameMode) insertMention(`图片${index + 1}`); }}><img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="aspect-square w-full object-cover" /><span className="block truncate px-1 py-1 text-xs">{frameMode ? (index === 0 ? "首帧" : "尾帧") : `图片${index + 1}`}</span></button>{!frameMode && <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => { if (!running && !writing) changeImages(moveListItem(references, index, offset)); }} />}<button type="button" disabled={running || writing} className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white" aria-label={`移除图片${index + 1}`} onClick={() => removeMaterial(item.id)}><Trash2 size={12} /></button></div>)}
                                </div>
                                {videoReferences.map((item, index) => <div key={item.id} className="mt-3 space-y-1"><video src={item.url} controls className="max-h-32 w-full rounded" /><div className="flex items-center justify-between gap-2 text-xs"><button type="button" disabled={running || writing} onClick={() => insertMention(`视频${index + 1}`)} className="cursor-pointer truncate text-primary">@视频{index + 1} · {formatDuration(item.durationMs || 0)} · {item.name}</button><Button size="small" type="text" disabled={running || writing} onClick={() => removeMaterial(item.id)}>移除</Button></div></div>)}
                                {audioReferences.map((item, index) => <div key={item.id} className="mt-3 space-y-1"><audio src={item.url} controls className="w-full" /><div className="flex items-center justify-between gap-2 text-xs"><button type="button" disabled={running || writing} onClick={() => insertMention(`音频${index + 1}`)} className="cursor-pointer truncate text-primary">@音频{index + 1} · {formatDuration(item.durationMs || 0)} · {item.name}</button><Button size="small" type="text" disabled={running || writing} onClick={() => removeMaterial(item.id)}>移除</Button></div></div>)}
                            </div>
                            <p className="text-xs leading-5 text-muted-foreground">{videoInputDescription(profile, inputMode)}{inputMode === "reference" && "点击素材插入编号。"}</p>
                            {!profile.maxVideos && !profile.maxAudios && <p className="text-xs text-muted-foreground">当前渠道未开放视频 / 音频参考。上传照片和语音让人物说话，请进入 <a href="/video/photo-talk" className="text-primary">照片说话</a>；已有视频匹配新语音，请进入 <a href="/video/lipsync" className="text-primary">视频对口型</a>。</p>}
                            {referenceError && <Typography.Text role="alert" type="warning">{referenceError}</Typography.Text>}
                        </div>
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2"><span className="font-semibold">视频脚本</span><div className="flex gap-1"><Button size="small" icon={<BookOpen size={14} />} onClick={() => setPromptDialogOpen(true)}>提示词库</Button><Button size="small" disabled={running || writing} icon={<Sparkles size={14} />} onClick={() => { setWritingBrief(prompt); setWritingError(""); setWritingPreview(""); setWritingOpen(true); }}>AI代写</Button></div></div>
                            <Mentions ref={promptInputRef} aria-label="视频脚本" className="w-full" rows={8} disabled={running || writing} value={prompt} onChange={setPrompt} prefix="@" options={materialLabels.map((item) => ({ value: item.label, label: `${item.label} · ${item.name}` }))} placeholder="描述主体、动作和镜头；输入 @ 选择参考素材，或点击AI代写。" />
                            <p className="text-xs text-muted-foreground">例如：以 @图片1 中的商品为主体，镜头缓慢环绕，突出材质细节。</p>
                        </div>
                        <Button block disabled={running || writing} icon={<SlidersHorizontal size={15} />} onClick={() => setSettingsOpen(true)}>视频设置 · {isWan ? "首帧比例" : isHailuo ? "默认比例 / 跟随首帧" : videoSizeLabel(effectiveConfig.size)} · {effectiveConfig.videoSeconds}秒 · {normalizeResolution(effectiveConfig.vquality)}p{isWan && effectiveConfig.videoInterpolate === "true" ? " · 插帧" : ""}</Button>
                    </div>
                    <div className="space-y-2 border-t border-border p-4">
                         <div className="text-sm">{priceLoading ? "正在读取报价…" : price ? <>预计扣费 <strong>{price.credits.toLocaleString()}</strong> 算力点<div className="mt-1 text-xs text-muted-foreground">{publicServiceText(price.calculation || "")}</div></> : token && (isCloudVideo || effectiveConfig.channelMode === "remote") ? <Typography.Text type="warning">{priceError || "报价尚未就绪"}</Typography.Text> : isCloudVideo || effectiveConfig.channelMode === "remote" ? "登录后查看本次算力点" : "自定义渠道费用以该服务账单为准"}</div>
                        <Button type="primary" size="large" block icon={<Sparkles size={16} />} loading={running} disabled={!canGenerate || running || writing || Boolean(referenceError) || profile.interface === "unavailable"} onClick={() => void generate()}>生成视频{price ? ` · ${price.credits} 算力点` : ""}</Button>
                        <p className="text-xs text-muted-foreground">提交前确认最新费用；上传素材、选择模板和查看报价不扣费。</p>
                    </div>
                </section>
                <section className="thin-scrollbar min-h-0 overflow-y-auto rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between gap-2"><Tabs activeKey={resultView} onChange={setResultView} items={[{ key: "results", label: "生成结果" }, { key: "history", label: `我的作品（${logs.length}）` }, { key: "examples", label: "使用示例" }]} />{running && <Tag>{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag>}</div>
                    {resultView === "history" ? <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={(log) => { if (!running && !writing) previewGenerationLog(log); else message.warning("请等待当前制作完成后查看其他作品"); }} /> : resultView === "examples" ? <div className="space-y-4"><p className="text-sm text-muted-foreground">以下是可编辑的文字脚本模板。选择模板不调用模型、不扣费；上传你的素材后再生成。</p><div className="grid gap-3 xl:grid-cols-2">{VIDEO_SCRIPT_TEMPLATES.map((item) => <div key={item.title} className="space-y-3 rounded-lg border border-border p-4"><h3 className="font-semibold">{item.title}</h3><p className="text-sm leading-6 text-muted-foreground">{item.prompt}</p><Button disabled={running || writing} onClick={() => { setPrompt(references.length ? `以 @图片1 中的主体为准。${item.prompt}` : item.prompt); message.success("已填入脚本，可按素材修改"); }}>应用脚本</Button></div>)}</div></div> : results.length ? <div className="grid gap-4">{results.map((result) => result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={retryResult} /> : <PendingVideoCard key={result.id} waitState={result.waitState} />)}</div> : <div className="flex min-h-[360px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border text-center"><VideoIcon size={42} className="text-muted-foreground" /><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="视频生成后将在这里预览" /><Button onClick={() => setResultView("examples")}>查看使用示例</Button></div>}
                </section>
            </main>
            <input ref={fileInputRef} type="file" accept="image/*" multiple={!singleImage} className="hidden" onChange={(event) => { void addReferences(event.target.files); event.target.value = ""; }} />
            <input ref={videoInputRef} type="file" accept="video/*" multiple className="hidden" onChange={(event) => { void addMediaReferences(event.target.files); event.target.value = ""; }} />
            <input ref={audioInputRef} type="file" accept="audio/*" multiple className="hidden" onChange={(event) => { void addMediaReferences(event.target.files); event.target.value = ""; }} />
            <Modal title="视频设置" open={settingsOpen} footer={<Button type="primary" onClick={() => setSettingsOpen(false)}>完成</Button>} onCancel={() => setSettingsOpen(false)}><GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} /></Modal>
            <Modal title="AI脚本助手" open={writingOpen} onCancel={() => { if (!writing) setWritingOpen(false); }} maskClosable={!writing} closable={!writing} footer={<div className="flex justify-end gap-2"><Button loading={writing} disabled={running} onClick={() => void writePrompt()}>撰写脚本</Button><Button type="primary" disabled={writing || !writingPreview.trim()} onClick={() => { const error = materialMentionError(writingPreview, materialLabels); if (error) { setWritingError(error); return; } setPrompt(writingPreview); setWritingOpen(false); }}>应用到脚本</Button></div>}>
                <div className="space-y-3"><p className="text-sm text-muted-foreground">根据文字和参考图片扩写脚本，不分析视频、音频内容。AI代写按文字模型单独计费，生成视频另行确认。</p><ModelPicker config={effectiveConfig} value={effectiveConfig.textModel} onChange={(value) => { if (!writing) updateConfig("textModel", value); }} capability="text" fullWidth onMissingConfig={() => openConfigDialog(false, "channels")} /><Input.TextArea aria-label="代写要求" rows={3} disabled={writing} value={writingBrief} onChange={(event) => setWritingBrief(event.target.value)} placeholder="例如：做一段香水广告，镜头缓慢环绕，突出瓶身质感。" />{writing && <Typography.Text role="status" type="secondary">正在撰写，请稍候…</Typography.Text>}{writingPreview && <Input.TextArea aria-label="代写脚本预览" rows={8} readOnly={writing} value={writingPreview} onChange={(event) => setWritingPreview(event.target.value)} />}{writingError && <Typography.Text role="alert" type="danger">{writingError}</Typography.Text>}</div>
            </Modal>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={(text) => { if (!running && !writing) setPrompt(text); }} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>{t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}</Modal>
        </div>
    );
}

const VIDEO_SCRIPT_TEMPLATES = [
    { title: "商品展示", prompt: "商品置于简洁台面，镜头由全景缓慢推进到细节特写，再绕商品小幅移动。柔和侧光突出材质和轮廓，背景干净，不新增文字、商标或虚构商品功能。" },
    { title: "带货开箱", prompt: "以真实开箱视角拍摄，依次展示包装、打开过程与商品外观。镜头跟随手部动作，节奏自然，重点呈现商品细节，不虚构包装内容和卖点。" },
    { title: "同城到店", prompt: "先展示店铺环境，再拍服务过程和细节，最后回到整体空间。运镜平稳，光线自然，营造亲切可信的到店体验，不编造地址、价格或承诺。" },
    { title: "动作与运镜参考", prompt: "主体从侧面缓慢转向镜头，动作自然连贯。镜头先保持中景，再平稳推进到面部或主体细节，背景保持一致。若有参考视频，请插入它的素材编号并说明要参考的动作或运镜。" },
];

function GenerationSettings({ config, model, updateConfig }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig }) {
    const profile = videoProfile(config, model);
    const isWan = model === REPLICATE_VIDEO_MODEL;
    const isHailuo = model === HAILUO_VIDEO_MODEL;
    const isCloudVideo = isReplicateVideoModel(model);
    const ratio = inferVideoRatio(config.size) === "auto" ? "16:9" : inferVideoRatio(config.size);
    const resolutions = profile.resolutions.length ? profile.resolutions : ["480", "720", "1080"];
    const seconds = profile.seconds.length ? profile.seconds : Array.from({ length: 27 }, (_, index) => String(index + 4));
    return <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{profile.displayName} · 仅显示当前渠道配置的规格。</p>
        {!isCloudVideo && <div className="space-y-2"><div>画面比例</div><Select aria-label="视频比例" className="w-full" value={ratio} onChange={(value) => updateConfig("size", computeVideoSize(normalizeResolution(config.vquality), value))} options={["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].map((value) => ({ value, label: value }))} /></div>}
        <div className="space-y-2"><div>分辨率</div><Select aria-label="视频分辨率" className="w-full" value={normalizeResolution(config.vquality)} onChange={(value) => { updateConfig("vquality", value); if (!isCloudVideo) updateConfig("size", computeVideoSize(value, ratio)); }} options={resolutions.map((value) => ({ value, label: `${value}p` }))} /></div>
        <div className="space-y-2"><div>视频时长</div><Select aria-label="视频时长" className="w-full" value={config.videoSeconds} onChange={(value) => updateConfig("videoSeconds", value)} options={seconds.map((value) => ({ value, label: `${isWan ? "约 " : ""}${value} 秒` }))} /></div>
        {isHailuo && <p className="text-xs text-muted-foreground">按所选清晰度和时长收取每条费用。上传图片时比例跟随首帧；纯文字使用平台默认比例。1080p仅支持6秒。</p>}
        {isWan && <div><Switch aria-label="视频插帧" checked={config.videoInterpolate === "true"} onChange={(value) => updateConfig("videoInterpolate", String(value))} /> 插帧，让动作更流畅（使用插帧价格档）<p className="mt-2 text-xs text-muted-foreground">画面比例跟随首帧图；按分辨率及插帧档位收取每条视频费用。</p></div>}
        {profile.generateAudio && <div><Switch aria-label="生成声音" checked={boolConfig(config.videoGenerateAudio, true)} onChange={(value) => updateConfig("videoGenerateAudio", String(value))} /> 生成声音</div>}
        {profile.interface === "ark" && <div><Switch aria-label="视频水印" checked={boolConfig(config.videoWatermark, false)} onChange={(value) => updateConfig("videoWatermark", String(value))} /> 平台水印</div>}
    </div>;
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard({ waitState }: { waitState?: VideoTaskWaitState }) {
    const { t } = useTranslation();
    const label = waitState === "background" ? t("videoWorkbench.backgroundGenerating") : waitState === "query_interrupted" ? t("videoWorkbench.queryInterrupted") : t("workbench.generating");
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{label}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.resolution}p</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "success" ? "blue" : log.status === "pending" ? "processing" : "red"}>
                        {t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(log.durationMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const videoReferences = await Promise.all((log.videoReferences || []).map(async (item) => ({ ...item, url: await resolveMediaUrl(item.storageKey, item.url) })));
    const audioReferences = await Promise.all((log.audioReferences || []).map(async (item) => ({ ...item, url: await resolveMediaUrl(item.storageKey, item.url) })));
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        videoReferences,
        audioReferences,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "success",
        task: log.task,
        video,
        error: log.error,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        videoReferences: log.videoReferences.map((item) => ({ ...item, url: item.storageKey ? "" : item.url })),
        audioReferences: log.audioReferences.map((item) => ({ ...item, url: item.storageKey ? "" : item.url })),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
        videoInputMode: log.config?.videoInputMode === "first_last" || log.config?.videoInputMode === "first_frame_only" ? log.config.videoInputMode : "reference",
        videoInterpolate: log.config?.videoInterpolate === "true" ? "true" : "false",
    };
}

function buildLog({
    prompt,
    model,
    config,
    references,
    videoReferences = [],
    audioReferences = [],
    durationMs,
    status,
    task,
    video,
    error,
}: {
    prompt: string;
    model: string;
    config: AiConfig;
    references: ReferenceImage[];
    videoReferences?: ReferenceVideo[];
    audioReferences?: ReferenceAudio[];
    durationMs: number;
    status: GenerationLog["status"];
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
}): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoInputMode: config.videoInputMode,
        videoInterpolate: config.videoInterpolate,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        videoReferences,
        audioReferences,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return {
        ...config,
        model,
        videoModel: model,
        size: normalizeVideoSize(config.size),
        videoSeconds: model === REPLICATE_VIDEO_MODEL || videoProfile(config, model).seconds.length ? config.videoSeconds : normalizeVideoSeconds(config.videoSeconds),
        vquality: normalizeResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
        videoInputMode: config.videoInputMode,
        videoInterpolate: config.videoInterpolate,
    };
}

function normalizeVideoSeconds(value: string) {
    if (value === "7.5") return "7.5";
    if (String(value).trim() === "-1") return "-1";
    return clampVideoSeconds(value);
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}


