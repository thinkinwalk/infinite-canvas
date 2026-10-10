import localforage from "localforage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type HomeCreationKind = "image" | "video" | "human";
type HomeDraftState = {
    hydrated: boolean;
    storageError: boolean;
    kind: HomeCreationKind;
    prompts: Record<HomeCreationKind, string>;
    humanMode: "photo" | "video";
    humanCopySource: "manual" | "brief";
    setKind: (kind: HomeCreationKind) => void;
    setPrompt: (kind: HomeCreationKind, prompt: string) => void;
    setHumanMode: (humanMode: "photo" | "video") => void;
    setHumanCopySource: (humanCopySource: "manual" | "brief") => void;
};
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "home_drafts" });

export const useHomeDraftStore = create<HomeDraftState>()(persist((set) => ({
    hydrated: false, storageError: false, kind: "image", prompts: { image: "", video: "", human: "" }, humanMode: "photo", humanCopySource: "manual",
    setKind: (kind) => set({ kind }),
    setPrompt: (kind, prompt) => set((state) => ({ prompts: { ...state.prompts, [kind]: prompt } })),
    setHumanMode: (humanMode) => set({ humanMode }),
    setHumanCopySource: (humanCopySource) => set({ humanCopySource }),
}), {
    name: "home-creation",
    storage: createJSONStorage(() => ({
        getItem: (key) => storage.getItem<string>(key),
        setItem: async (key, value) => { try { await storage.setItem(key, value); } catch { useHomeDraftStore.setState({ storageError: true }); } },
        removeItem: (key) => storage.removeItem(key),
    })),
    partialize: ({ kind, prompts, humanMode, humanCopySource }) => ({ kind, prompts, humanMode, humanCopySource }),
    onRehydrateStorage: () => (_, error) => useHomeDraftStore.setState({ hydrated: true, storageError: Boolean(error) }),
}));
