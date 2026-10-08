import localforage from "localforage";

import { runPromptSource, type RawPrompt } from "./prompt-source-runtime";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import i18n from "@/i18n";
import type { PromptSource } from "./prompt-source-presets";
import { loadCuratedPrompts, mergePromptCatalogue } from "./prompt-editorial";

export type Prompt = RawPrompt & {
    sourceId: string;
    category: string;
    githubUrl: string;
};

export const ALL_PROMPTS_OPTION = "all";
export type PromptReferenceFilter = "all" | "none" | "required";

const scenarioMatchers: Array<[string, RegExp]> = [
    ["UI 与网页视觉", /界面|网页|ui design|landing page|website/i],
    ["商品详情与套图", /详情|套图|爆炸图|爆炸视图|产品结构|product detail|exploded view/i],
    ["电商商品图", /电商|商品|产品|带货|commerce|product|packshot/i],
    ["PPT 与信息图", /ppt|slides?|演示|信息图|图表|infographic|chart|diagram/i],
    ["教程与知识表达", /教程|学习|知识|思维导图|教育|教学|科普|education|tutorial|mind.?map/i],
    ["品牌与包装", /品牌|包装|logo|brand|packag/i],
    ["海报与广告", /海报|广告|poster|advertis/i],
    ["社交媒体内容", /社媒|小红书|短视频|封面|社交|social|thumbnail/i],
    ["人像与头像", /人像|头像|肖像|发型|portrait|headshot|profile/i],
    ["角色与一致性", /角色|人物设定|表情包|character|consistent/i],
    ["室内与空间", /室内|空间|建筑|家居|interior|architecture/i],
    ["图片编辑", /改图|换背景|修图|替换|编辑|修复|edit|retouch/i],
];

export function getPromptScenario(prompt: Pick<Prompt, "title" | "scenario" | "category" | "tags">) {
    if (prompt.scenario) return prompt.scenario;
    const fromTitle = scenarioMatchers.find(([, pattern]) => pattern.test(prompt.title));
    const fromTags = scenarioMatchers.find(([, pattern]) => pattern.test(prompt.tags.join(" ")));
    return fromTitle?.[0] || fromTags?.[0] || "个人创作";
}

export type PromptListResponse = {
    items: Prompt[];
    tags: string[];
    categories: string[];
    total: number;
};

export type PromptSourceStatus = {
    sourceId: string;
    count: number;
    lastSuccessAt: string;
    lastError: string;
};

export type PromptSourceRefreshResult = PromptSourceStatus & {
    sourceName: string;
    success: boolean;
};

export type PromptSourceRefreshSummary = {
    results: PromptSourceRefreshResult[];
    total: number;
    successCount: number;
    failureCount: number;
};

type SourceCache = PromptSourceStatus & {
    items: Prompt[];
    fetchedAt: number;
    signature: string;
};

const cacheTtlMs = 1000 * 60 * 60;
const promptCacheStore = localforage.createInstance({ name: "infinite-canvas", storeName: "prompt_cache" });
const loadingSources = new Map<string, Promise<PromptSourceRefreshResult>>();

function enabledSources() {
    return usePromptSourceStore.getState().sources.filter((source) => source.enabled);
}

function cacheKey(sourceId: string) {
    return `prompt-source:${sourceId}`;
}

function sourceSignature(source: PromptSource) {
    const value = `${source.name}\n${source.url}\n${source.homepage}`;
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) | 0;
    return `${value.length}:${hash}`;
}

function withSourceMeta(source: PromptSource, items: RawPrompt[]): Prompt[] {
    return items.map((item) => ({
        ...item,
        featured: false,
        description: item.description || "",
        referenceImageUrls: Array.isArray(item.referenceImageUrls) ? item.referenceImageUrls : [],
        sourceId: source.id,
        category: source.name,
        githubUrl: item.sourceUrl || source.homepage,
    }));
}

async function readSourceCache(sourceId: string) {
    return promptCacheStore.getItem<SourceCache>(cacheKey(sourceId));
}

async function refreshSourceRecord(source: PromptSource): Promise<PromptSourceRefreshResult> {
    const previous = await readSourceCache(source.id);
    try {
        const items = withSourceMeta(source, await runPromptSource(source));
        const lastSuccessAt = new Date().toISOString();
        const cache: SourceCache = { sourceId: source.id, items, count: items.length, fetchedAt: Date.now(), lastSuccessAt, lastError: "", signature: sourceSignature(source) };
        await promptCacheStore.setItem(cacheKey(source.id), cache);
        return { sourceId: source.id, sourceName: source.name, count: items.length, lastSuccessAt, lastError: "", success: true };
    } catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        const cache: SourceCache = {
            sourceId: source.id,
            items: previous?.items || [],
            count: previous?.items?.length || 0,
            fetchedAt: previous?.fetchedAt || 0,
            lastSuccessAt: previous?.lastSuccessAt || "",
            lastError,
            signature: previous?.signature || sourceSignature(source),
        };
        await promptCacheStore.setItem(cacheKey(source.id), cache);
        return { sourceId: source.id, sourceName: source.name, count: cache.count, lastSuccessAt: cache.lastSuccessAt, lastError, success: false };
    }
}

function getOrStartRefresh(source: PromptSource) {
    const current = loadingSources.get(source.id);
    if (current) return current;
    const loading = refreshSourceRecord(source).finally(() => loadingSources.delete(source.id));
    loadingSources.set(source.id, loading);
    return loading;
}

