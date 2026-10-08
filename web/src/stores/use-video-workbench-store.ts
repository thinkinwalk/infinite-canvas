import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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
            patchDraft: (tool, patch) => set((state) => ({ drafts: { ...state.drafts, [tool]: { ...emptyVideoDraft(tool), ...state.drafts[tool], ...patch } } })),
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
            onRehydrateStorage: () => (state, error) => {
                if (error) useVideoWorkbenchStore.getState().setStorageError("视频工作台本地记录加载失败，请检查浏览器存储权限");
                (state || useVideoWorkbenchStore.getState()).setHydrated();
            },
        },
    ),
);
