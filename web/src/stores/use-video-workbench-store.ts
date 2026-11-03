import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { archiveContentReplacementDraft, newContentReplacementDraft, normalizeContentReplacementDraft } from "@/lib/content-replacement-state";
import { archiveViralTask } from "@/lib/viral-task";
import { emptyVideoDraft, type DigitalHumanPreset, type StorePreset, type StoreProject, type VideoDraft, type VideoRecord, type VideoTool, type WorkerConfig } from "@/types/video-workbench";
import { flushWorkbenchStorage, workbenchStorage } from "./workbench-storage";

type WorkbenchState = {
    hydrated: boolean;
    storageError: string;
    busyTools: Partial<Record<VideoTool, boolean>>;
    setBusy: (tool: VideoTool, busy: boolean) => void;
    setStorageError: (error: string) => void;
    drafts: Partial<Record<VideoTool, VideoDraft>>;
    records: VideoRecord[];
    archivedTasks: Record<string, boolean>;
    setTaskArchived: (keys: string[], archived: boolean) => void;
    digitalPresets: DigitalHumanPreset[];
    storePresets: StorePreset[];
    storeProjects: Record<string, StoreProject>;
    activeStoreProjectId: string;
    storeBusyProjects: Record<string, boolean>;
    storeQuerying: Record<string, boolean>;
    ensureStoreProject: () => void;
    createStoreProject: (name?: string, draft?: VideoDraft, select?: boolean) => Promise<string>;
    selectStoreProject: (id: string) => void;
    renameStoreProject: (id: string, name: string) => void;
    patchStoreProject: (id: string, patch: Partial<VideoDraft>, edited?: boolean) => void;
    setStoreBusy: (id: string, busy: boolean) => void;
    setStoreQuerying: (id: string, querying: boolean) => void;
    storePreviewRecordId: string;
    setStorePreviewRecord: (id: string) => void;
    saveStorePreset: (preset: StorePreset) => void;
    removeStorePreset: (id: string) => void;
    saveDigitalPreset: (preset: DigitalHumanPreset) => void;
    removeDigitalPreset: (id: string) => void;
    worker: WorkerConfig;
    setHydrated: () => void;
    patchDraft: (tool: VideoTool, patch: Partial<VideoDraft>) => void;
    replaceDraft: (tool: VideoTool, draft: VideoDraft) => Promise<void>;
    openViralTask: (draft?: VideoDraft) => Promise<void>;
    openContentReplacementTask: (draft?: VideoDraft) => Promise<void>;
    addRecord: (record: VideoRecord) => void;
    patchRecord: (id: string, patch: Partial<VideoRecord>) => void;
    setWorker: (patch: Partial<WorkerConfig>) => void;
};

const selectedProject = () => typeof sessionStorage === "undefined" ? "" : sessionStorage.getItem("store-explore-project") || "";