async function getSourcePrompts(source: PromptSource): Promise<Prompt[]> {
    const cached = await readSourceCache(source.id);
    if (cached) {
        const stale = cached.signature !== sourceSignature(source) || Date.now() - cached.fetchedAt >= cacheTtlMs;
        if (stale) void getOrStartRefresh(source).catch(() => undefined);
        return withSourceMeta(source, cached.items);
    }
    const result = await getOrStartRefresh(source);
    if (!result.success) throw new Error(result.lastError);
    return (await readSourceCache(source.id))?.items || [];
}

async function getAllPrompts(): Promise<Prompt[]> {
    const settled = await Promise.all(
        enabledSources().map(async (source) => {
            try {
                return await getSourcePrompts(source);
            } catch {
                return [];
            }
        }),
    );
    return settled.flat();
}

export async function fetchPrompts({ keyword = "", tag = [], category = ALL_PROMPTS_OPTION, featuredOnly = false, reference = "all", page = 1, pageSize = 20 }: { keyword?: string; tag?: string[]; category?: string; featuredOnly?: boolean; reference?: PromptReferenceFilter; page?: number; pageSize?: number } = {}) {
    const curated = await loadCuratedPrompts();
    const normalizedKeyword = keyword.trim().toLowerCase();
    const normalizedPage = Math.max(1, page);
    const normalizedPageSize = Math.max(1, Math.min(100, pageSize));
    const library = featuredOnly ? curated : mergePromptCatalogue(curated, await getAllPrompts());
    const withoutTagFilter = filterPrompts(library, { keyword: normalizedKeyword, category, tags: [], reference });
    const filtered = filterPrompts(library, { keyword: normalizedKeyword, category, tags: tag, reference });
    const categories = Array.from(new Set(library.map(getPromptScenario).filter(Boolean)));

    return {
        items: filtered.slice((normalizedPage - 1) * normalizedPageSize, normalizedPage * normalizedPageSize),
        tags: collectTags(withoutTagFilter),
        categories,
        total: filtered.length,
    };
}

export async function fetchSourcePrompts(sourceId: string): Promise<Prompt[]> {
    const source = usePromptSourceStore.getState().sources.find((item) => item.id === sourceId);
    if (!source) throw new Error(i18n.t("prompts.sourceMissing"));
    return getSourcePrompts(source);
}

export async function refreshSource(sourceId: string): Promise<PromptSourceRefreshResult> {
    const source = usePromptSourceStore.getState().sources.find((item) => item.id === sourceId);
    if (!source) throw new Error(i18n.t("prompts.sourceMissing"));
    const result = await getOrStartRefresh(source);
    if (!result.success) throw new Error(result.lastError);
    return result;
}

export async function refreshAllSources(): Promise<PromptSourceRefreshSummary> {
    const results = await Promise.all(enabledSources().map(getOrStartRefresh));
    return summarizeRefresh(results);
}

export async function refreshDueSources(maxAgeMs: number): Promise<PromptSourceRefreshSummary> {
    const sources = await Promise.all(
        enabledSources().map(async (source) => {
            const cached = await readSourceCache(source.id);
            const lastSuccess = cached?.lastSuccessAt ? new Date(cached.lastSuccessAt).getTime() : 0;
            return !lastSuccess || Boolean(cached?.lastError) || Date.now() - lastSuccess >= maxAgeMs || cached?.signature !== sourceSignature(source) ? source : null;
        }),
    );
    const results = await Promise.all(sources.filter((source): source is PromptSource => Boolean(source)).map(getOrStartRefresh));
    return summarizeRefresh(results);
}

export async function fetchPromptSourceStatuses(): Promise<Record<string, PromptSourceStatus>> {
    const entries = await Promise.all(
        usePromptSourceStore.getState().sources.map(async (source) => {
            const cache = await readSourceCache(source.id);
            return [source.id, { sourceId: source.id, count: cache?.items?.length || 0, lastSuccessAt: cache?.lastSuccessAt || "", lastError: cache?.lastError || "" }] as const;
        }),
    );
    return Object.fromEntries(entries);
}

function summarizeRefresh(results: PromptSourceRefreshResult[]): PromptSourceRefreshSummary {
    return {
        results,
        total: results.reduce((total, item) => total + item.count, 0),
        successCount: results.filter((item) => item.success).length,
        failureCount: results.filter((item) => !item.success).length,
    };
}

function filterPrompts(items: Prompt[], options: { keyword: string; category: string; tags: string[]; reference: PromptReferenceFilter }) {
    return items.filter((item) => {
        const needsReference = Boolean(item.minReferenceImages || item.requiresRef);
        if (options.reference === "none" && item.minReferenceImages !== 0 && item.requiresRef !== false) return false;
        if (options.reference === "required" && !needsReference) return false;
        if (isActiveOption(options.category) && getPromptScenario(item) !== options.category && item.category !== options.category) return false;
        if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
        if (!options.keyword) return true;
        return [item.title, item.prompt, item.description, item.category, item.scenario, item.problem, item.inputHint, item.output, ...item.tags].join(" ").toLowerCase().includes(options.keyword);
    });
}

function collectTags(items: Prompt[]) {
    return Array.from(new Set(items.flatMap((item) => item.tags).filter(Boolean)));
}

function isActiveOption(value: string) {
    return value && value !== ALL_PROMPTS_OPTION && value !== "all";
}

export function formatPromptDate(value: string, locale?: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
