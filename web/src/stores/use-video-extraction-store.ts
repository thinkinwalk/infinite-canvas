import localforage from "localforage";
import { create } from "zustand";
import type { WorkbenchMedia } from "@/types/video-workbench";

export type VideoExtraction = { id: string; createdAt: number; originalBytes: number; media: WorkbenchMedia };
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "video_extractions" });
let loadVersion = 0;
async function withOwnerLock(owner: string, action: () => Promise<void>): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.locks) {
        await navigator.locks.request(`infinite-canvas:video-extractions:${owner}`, action);
    } else await action();
}

type ExtractionState = {
    owner: string;
    hydrated: boolean;
    error: string;
    records: VideoExtraction[];
    load: (owner: string) => Promise<void>;
    add: (owner: string, record: VideoExtraction) => Promise<void>;
    remove: (owner: string, id: string) => Promise<void>;
};

export const useVideoExtractionStore = create<ExtractionState>((set, get) => ({
    owner: "", hydrated: false, error: "", records: [],
    load: async (owner) => {
        const version = ++loadVersion;
        set({ owner, hydrated: false, error: "", records: [] });
        if (!owner) { set({ hydrated: true }); return; }
        try {
            const records = await storage.getItem<VideoExtraction[]>(owner) || [];
            if (version === loadVersion) set({ records, hydrated: true });
        } catch {
            if (version === loadVersion) set({ error: "提取记录读取失败，请检查浏览器存储后重试", hydrated: true });
        }
    },
    add: async (owner, record) => {
        const state = get();
        if (!owner || state.owner !== owner || !state.hydrated || state.error) throw new Error("提取记录尚未恢复，请重新打开页面");
        const version = loadVersion;
        await withOwnerLock(owner, async () => {
            const records = [record, ...(await storage.getItem<VideoExtraction[]>(owner) || [])];
            await storage.setItem(owner, records);
            if (get().owner === owner && version === loadVersion) set({ records });
        });
    },
    remove: async (owner, id) => {
        const state = get();
        if (!owner || state.owner !== owner || !state.hydrated || state.error) throw new Error("提取记录尚未恢复");
        const version = loadVersion;
        await withOwnerLock(owner, async () => {
            const records = (await storage.getItem<VideoExtraction[]>(owner) || []).filter((record) => record.id !== id);
            await storage.setItem(owner, records);
            if (get().owner === owner && version === loadVersion) set({ records });
        });
    },
}));
