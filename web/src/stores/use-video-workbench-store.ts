import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { normalizeContentReplacementDraft } from "@/lib/content-replacement-state";
import { archiveViralTask } from "@/lib/viral-task";
import { emptyVideoDraft, type DigitalHumanPreset, type VideoDraft, type VideoRecord, type VideoTool, type WorkerConfig } from "@/types/video-workbench";

type WorkbenchState = {
    hydrated: boolean;
    storageError: string;
    busyTools: Partial<Record<VideoTool, boolean>>;
    setBusy: (tool: VideoTool, busy: boolean) => void;
    setStorageError: (error: string) => void;
    drafts: Partial<Record<VideoTool, VideoDraft>>;
    records: VideoRecord[];
    digitalPresets: DigitalHumanPreset[];
    saveDigitalPreset: (preset: DigitalHumanPreset) => void;
    removeDigitalPreset: (id: string) => void;
    worker: WorkerConfig;
    setHydrated: () => void;
    patchDraft: (tool: VideoTool, patch: Partial<VideoDraft>) => void;
    replaceDraft: (tool: VideoTool, draft: VideoDraft) => Promise<void>;
    openViralTask: (draft?: VideoDraft) => Promise<void>;
    addRecord: (record: VideoRecord) => void;
    patchRecord: (id: string, patch: Partial<VideoRecord>) => void;
    setWorker: (patch: Partial<WorkerConfig>) => void;
};

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "video_workbench" });

export const useVideoWorkbenchStore = create<WorkbenchState>()(
    persist(
        (set) => ({
            hydrated: false, storageError: "", busyTools: {}, setBusy: (tool, busy) => set((state) => ({ busyTools: { ...state.busyTools, [tool]: busy } })), setStorageError: (storageError) => set({ storageError }), drafts: {}, records: [], worker: { url: import.meta.env.DEV ? "http://127.0.0.1:8767" : "/api/v1/video-worker", token: "" },
            setHydrated: () => set({ hydrated: true }),
            digitalPresets: [],
            saveDigitalPreset: (preset) => set((state) => ({ digitalPresets: [...state.digitalPresets.filter((p) => p.id !== preset.id), preset] })),
            removeDigitalPreset: (id) => set((state) => ({ digitalPresets: state.digitalPresets.filter((p) => p.id !== id) })),
            patchDraft: (tool, patch) => set((state) => {
                const draft = { ...emptyVideoDraft(tool), ...state.drafts[tool], ...patch };
                return { drafts: { ...state.drafts, [tool]: tool === "content-replace" ? normalizeContentReplacementDraft(draft) : draft } };
            }),
            replaceDraft: async (tool, draft) => {
                await set((state) => ({
                    drafts: { ...state.drafts, [tool]: tool === "content-replace" ? normalizeContentReplacementDraft(draft) : draft },
                }));
                if (useVideoWorkbenchStore.getState().storageError) throw new Error("草稿保存失败，请检查浏览器存储后重试");
            },
            openViralTask: async (draft) => {
                const current = useVideoWorkbenchStore.getState();
                if (!current.hydrated || current.storageError || current.busyTools["viral-recreate"]) throw new Error("当前任务尚未就绪，请稍后重试");
                await set((state) => ({
                    records: archiveViralTask(state.drafts["viral-recreate"], state.records),
                    drafts: { ...state.drafts, "viral-recreate": {
                        ...emptyVideoDraft("viral-recreate"), ...draft,
                        viralTaskId: draft?.viralTaskId || crypto.randomUUID(),
                        viralRevision: (state.drafts["viral-recreate"]?.viralRevision || 0) + 1,
                    } },
                }));
                if (useVideoWorkbenchStore.getState().storageError) throw new Error("任务保存失败，请检查浏览器存储后重试");
            },
            addRecord: (record) => set((state) => ({ records: [record, ...state.records] })),
            patchRecord: (id, patch) => set((state) => ({ records: state.records.map((record) => record.id === id ? { ...record, ...patch } : record) })),
            setWorker: (patch) => set((state) => ({ worker: { ...state.worker, ...patch } })),
        }),
        {
            name: "workbench",
            storage: createJSONStorage(() => ({
                getItem: (key) => storage.getItem<string>(key),
                setItem: async (key, value) => { try { await storage.setItem(key, value); } catch (error) { const detail = error instanceof Error ? error.message : "本地保存失败"; if (useVideoWorkbenchStore.getState().storageError !== detail) useVideoWorkbenchStore.getState().setStorageError(detail); } },
                removeItem: (key) => storage.removeItem(key),
            })),
            partialize: ({ drafts, records, worker, digitalPresets }) => ({ drafts, records, worker, digitalPresets }),
            merge: (persisted, current) => {
                const saved = (persisted || {}) as Partial<WorkbenchState>;
                const draft = saved.drafts?.["content-replace"];
                return {
                    ...current, ...saved,
                    drafts: { ...saved.drafts, ...(draft ? { "content-replace": normalizeContentReplacementDraft({ ...emptyVideoDraft("content-replace"), ...draft }) } : {}) },
                };
            },
            onRehydrateStorage: () => (state, error) => {
                if (error) useVideoWorkbenchStore.getState().setStorageError("视频工作台本地记录加载失败，请检查浏览器存储权限");
                (state || useVideoWorkbenchStore.getState()).setHydrated();
            },
        },
    ),
);
