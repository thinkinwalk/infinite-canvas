import localforage from "localforage";
import { nanoid } from "nanoid";
import { create } from "zustand";

import i18n from "@/i18n";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { collectImageStorageKeys, deleteStoredImages, ensureImagePreview, resolveImageUrl, uploadImage, type UploadedImage } from "@/services/image-storage";
import { modelOptionLabel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useWorkbenchAgentStore, type WorkbenchCommand } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";

export const IMAGE_WORKBENCH_CONCURRENCY = 3;
export type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};
export type GenerationResult = {
    id: string;
    status: "queued" | "pending" | "success" | "failed" | "interrupted";
    image?: GeneratedImage;
    error?: string;
};
export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    modelLabel?: string;
    config: Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count"> & Partial<Pick<AiConfig, "background" | "systemPrompt">>;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "queued" | "running" | "success" | "partial" | "failed" | "interrupted";
    images: GeneratedImage[];
    results?: GenerationResult[];
};
type Snapshot = { config: AiConfig; prompt: string; references: ReferenceImage[]; token: string; agentTaskId?: string };
type ImageWorkbenchState = {
    logs: GenerationLog[];
    loaded: boolean;
    loadError: string;
    storageError: string;
    activeLogId: string | null;
    prompt: string;
    references: ReferenceImage[];
    templateInput: WorkbenchCommand["templateInput"];
    setPrompt: (prompt: string) => void;
    setReferences: (value: ReferenceImage[] | ((references: ReferenceImage[]) => ReferenceImage[])) => void;
    setTemplateInput: (templateInput: WorkbenchCommand["templateInput"]) => void;
    selectLog: (id: string | null) => void;
    newDraft: () => void;
    loadLogs: () => Promise<void>;
    enqueue: (config: AiConfig, prompt: string, references: ReferenceImage[], count: number, agentTaskId?: string) => string;
    retry: (logId: string, resultId: string) => boolean;
    removeLogs: (ids: string[]) => Promise<void>;
};

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const snapshots = new Map<string, Snapshot>();
const writes = new Map<string, Promise<void>>();
const deleting = new Set<string>();
const controllers = new Map<string, { controller: AbortController; token: string }>();
const queue: Array<{ logId: string; resultId: string }> = [];
let activeCount = 0;
let loading: Promise<void> | undefined;
const text = (key: string) => i18n.t(`imageWorkbench.${key}`);
export const isActiveImageLog = (log: GenerationLog) => log.status === "queued" || log.status === "running";
export const imageLogResults = (log: GenerationLog): GenerationResult[] => log.results || log.images.map((image) => ({ id: image.id, status: "success", image }));

