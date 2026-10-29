import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Copy, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { PromptEnhancementButton } from "@/components/prompts/prompt-enhancement";
import { usePromptEnhancement } from "@/hooks/use-prompt-enhancement";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { configForFeature, modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { imageLogResults, isActiveImageLog, useImageWorkbenchStore, type GeneratedImage, type GenerationLog } from "@/stores/use-image-workbench-store";

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";

export default function ImagePage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const baseEffectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const prompt = useImageWorkbenchStore((state) => state.prompt);
    const setPrompt = useImageWorkbenchStore((state) => state.setPrompt);
    const templateInput = useImageWorkbenchStore((state) => state.templateInput);
    const setTemplateInput = useImageWorkbenchStore((state) => state.setTemplateInput);
    const references = useImageWorkbenchStore((state) => state.references);
    const setReferences = useImageWorkbenchStore((state) => state.setReferences);
    const logs = useImageWorkbenchStore((state) => state.logs);
    const activeLogId = useImageWorkbenchStore((state) => state.activeLogId);
    const selectLog = useImageWorkbenchStore((state) => state.selectLog);
    const loaded = useImageWorkbenchStore((state) => state.loaded);
    const loadError = useImageWorkbenchStore((state) => state.loadError);
    const storageError = useImageWorkbenchStore((state) => state.storageError);
    const loadLogs = useImageWorkbenchStore((state) => state.loadLogs);
    const enqueue = useImageWorkbenchStore((state) => state.enqueue);
    const retry = useImageWorkbenchStore((state) => state.retry);
    const removeLogs = useImageWorkbenchStore((state) => state.removeLogs);
    const effectiveConfig = baseEffectiveConfig.managed?.enabled ? configForFeature(baseEffectiveConfig, references.length ? "image.edit" : "image.generate", "image") : baseEffectiveConfig;
    const previewLog = logs.find((log) => log.id === activeLogId);
    const results = previewLog ? imageLogResults(previewLog) : [];
    const running = Boolean(previewLog && isActiveImageLog(previewLog));
    const activeTasks = logs.filter(isActiveImageLog).length;
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [now, setNow] = useState(Date.now);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Math.floor(Number(config.count) || 1)));
    const enhancement = usePromptEnhancement({
        prompt,
        onChange: setPrompt,
        scenario: references.length ? "image-reference" : "image",
        contextKey: JSON.stringify([references.map((item) => [item.id, item.name, item.storageKey, item.dataUrl]), templateInput, imageCommand?.nonce]),
        references: references.map((item, index) => ({ marker: imageReferenceLabel(index), title: item.name, kind: "image" })),
    });

    useEffect(() => {
        if (!activeTasks) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [activeTasks]);

    useEffect(() => {
        void loadLogs();
    }, [loadLogs]);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("imageWorkbench.clipboardEmpty"));
        }
    };

    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (templateInput && references.length < templateInput.minReferenceImages) {
            const error = `此模板需要至少 ${templateInput.minReferenceImages} 张参考图，请先补齐：${templateInput.inputHint}`;
            message.warning(error);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        if (!loaded) {
            message.warning(loadError || t("imageWorkbench.loadingLogs"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: loadError || t("imageWorkbench.loadingLogs") });
            return;
        }
        enqueue({ ...effectiveConfig, model, imageModel: model }, text, references, generationCount, agentTaskId);
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        setTemplateInput(imageCommand.templateInput);
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, setPrompt, setTemplateInput]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        const stored = await uploadImage(image.dataUrl);
        setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        const sourcePrompt = previewLog?.prompt || "";
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: t("imageWorkbench.resultTitle", { count: index + 1 }),
            coverUrl: stored.url,
            tags: [],
            source: t("imageWorkbench.source"),
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt: sourcePrompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
            setTemplateInput(undefined);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        useImageWorkbenchStore.getState().newDraft();
        setSelectedLogIds([]);
        setLogsOpen(false);
    };

    const deleteSelectedLogs = async () => {
        try {
            await removeLogs(selectedLogIds);
            setSelectedLogIds([]);
            setDeleteConfirmOpen(false);
        } catch {
            message.error(t("imageWorkbench.deleteFailed"));
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        selectLog(log.id);
        setLogsOpen(false);
    };

    const reuseGenerationLog = (log: GenerationLog) => {
        setPrompt(log.prompt);
        setTemplateInput(undefined);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
        if (log.config.background !== undefined) updateConfig("background", log.config.background);
        if (log.config.systemPrompt !== undefined) updateConfig("systemPrompt", log.config.systemPrompt);
        if (baseEffectiveConfig.managed?.enabled) {
            const feature = log.references.length ? "image.edit" : "image.generate";
            useConfigStore.setState((state) => ({ featureModels: { ...state.featureModels, [feature]: log.model } }));
        }
        message.success(t("imageWorkbench.reused"));
    };

    const retryResult = (resultId: string) => {
        if (previewLog && !retry(previewLog.id, resultId)) message.warning(t("imageWorkbench.retryUnavailable"));
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={activeLogId || undefined}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className="grid min-w-0 grid-cols-1 gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex min-w-0 flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Tooltip title={t("workbench.logs")}>
                                        <Button aria-label={t("workbench.logs")} icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                            <span className="hidden sm:inline">{t("workbench.logs")}</span>
                                        </Button>
                                    </Tooltip>
                                    <Tooltip title={t("workbench.settings")}>
                                        <Button aria-label={t("workbench.settings")} icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                            <span className="hidden sm:inline">{t("workbench.settings")}</span>
                                        </Button>
                                    </Tooltip>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <span className="shrink-0 text-base font-semibold">{t("workbench.prompt")}</span>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <PromptEnhancementButton state={enhancement} disabled={!prompt.trim()} />
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            {t("workbench.viewPrompts")}
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            {t("workbench.viewAssets")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("imageWorkbench.promptPlaceholder")} />
                                {templateInput ? (
                                    <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                                        <span className="font-medium">{templateInput.title}</span> · 请准备：{templateInput.inputHint}。
                                        {templateInput.minReferenceImages ? `参考图 ${references.length}/${templateInput.minReferenceImages} 张（至少），按资料说明排列。` : "可直接文字生图。"}
                                        <Button type="link" size="small" onClick={() => setTemplateInput(undefined)}>
                                            取消模板要求
                                        </Button>
                                    </div>
                                ) : null}
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("imageWorkbench.references")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label={t("imageWorkbench.removeReference")}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            {loadError || storageError ? (
                                <Alert
                                    className="mb-3"
                                    type="error"
                                    title={loadError || storageError}
                                    action={
                                        loadError ? (
                                            <Button size="small" onClick={() => void loadLogs()}>
                                                {t("workbench.retry")}
                                            </Button>
                                        ) : undefined
                                    }
                                />
                            ) : null}
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate || !loaded} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                            {activeTasks ? (
                                <div role="status" className="mt-2 text-center text-xs text-stone-500 dark:text-stone-400">
                                    {t("imageWorkbench.activeTasks", { count: activeTasks })}
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="thin-scrollbar min-w-0 rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                                {previewLog ? (
                                    <p className="mt-1 truncate text-xs text-stone-500" title={previewLog.prompt}>
                                        {previewLog.title} · {previewLog.modelLabel || previewLog.model}
                                    </p>
                                ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {running && previewLog ? <Tag className="m-0 px-2 py-1">{t("workbench.waiting", { time: formatDuration(Math.max(0, now - previewLog.createdAt)) })}</Tag> : null}
                                {previewLog ? (
                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => reuseGenerationLog(previewLog)}>
                                        {t("imageWorkbench.reuse")}
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        {results.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {results.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" || result.status === "interrupted" ? (
                                        <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => retryResult(result.id)} interrupted={result.status === "interrupted"} />
                                    ) : (
                                        <PendingImageCard key={result.id} queued={result.status === "queued"} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={activeLogId || undefined}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog
                open={promptDialogOpen}
                onOpenChange={setPromptDialogOpen}
                onSelect={(text, item) => {
                    setPrompt(text);
                    setTemplateInput({ title: item.title, inputHint: item.inputHint || "", minReferenceImages: item.minReferenceImages ?? (item.requiresRef ? 1 : 0) });
                }}
            />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker
                    config={config}
                    value={model}
                    onChange={(value) =>
                        config.managed?.enabled ? useConfigStore.setState((s) => ({ featureModels: { ...s.featureModels, [config.featureId || config.featureIds?.image || "image.generate"]: value } })) : updateConfig("imageModel", value)
                    }
                    capability="image"
                    fullWidth
                    onMissingConfig={() => openConfigDialog(false)}
                />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    {image.width > 0 && image.height > 0 ? (
                        <span>
                            {image.width}x{image.height}
                        </span>
                    ) : null}
                    {image.bytes > 0 ? <span>{formatBytes(image.bytes)}</span> : null}
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard({ queued }: { queued: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className={`size-6 ${queued ? "" : "animate-spin"}`} />
                <span>{t(queued ? "imageWorkbench.queued" : "workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry, interrupted }: { error: string; onRetry: () => void; interrupted: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t(interrupted ? "imageWorkbench.interruptedTitle" : "workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            {!interrupted ? (
                <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                    <Button size="small" danger onClick={onRetry}>
                        {t("workbench.retry")}
                    </Button>
                </div>
            ) : null}
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
    const deletableLogs = logs.filter((log) => !isActiveImageLog(log));
    const allSelected = Boolean(deletableLogs.length) && deletableLogs.every((log) => selectedLogIds.includes(log.id));
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : deletableLogs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!deletableLogs.length} onClick={toggleAll}>
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
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <div
            data-image-task-id={log.id}
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
        >
            <div className="flex items-start gap-2">
                <Checkbox className="mt-0.5" aria-label={t("imageWorkbench.selectTask", { title: log.title })} disabled={isActiveImageLog(log)} checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                <button type="button" aria-pressed={active} aria-label={t("imageWorkbench.viewTask", { title: log.title })} className="flex min-w-0 flex-1 flex-col gap-2 text-left" onClick={onClick}>
                    <div className="w-full min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {log.modelLabel && <div className="truncate text-xs opacity-60">{log.modelLabel}</div>}
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image) => (
                                    <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                    <div className="grid w-full min-w-0 gap-2">
                        <div className="flex flex-wrap gap-1">
                            {isActiveImageLog(log) ? (
                                <Tag className="m-0 flex h-6 items-center gap-1 rounded-md px-1.5 text-xs leading-none" color="processing">
                                    <LoaderCircle className={`size-3 ${log.status === "running" ? "animate-spin" : ""}`} />
                                    {t(log.status === "queued" ? "imageWorkbench.queued" : "imageWorkbench.progress", { completed: log.successCount + log.failCount, total: log.imageCount })}
                                </Tag>
                            ) : log.status === "interrupted" ? (
                                <Tag className="m-0" color="warning">
                                    {t("imageWorkbench.interruptedTitle")}
                                </Tag>
                            ) : null}
                            {!isActiveImageLog(log) || log.successCount > 0 ? (
                                <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                                    {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                                </Tag>
                            ) : null}
                            {log.failCount ? (
                                <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                    {t("workbench.failCount", { count: log.failCount })}
                                </Tag>
                            ) : null}
                        </div>
                        <div className="flex flex-wrap gap-1">
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                                {formatDuration(log.durationMs)}
                            </Tag>
                        </div>
                        <div className="truncate text-xs text-stone-500 dark:text-stone-400">{log.time}</div>
                    </div>
                </button>
            </div>
        </div>
    );
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
