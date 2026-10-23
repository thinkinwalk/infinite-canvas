import localforage from "localforage";
import { collectMediaStorageKeys, deleteStoredMedia, type UploadedFile } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import { canCleanVideoReference, clearExpiredReferenceURLs, referenceExpiresAt, type TemporaryVideoReference } from "@/lib/video-reference-retention";
import type { VideoImportSource } from "@/types/video-workbench";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "temporary_video_references" });
const listeners = new Set<() => void>();
let revision = 0;
export const subscribeVideoReferenceRetention = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const videoReferenceRetentionRevision = () => revision;
const changed = () => { revision++; listeners.forEach((listener) => listener()); };
const lockName = (id: string) => `infinite-canvas:reference:${id}`;

export const readVideoReferenceRetention = (id: string) => storage.getItem<TemporaryVideoReference>(id);

export async function trackTemporaryVideo(media: UploadedFile, name: string, source?: VideoImportSource): Promise<UploadedFile> {
    const id = crypto.randomUUID();
    const reference: TemporaryVideoReference = {
        id, userId: useUserStore.getState().user?.id || "", name, source, storageKey: media.storageKey,
        keys: [media.storageKey], lastUsedAt: Date.now(), keep: false,
    };
    await storage.setItem(id, reference);
    changed();
    return { ...media, referenceId: id };
}