export const useVideoWorkbenchStore = create<WorkbenchState>()(
    persist(
        (set, get) => ({
            hydrated: false, storageError: "", busyTools: {}, setBusy: (tool, busy) => set((state) => ({ busyTools: { ...state.busyTools, [tool]: busy } })), setStorageError: (storageError) => set({ storageError }), drafts: {}, records: [], worker: { url: import.meta.env.DEV ? "http://127.0.0.1:8767" : "/api/v1/video-worker", token: "" },
            setHydrated: () => set({ hydrated: true }),
            digitalPresets: [], archivedTasks: {},
            storePresets: [],
            storeProjects: {}, activeStoreProjectId: selectedProject(), storeBusyProjects: {}, storeQuerying: {}, storePreviewRecordId: "",
            setStorePreviewRecord: (id) => set({ storePreviewRecordId: id }),
            ensureStoreProject: () => {
                const current = get();
                if (Object.keys(current.storeProjects).length) {
                    if (!current.storeProjects[current.activeStoreProjectId]) current.selectStoreProject(Object.keys(current.storeProjects)[0]);
                    return;
                }
                const id = "store-initial", now = Date.now();
                const draft = { ...emptyVideoDraft("store-explore"), ...current.drafts["store-explore"] };
                const { "store-explore": _previous, ...drafts } = current.drafts;
                set({
                    drafts, activeStoreProjectId: id,
                    storeProjects: { [id]: { id, name: "探店项目 1", draft, revision: 0, createdAt: now, updatedAt: now } },
                    records: current.records.map((r) => r.tool === "store-explore" && !r.storeProjectId ? { ...r, storeProjectId: id } : r),
                });
                sessionStorage.setItem("store-explore-project", id);
            },
            createStoreProject: async (name, draft, select = true) => {
                if (!get().hydrated || get().storageError) throw new Error("本地保存尚未就绪，请稍后重试");
                const id = crypto.randomUUID(), now = Date.now();
                set((state) => ({
                    storeProjects: { ...state.storeProjects, [id]: { id, name: name?.trim() || `探店项目 ${Object.keys(state.storeProjects).length + 1}`, draft: { ...emptyVideoDraft("store-explore"), ...draft }, revision: 0, createdAt: now, updatedAt: now } },
                }));
                await flushWorkbenchStorage();
                if (select) get().selectStoreProject(id);
                return id;
            },
            selectStoreProject: (id) => {
                if (!get().storeProjects[id]) return;
                sessionStorage.setItem("store-explore-project", id);
                set({ activeStoreProjectId: id });
            },
            renameStoreProject: (id, name) => set((state) => {
                const project = state.storeProjects[id];
                return project && name.trim() ? { storeProjects: { ...state.storeProjects, [id]: { ...project, name: name.trim(), updatedAt: Date.now() } } } : {};
            }),
            patchStoreProject: (id, patch, edited = false) => set((state) => {
                const project = state.storeProjects[id];
                return project ? { storeProjects: { ...state.storeProjects, [id]: { ...project, draft: { ...project.draft, ...patch }, revision: project.revision + (edited ? 1 : 0), updatedAt: Date.now() } } } : {};
            }),
            setStoreBusy: (id, busy) => set((state) => ({ storeBusyProjects: { ...state.storeBusyProjects, [id]: busy } })),
            setStoreQuerying: (id, querying) => set((state) => ({ storeQuerying: { ...state.storeQuerying, [id]: querying } })),
            saveStorePreset: (preset) => set((state) => ({ storePresets: [...state.storePresets.filter((p) => p.id !== preset.id), preset] })),
            removeStorePreset: (id) => set((state) => ({ storePresets: state.storePresets.filter((p) => p.id !== id) })),
            setTaskArchived: (keys, archived) => set((state) => ({
                archivedTasks: { ...state.archivedTasks, ...Object.fromEntries(keys.map((key) => [key, archived])) },
            })),
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
            openContentReplacementTask: async (draft) => {
                const current = useVideoWorkbenchStore.getState();
                if (!current.hydrated || current.storageError || current.busyTools["content-replace"]) throw new Error("当前任务尚未就绪，请稍后重试");
                await set((state) => ({
                    records: archiveContentReplacementDraft(state.drafts["content-replace"], state.records),
                    drafts: {
                        ...state.drafts,
                        "content-replace": normalizeContentReplacementDraft(newContentReplacementDraft(draft)),
                    },
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
                getItem: workbenchStorage.getItem,
                setItem: async (key, value) => { try { await workbenchStorage.setItem(key, value); } catch (error) { const detail = error instanceof Error ? error.message : "本地保存失败"; if (useVideoWorkbenchStore.getState().storageError !== detail) useVideoWorkbenchStore.getState().setStorageError(detail); } },
                removeItem: workbenchStorage.removeItem,
            })),
            partialize: ({ drafts, records, worker, digitalPresets, storePresets, archivedTasks, storeProjects }) => ({ drafts, records, worker, digitalPresets, storePresets, archivedTasks, storeProjects }),
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
