import localforage from "localforage";
import { create } from "zustand";
import type { WorkbenchMedia } from "@/types/video-workbench";
import type { SegmentPlan } from "@/lib/video-segmentation";

export type VideoExtractionClip = { id: string; createdAt: number; start: number; end: number; media: WorkbenchMedia };
export type VideoExtraction = { id: string; createdAt: number; originalBytes: number; originalStorageKey?: string; media: WorkbenchMedia; clips?: VideoExtractionClip[]; segmentPlan?: SegmentPlan };
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
    saveClip: (owner: string, parentId: string, clip: VideoExtractionClip, previous?: VideoExtractionClip, validate?: () => void, planSourceId?: string) => Promise<void>;
    removeClip: (owner: string, parentId: string, clip: VideoExtractionClip, validate?: () => void) => Promise<void>;
    savePlan: (owner: string, parentId: string, plan: SegmentPlan, validate: () => void, previous?: SegmentPlan) => Promise<void>;
};

async function updateExtraction(owner: string, parentId: string, update: (record: VideoExtraction) => VideoExtraction, validate?: () => void): Promise<void> {
    const version = loadVersion;
    const check = () => {
        validate?.();
        const state = useVideoExtractionStore.getState();
        if (!owner || state.owner !== owner || !state.hydrated || state.error || version !== loadVersion) throw new Error("提取记录尚未恢复或账号已变化，请重新打开页面");
    };
    check();
    await withOwnerLock(owner, async () => {
        check();
        const records = await storage.getItem<VideoExtraction[]>(owner) || [];
        check();
        const parent = records.find((record) => record.id === parentId);
        if (!parent) throw new Error("原视频记录已移除，无法保存片段");
        const next = records.map((record) => record === parent ? update(record) : record);
        check();
        await storage.setItem(owner, next);
        if (useVideoExtractionStore.getState().owner === owner && version === loadVersion) useVideoExtractionStore.setState({ records: next });
    });
}

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
    savePlan: (owner, parentId, plan, validate, previous) => updateExtraction(owner, parentId, (record) => {
        if (JSON.stringify(record.segmentPlan) !== JSON.stringify(previous)) throw new Error("分段方案已在其他页面变化，请刷新后重试");
        return { ...record, segmentPlan: plan };
    }, validate),
    saveClip: (owner, parentId, clip, previous, validate, planSourceId) => updateExtraction(owner, parentId, (record) => {
        const clips = record.clips || [];
        if (planSourceId) {
            const plan = record.segmentPlan;
            const index = plan?.parts.findIndex((part) => part.start === clip.start && part.end === clip.end && !part.savedClipId);
            if (!plan || plan.sourceId !== planSourceId || index === undefined || index < 0) throw new Error("分段方案已变化，请重新打开方案");
            return { ...record, clips: [...clips, clip], segmentPlan: { ...plan, parts: plan.parts.map((part, position) => position === index ? { ...part, savedClipId: clip.id } : part) } };
        }
        if (!previous) return { ...record, clips: [...clips, clip] };
        if (JSON.stringify(clips.find((item) => item.id === previous.id)) !== JSON.stringify(previous)) throw new Error("片段已在其他页面修改，请重新选择");
        return { ...record, clips: clips.map((item) => item.id === previous.id ? clip : item),
            segmentPlan: record.segmentPlan && { ...record.segmentPlan, parts: record.segmentPlan.parts.map((part) => part.savedClipId === previous.id
                ? { ...part, savedClipId: part.start === clip.start && part.end === clip.end ? clip.id : undefined, name: part.start === clip.start && part.end === clip.end ? clip.media.name.replace(/\.mp4$/i, "") : part.name } : part) } };
    }, validate),
    removeClip: (owner, parentId, clip, validate) => updateExtraction(owner, parentId, (record) => {
        const clips = record.clips || [];
        if (JSON.stringify(clips.find((item) => item.id === clip.id)) !== JSON.stringify(clip)) throw new Error("片段已变化，请重新选择");
        return { ...record, clips: clips.filter((item) => item.id !== clip.id),
            segmentPlan: record.segmentPlan && { ...record.segmentPlan, parts: record.segmentPlan.parts.map((part) => part.savedClipId === clip.id ? { ...part, savedClipId: undefined } : part) } };
    }, validate),
}));
