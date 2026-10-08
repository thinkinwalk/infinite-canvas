import type { Prompt } from "./prompts";

let catalogue: Promise<Prompt[]> | undefined;

export function loadCuratedPrompts() {
    catalogue ??= fetch(`${import.meta.env.BASE_URL}prompts/curated-v1.json`).then(async (response) => {
        if (!response.ok) throw new Error("精选案例加载失败，请刷新重试");
        return await response.json() as Prompt[];
    }).catch((error) => {
        catalogue = undefined;
        throw error;
    });
    return catalogue;
}

export function mergePromptCatalogue(curated: Prompt[], sources: Prompt[]) {
    const ids = new Set<string>();
    const texts = new Set<string>();
    return [...curated, ...sources].filter((item) => {
        const text = (item.originalPrompt || item.prompt).normalize("NFKC").replace(/\s+/g, "").toLowerCase();
        if (ids.has(item.id) || texts.has(text)) return false;
        ids.add(item.id);
        texts.add(text);
        return true;
    });
}