export const useImageWorkbenchStore = create<ImageWorkbenchState>((set, get) => ({
    logs: [],
    loaded: false,
    loadError: "",
    storageError: "",
    activeLogId: null,
    prompt: "",
    references: [],
    templateInput: undefined,
    setPrompt: (prompt) => set({ prompt }),
    setReferences: (value) => set((state) => ({ references: typeof value === "function" ? value(state.references) : value })),
    setTemplateInput: (templateInput) => set({ templateInput }),
    selectLog: (activeLogId) => set({ activeLogId }),
    newDraft: () => set({ prompt: "", references: [], templateInput: undefined, activeLogId: null }),
    loadLogs: async () => {
        if (get().loaded) return;
        if (loading) return loading;
        loading = (async () => {
            set({ loadError: "" });
            try {
                const saved: GenerationLog[] = [];
                await storage.iterate<GenerationLog, void>((log) => {
                    saved.push(log);
                });
                const logs = await Promise.all(saved.map(restoreLog));
                set((state) => ({
                    logs: [...state.logs, ...logs.filter((log) => !state.logs.some((current) => current.id === log.id))].sort((a, b) => b.createdAt - a.createdAt),
                    loaded: true,
                }));
            } catch {
                set({ loadError: text("loadFailed") });
            }
        })().finally(() => {
            loading = undefined;
        });
        return loading;
    },
    enqueue: (config, prompt, references, count, agentTaskId) => {
        const id = nanoid();
        const snapshot = { config: structuredClone({ ...config, model: config.imageModel || config.model, count: "1" }), prompt, references: structuredClone(references), token: useUserStore.getState().token, agentTaskId };
        snapshots.set(id, snapshot);
        const createdAt = Date.now();
        const log: GenerationLog = {
            id,
            createdAt,
            title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
            prompt,
            time: new Date(createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
            model: snapshot.config.model,
            modelLabel: modelOptionLabel(config, snapshot.config.model),
            config: { model: snapshot.config.model, imageModel: snapshot.config.model, quality: config.quality, size: config.size, count: String(count), background: config.background, systemPrompt: config.systemPrompt },
            references: structuredClone(snapshot.references),
            durationMs: 0,
            successCount: 0,
            failCount: 0,
            imageCount: count,
            size: config.size,
            quality: config.quality,
            status: "queued",
            images: [],
            results: Array.from({ length: count }, () => ({ id: nanoid(), status: "queued" })),
        };
        set((state) => ({ logs: [log, ...state.logs], activeLogId: id }));
        void scheduleLog(log);
        return id;
    },
    retry: (logId, resultId) => {
        const snapshot = snapshots.get(logId);
        const result = get()
            .logs.find((log) => log.id === logId)
            ?.results?.find((item) => item.id === resultId);
        if (!snapshot || !result || result.status !== "failed" || deleting.has(logId)) return false;
        if (snapshot.config.channelMode === "remote" && snapshot.token !== useUserStore.getState().token) return false;
        updateResult(logId, resultId, { status: "queued", error: undefined });
        const log = get().logs.find((item) => item.id === logId)!;
        void scheduleLog({ ...log, results: [log.results!.find((item) => item.id === resultId)!] });
        return true;
    },
    removeLogs: async (ids) => {
        const removed = get().logs.filter((log) => ids.includes(log.id) && !isActiveImageLog(log) && !deleting.has(log.id));
        removed.forEach((log) => deleting.add(log.id));
        try {
            for (const log of removed) {
                await writes.get(log.id)?.catch(() => undefined);
                await storage.removeItem(log.id);
                snapshots.delete(log.id);
                writes.delete(log.id);
                set((state) => ({ logs: state.logs.filter((item) => item.id !== log.id), activeLogId: state.activeLogId === log.id ? null : state.activeLogId }));
            }
            const used = collectImageStorageKeys([get().logs, get().references]);
            await deleteStoredImages(removed.flatMap((log) => log.images.flatMap((image) => (image.storageKey && !used.has(image.storageKey) ? [image.storageKey] : []))));
        } finally {
            removed.forEach((log) => deleting.delete(log.id));
        }
    },
}));

// Keep execution outside React so navigation cannot discard a running task.
async function scheduleLog(log: GenerationLog) {
    try {
        await persistLog(log.id);
        for (const result of log.results || []) queue.push({ logId: log.id, resultId: result.id });
        pump();
    } catch {
        for (const result of log.results || []) updateResult(log.id, result.id, { status: "failed", error: text("saveBeforeRunFailed") });
    }
}

function pump() {
    while (activeCount < IMAGE_WORKBENCH_CONCURRENCY && queue.length) {
        const job = queue.shift()!;
        activeCount++;
        void runSlot(job.logId, job.resultId).finally(() => {
            activeCount--;
            pump();
        });
    }
}

async function runSlot(logId: string, resultId: string) {
    const snapshot = snapshots.get(logId);
    if (!snapshot) return;
    const controller = new AbortController();
    const startedAt = performance.now();
    try {
        if (snapshot.config.channelMode === "remote" && snapshot.token !== useUserStore.getState().token) throw new Error(text("sessionChanged"));
        if (snapshot.config.channelMode === "remote") controllers.set(resultId, { controller, token: snapshot.token });
        updateResult(logId, resultId, { status: "pending", error: undefined });
        const options = { signal: controller.signal };
        const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.prompt, snapshot.references, options) : await requestGeneration(snapshot.config, snapshot.prompt, options);
        const image = result[0];
        if (!image) throw new Error(text("missingResult"));
        let stored: UploadedImage;
        try {
            stored = await uploadImage(image.dataUrl, options);
        } catch (error) {
            if (controller.signal.aborted) throw error;
            // Preserve an upstream success even when downloading or local storage fails.
            stored = { url: image.dataUrl, width: 0, height: 0, bytes: 0, mimeType: "" };
            useImageWorkbenchStore.setState({ storageError: text("saveFailed") });
        }
        const generated: GeneratedImage = { id: image.id, dataUrl: stored.url, storageKey: stored.storageKey, durationMs: performance.now() - startedAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
        updateResult(logId, resultId, { status: "success", image: generated });
    } catch (error) {
        updateResult(logId, resultId, { status: controller.signal.aborted ? "interrupted" : "failed", error: controller.signal.aborted ? text("sessionChanged") : error instanceof Error ? error.message : i18n.t("workbench.generationFailed") });
    } finally {
        controllers.delete(resultId);
        await persistLog(logId).catch(() => undefined);
    }
}

function updateResult(logId: string, resultId: string, patch: Partial<GenerationResult>) {
    useImageWorkbenchStore.setState((state) => ({
        logs: state.logs.map((log) => {
            if (log.id !== logId) return log;
            const results = (log.results || []).map((result) => (result.id === resultId ? { ...result, ...patch } : result));
            const images = results.flatMap((result) => (result.status === "success" && result.image ? [result.image] : []));
            const failCount = results.filter((result) => result.status === "failed" || result.status === "interrupted").length;
            const status: GenerationLog["status"] = results.some((result) => result.status === "pending")
                ? "running"
                : results.some((result) => result.status === "queued")
                  ? "queued"
                  : results.some((result) => result.status === "interrupted")
                    ? "interrupted"
                    : images.length
                      ? failCount
                          ? "partial"
                          : "success"
                      : "failed";
            return { ...log, results, images, successCount: images.length, failCount, durationMs: Date.now() - log.createdAt, status };
        }),
    }));
    const log = useImageWorkbenchStore.getState().logs.find((item) => item.id === logId);
    const agentTaskId = snapshots.get(logId)?.agentTaskId;
    if (log && agentTaskId)
        useWorkbenchAgentStore.getState().updateTask(agentTaskId, {
            status: log.status === "running" ? "running" : log.status === "queued" ? "queued" : log.successCount ? "succeeded" : "failed",
            successCount: log.successCount,
            failCount: log.failCount,
            error: isActiveImageLog(log) || log.successCount ? undefined : log.results?.find((result) => result.error)?.error,
        });
}

function persistLog(id: string) {
    const next = (writes.get(id) || Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
            const log = useImageWorkbenchStore.getState().logs.find((item) => item.id === id);
            if (!log) return;
            const serializeImage = <T extends { storageKey?: string; dataUrl: string }>(image: T) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl });
            await storage.setItem(id, {
                ...log,
                references: log.references.map(serializeImage),
                images: log.images.map(serializeImage),
                results: log.results?.map((result) => ({ ...result, image: result.image ? serializeImage(result.image) : undefined })),
            });
        });
    writes.set(id, next);
    void next.catch(() => useImageWorkbenchStore.setState({ storageError: text("saveFailed") }));
    return next;
}

async function restoreLog(saved: GenerationLog): Promise<GenerationLog> {
    const restoreImage = async <T extends { storageKey?: string; dataUrl: string }>(image: T) => {
        void ensureImagePreview(image.storageKey);
        return { ...image, dataUrl: await resolveImageUrl(image.storageKey, image.dataUrl) };
    };
    const references = await Promise.all((saved.references || []).map(restoreImage));
    const images = await Promise.all((saved.images || []).map(restoreImage));
    const results = saved.results
        ? await Promise.all(
              saved.results.map(async (result) => ({
                  ...result,
                  ...(result.status === "queued" || result.status === "pending" ? { status: "interrupted" as const, error: text("interrupted") } : {}),
                  image: result.image ? images.find((image) => image.id === result.image!.id) || (await restoreImage(result.image)) : undefined,
              })),
          )
        : undefined;
    return { ...saved, references, images, results, ...(results?.some((result) => result.status === "interrupted") ? { status: "interrupted" as const } : {}) };
}

useUserStore.subscribe((state, previous) => {
    if (state.token === previous.token) return;
    controllers.forEach(({ controller, token }) => {
        if (token !== state.token) controller.abort();
    });
});