async function syncRetention(id: string, action: "use" | "review" | "keep" | "temporary", signal?: AbortSignal) {
    const token = useUserStore.getState().token;
    if (!token) return;
    const response = await fetch("/api/v1/video/reference-retention", {
        method: "POST", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "参考素材保留设置保存失败，请重试");
    if (useUserStore.getState().token !== token) throw new Error("登录状态已变化，请重新操作");
}

export async function updateVideoReferenceRetention(id: string, action: "use" | "review" | "keep" | "temporary", signal?: AbortSignal) {
    const update = async () => {
        const saved = await readVideoReferenceRetention(id);
        if (!saved) throw new Error("参考素材记录不存在，请重新导入");
        if (saved.cleanedAt) throw new Error("参考视频已清理，请重新导入");
        const userId = useUserStore.getState().user?.id || "";
        if (saved.userId && saved.userId !== userId) throw new Error("请登录导入该参考素材的账号后继续");
        await syncRetention(id, action, signal);
        const next = {
            ...saved,
            ...(action === "use" || action === "temporary" ? { lastUsedAt: Date.now(), reviewedAt: undefined } : {}),
            ...(action === "review" ? { reviewedAt: Date.now() } : {}),
            ...(action === "keep" || action === "temporary" ? { keep: action === "keep" } : {}),
        };
        await storage.setItem(id, next);
        changed();
        return next;
    };
    return navigator.locks ? navigator.locks.request(lockName(id), update) : update();
}

export async function temporaryReferenceHeaders(media: Pick<UploadedFile, "referenceId">, signal?: AbortSignal): Promise<Record<string, string>> {
    if (!media.referenceId) return {};
    await updateVideoReferenceRetention(media.referenceId, "use", signal);
    return { "X-Video-Reference-ID": media.referenceId };
}

export async function saveAnalysisReference(id: string, sourceKey: string, analysis: UploadedFile) {
    const save = async () => {
        const saved = await readVideoReferenceRetention(id);
        if (!saved || saved.cleanedAt) throw new Error("原视频已清理，请重新导入");
        await storage.setItem(id, { ...saved, analysis, analysisSourceKey: sourceKey, keys: [...new Set([...saved.keys, analysis.storageKey])] });
        changed();
    };
    return navigator.locks ? navigator.locks.request(lockName(id), save) : save();
}

export async function registerTemporaryReferenceCopy(id: string, media: UploadedFile): Promise<UploadedFile> {
    const save = async () => {
        const saved = await readVideoReferenceRetention(id);
        if (!saved) return media;
        if (saved.cleanedAt) {
            await deleteStoredMedia([media.storageKey]);
            throw new Error("参考视频已清理，请重新导入");
        }
        await storage.setItem(id, { ...saved, keys: [...new Set([...saved.keys, media.storageKey])] });
        return { ...media, referenceId: id };
    };
    return navigator.locks ? navigator.locks.request(lockName(id), save) : save();
}

export async function collectTemporaryReferences() {
    const references: TemporaryVideoReference[] = [];
    await storage.iterate<TemporaryVideoReference, void>((value) => { references.push(value); });
    return references;
}

let sweeping = false;
export async function cleanupTemporaryVideoReferences() {
    if (sweeping || !navigator.locks) return;
    sweeping = true;
    try {
        const [{ useVideoWorkbenchStore }, { useAssetStore }, { useCanvasStore }] = await Promise.all([
            import("@/stores/use-video-workbench-store"), import("@/stores/use-asset-store"), import("@/stores/canvas/use-canvas-store"),
        ]);
        await Promise.all([useVideoWorkbenchStore, useAssetStore, useCanvasStore].map((store) =>
            store.persist.hasHydrated() ? Promise.resolve() : new Promise<void>((resolve) => {
                const unsubscribe = store.persist.onFinishHydration(() => { unsubscribe(); resolve(); });
            }),
        ));
        if (![useVideoWorkbenchStore.getState().hydrated, useAssetStore.getState().hydrated, useCanvasStore.getState().hydrated].every(Boolean) || useVideoWorkbenchStore.getState().storageError) return;
        const logs = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
        const logValues: unknown[] = [];
        await logs.iterate((value) => { logValues.push(value); });
        const { drafts, records, digitalPresets, busyTools } = useVideoWorkbenchStore.getState();
        const protectedKeys = collectMediaStorageKeys({
            assets: useAssetStore.getState().assets, projects: useCanvasStore.getState().projects, digitalPresets,
            activeDrafts: Object.entries(drafts).filter(([tool]) => busyTools[tool as keyof typeof busyTools]),
            activeRecords: records.filter((record) => record.status === "running" || record.status === "interrupted"),
            // Generated files survive even if they also appear as a reference somewhere.
            outputs: [Object.values(drafts).map((d) => [d.final, d.video, d.edited, d.speech, d.cover]), records.map((r) => r.result)],
        });
        const { localForageStorage } = await import("@/lib/localforage-storage");
        for (const key of ["infinite-canvas:asset_store", "infinite-canvas:canvas_store"]) {
            const raw = await localForageStorage.getItem(key);
            if (raw) collectMediaStorageKeys(JSON.parse(raw), protectedKeys);
        }
        const draftReferences = new Map<string, number>();
        for (const draft of Object.values(drafts)) {
            for (const key of collectMediaStorageKeys(draft.media)) draftReferences.set(key, (draftReferences.get(key) || 0) + 1);
        }
        for (const [key, count] of draftReferences) if (count > 1) protectedKeys.add(key);
        const scanLog = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            const row = value as Record<string, unknown>;
            if (row.status === "pending") collectMediaStorageKeys(value, protectedKeys);
            if (row.video && typeof row.video === "object") collectMediaStorageKeys(row.video, protectedKeys);
            Object.values(row).forEach((child) => { if (typeof child === "object") scanLog(child); });
        };
        logValues.forEach(scanLog);
        const references = await collectTemporaryReferences();
        const draftKeys = Object.values(drafts).map((draft) => collectMediaStorageKeys(draft.media));
        for (const reference of references) {
            if (!reference.cleanedAt && (reference.keep || referenceExpiresAt(reference) > Date.now() ||
                draftKeys.filter((keys) => reference.keys.some((key) => keys.has(key))).length > 1)) {
                reference.keys.forEach((key) => protectedKeys.add(key));
            }
        }
        for (const reference of references) {
            await navigator.locks.request(lockName(reference.id), { ifAvailable: true }, async (lock) => {
                if (!lock) return;
                const current = await readVideoReferenceRetention(reference.id);
                if (!current || !canCleanVideoReference(current, Date.now(), protectedKeys)) return;
                if (Object.values(drafts).filter((draft) => {
                    const keys = collectMediaStorageKeys(draft.media);
                    return current.keys.some((key) => keys.has(key));
                }).length > 1) return;
                const user = useUserStore.getState();
                if (current.userId && current.userId !== user.user?.id) return;
                // Another tab can be using this file without this tab's in-memory store.
                const persisted = await localforage.createInstance({ name: "infinite-canvas", storeName: "video_workbench" }).getItem<string>("workbench");
                if (!persisted) return;
                const state = JSON.parse(persisted).state;
                if (!state || !Array.isArray(state.records)) return;
                const pending = collectMediaStorageKeys([
                    state.records.filter((record: { status: string }) => record.status === "running" || record.status === "interrupted"),
                    state.digitalPresets,
                ]);
                const counts = new Map<string, number>();
                for (const draft of Object.values(state.drafts || {}) as { media?: unknown }[]) {
                    for (const key of collectMediaStorageKeys(draft.media)) counts.set(key, (counts.get(key) || 0) + 1);
                }
                for (const [key, count] of counts) if (count > 1) pending.add(key);
                if (current.keys.some((key) => pending.has(key))) return;
                if ((Object.values(state.drafts || {}) as { media?: unknown }[]).filter((draft) => {
                    const keys = collectMediaStorageKeys(draft.media);
                    return current.keys.some((key) => keys.has(key));
                }).length > 1) return;
                if (user.token) {
                    const response = await fetch("/api/v1/video/reference-retention", {
                        method: "POST", headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ id: current.id, action: "status" }),
                    });
                    const payload = await response.json().catch(() => null);
                    if (!response.ok || payload?.code !== 0 || !payload.data?.canClean || useUserStore.getState().token !== user.token) return;
                } else if (current.userId) return;
                const latest = useVideoWorkbenchStore.getState();
                const active = collectMediaStorageKeys({
                    records: latest.records.filter((r) => r.status === "running" || r.status === "interrupted"),
                    drafts: Object.entries(latest.drafts).filter(([tool]) => latest.busyTools[tool as keyof typeof latest.busyTools]),
                    assets: useAssetStore.getState().assets, projects: useCanvasStore.getState().projects,
                });
                if (current.keys.some((key) => active.has(key))) return;
                await deleteStoredMedia(current.keys);
                await storage.setItem(current.id, { ...current, cleanedAt: Date.now(), analysis: undefined });
                const stateAfterDelete = useVideoWorkbenchStore.getState();
                const keys = new Set(current.keys);
                useVideoWorkbenchStore.setState({
                    drafts: clearExpiredReferenceURLs(stateAfterDelete.drafts, keys),
                    records: clearExpiredReferenceURLs(stateAfterDelete.records, keys),
                });
                changed();
            });
        }
    } finally {
        sweeping = false;
    }
}

export { referenceExpiresAt };
