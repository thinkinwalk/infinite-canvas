import { ChevronDown, Filter, FolderPlus, Search, Sparkles, X } from "lucide-react";
import { type ReactNode, type UIEvent, useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Spin, Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";

export default function PromptsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [showFilters, setShowFilters] = useState(false);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory });
    const hasActiveFilters = selectedTags.length > 0 || selectedCategory !== ALL_PROMPTS_OPTION;
    const visibleItems = useMemo(() => {
        return [...promptItems].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || (b.qualityScore || 0) - (a.qualityScore || 0));
    }, [promptItems]);

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : t("prompts.loadFailed"));
    }, [message, query.error, query.isError, t]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    const clearFilters = () => {
        setSelectedTags([]);
        setSelectedCategory(ALL_PROMPTS_OPTION);
    };

    const savePromptAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success(t("common.addedToAssets"));
    };

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-6 sm:px-6 lg:px-8 lg:py-8" onScroll={handleListScroll}>
                <div className="mx-auto max-w-[1600px]">
                    <header className="mx-auto max-w-3xl text-center">
                        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-2xl bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"><Sparkles className="size-5" /></div>
                        <h1 className="text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("prompts.title")}</h1>
                        <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t("prompts.subtitle")}</p>
                    </header>

                    <div className="mx-auto mt-7 max-w-3xl"><Input size="large" allowClear prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} placeholder={t("prompts.search")} onChange={(event) => setTitleKeyword(event.target.value)} /></div>

                    <div className="mt-7 flex items-center gap-2 overflow-x-auto border-b border-stone-200 pb-3 dark:border-stone-800">
                        <span className="mr-1 shrink-0 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{t("prompts.category")}</span>
                        <SceneButton active={selectedCategory === ALL_PROMPTS_OPTION} onClick={() => setSelectedCategory(ALL_PROMPTS_OPTION)}>{t("prompts.all")}</SceneButton>
                        {promptCategoryOptions.filter((option) => option !== ALL_PROMPTS_OPTION).map((option) => <SceneButton key={option} active={selectedCategory === option} onClick={() => setSelectedCategory(option)}>{option}</SceneButton>)}
                        <Button type={showFilters || hasActiveFilters ? "default" : "text"} size="small" icon={<Filter className="size-3.5" />} className="ml-auto shrink-0" onClick={() => setShowFilters((value) => !value)}>{t("prompts.advancedFilters")}<ChevronDown className={cn("size-3.5 transition-transform", showFilters && "rotate-180")} /></Button>
                    </div>

                    {showFilters ? <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                        <span className="mr-1 text-xs font-semibold text-stone-500 dark:text-stone-400">{t("prompts.tags")}</span>
                        <Tag.CheckableTag checked={selectedTags.length === 0} className={cn("prompt-filter-tag", selectedTags.length === 0 && "is-active")} onChange={() => setSelectedTags([])}>{t("common.all")}</Tag.CheckableTag>
                        {promptTags.filter((tag) => tag !== ALL_PROMPTS_OPTION).map((tag) => <Tag.CheckableTag key={tag} checked={selectedTags.includes(tag)} className={cn("prompt-filter-tag", selectedTags.includes(tag) && "is-active")} onChange={() => toggleTag(tag)}>{tag}</Tag.CheckableTag>)}
                        {hasActiveFilters ? <Button type="text" size="small" icon={<X className="size-3.5" />} onClick={clearFilters}>{t("prompts.clearFilters")}</Button> : null}
                    </div> : null}

                    <div className="mt-6 flex items-center justify-between gap-3"><p className="text-sm text-stone-500 dark:text-stone-400">{t("prompts.total", { count: totalPrompts })}</p>{hasActiveFilters ? <Button type="text" size="small" onClick={clearFilters}>{t("prompts.clearFilters")}</Button> : null}</div>
                    {query.isLoading ? <div className="flex h-60 items-center justify-center"><Spin /></div> : null}
                    {!query.isLoading ? <div className="mt-4"><PromptGrid items={visibleItems} onOpen={setSelectedPrompt} renderActions={(item) => <Tooltip title={t("common.addToAssets")}><Button type="text" size="small" icon={<FolderPlus className="size-3.5" />} aria-label={t("common.addToAssets")} onClick={() => savePromptAsset(item)} /></Tooltip>} onCopy={(item) => copyText(item.prompt, t("common.promptCopied"))} emptyText={t("prompts.empty")} /></div> : null}
                    <div className="mt-6 text-center text-xs text-stone-500 dark:text-stone-400">{query.isFetchingNextPage ? t("prompts.loading") : query.hasNextPage ? t("prompts.loadMore") : visibleItems.length > 0 ? t("prompts.end") : null}</div>
                </div>
            </main>
            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={savePromptAsset} />
        </div>
    );
}

function SceneButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
    return <button type="button" className={cn("shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors", active ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900" : "border-stone-200 bg-transparent text-stone-600 hover:border-stone-400 hover:text-stone-950 dark:border-stone-800 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-100")} onClick={onClick}>{children}</button>;
}

function PromptGrid({ items, onOpen, onCopy, renderActions, emptyText }: { items: Prompt[]; onOpen: (item: Prompt) => void; onCopy: (item: Prompt) => void; renderActions: (item: Prompt) => ReactNode; emptyText: string }) {
    return <div>{items.length > 0 ? <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">{items.map((item) => <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => onOpen(item)} onCopy={() => onCopy(item)} extraAction={renderActions(item)} />)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" />}</div>;
}
