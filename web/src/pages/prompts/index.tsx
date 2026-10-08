import { ChevronDown, Filter, FolderPlus, Search, Sparkles, X } from "lucide-react";
import { type ReactNode, type UIEvent, useEffect, useState } from "react";
import { App, Button, Empty, Input, Segmented, Spin, Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { ALL_PROMPTS_OPTION, type Prompt, type PromptReferenceFilter } from "@/services/api/prompts";

export default function PromptsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [showFilters, setShowFilters] = useState(false);
    const [featuredOnly, setFeaturedOnly] = useState(true);
    const [reference, setReference] = useState<PromptReferenceFilter>("all");
    const addAsset = useAssetStore((state) => state.addAsset);
    const dispatchImage = useWorkbenchAgentStore((state) => state.dispatchImage);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory, featuredOnly, reference });
    const hasActiveFilters = selectedTags.length > 0 || selectedCategory !== ALL_PROMPTS_OPTION || reference !== "all";
    const startUsing = (item: Prompt) => {
        dispatchImage({ prompt: item.prompt, run: false, templateInput: { title: item.title, inputHint: item.inputHint || "", minReferenceImages: item.minReferenceImages ?? (item.requiresRef ? 1 : 0) } });
        navigate("/image");
    };

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
        setReference("all");
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

                    <div className="mt-6 flex justify-center"><Segmented value={featuredOnly ? "featured" : "all"} options={[{ label: t("prompts.featured"), value: "featured" }, { label: t("prompts.all"), value: "all" }]} onChange={(value) => { setFeaturedOnly(value === "featured"); clearFilters(); }} /></div>

                    <div className="mt-7 flex min-w-0 items-center gap-2 border-b border-stone-200 pb-3 dark:border-stone-800">
                        <span className="hidden shrink-0 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500 sm:block">{t("prompts.category")}</span>
                        <div className="hide-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                            <SceneButton active={selectedCategory === ALL_PROMPTS_OPTION} onClick={() => setSelectedCategory(ALL_PROMPTS_OPTION)}>{t("prompts.all")}</SceneButton>
                            {promptCategoryOptions.filter((option) => option !== ALL_PROMPTS_OPTION).map((option) => <SceneButton key={option} active={selectedCategory === option} onClick={() => setSelectedCategory(option)}>{option}</SceneButton>)}
                        </div>
                        <Button type={showFilters || hasActiveFilters ? "default" : "text"} size="small" icon={<Filter className="size-3.5" />} className="shrink-0" onClick={() => setShowFilters((value) => !value)}>{t("prompts.advancedFilters")}<ChevronDown className={cn("size-3.5 transition-transform", showFilters && "rotate-180")} /></Button>
                    </div>

                    {showFilters ? <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                        <div className="flex w-full flex-wrap items-center gap-2 pb-2"><span className="mr-1 text-xs font-semibold text-stone-500 dark:text-stone-400">参考素材</span>{([['all', '不限'], ['none', '无需参考图'], ['required', '需要参考图']] as const).map(([value, label]) => <Tag.CheckableTag key={value} checked={reference === value} className={cn("prompt-filter-tag", reference === value && "is-active")} onChange={() => setReference(value)}>{label}</Tag.CheckableTag>)}</div>
                        <span className="mr-1 text-xs font-semibold text-stone-500 dark:text-stone-400">{t("prompts.tags")}</span>
                        <Tag.CheckableTag checked={selectedTags.length === 0} className={cn("prompt-filter-tag", selectedTags.length === 0 && "is-active")} onChange={() => setSelectedTags([])}>{t("common.all")}</Tag.CheckableTag>
                        {promptTags.filter((tag) => tag !== ALL_PROMPTS_OPTION).map((tag) => <Tag.CheckableTag key={tag} checked={selectedTags.includes(tag)} className={cn("prompt-filter-tag", selectedTags.includes(tag) && "is-active")} onChange={() => toggleTag(tag)}>{tag}</Tag.CheckableTag>)}
                        {hasActiveFilters ? <Button type="text" size="small" icon={<X className="size-3.5" />} onClick={clearFilters}>{t("prompts.clearFilters")}</Button> : null}
                    </div> : null}

                    <div className="mt-6 flex items-center justify-between gap-3"><p className="text-sm text-stone-500 dark:text-stone-400">{t("prompts.total", { count: totalPrompts })}</p>{hasActiveFilters ? <Button type="text" size="small" onClick={clearFilters}>{t("prompts.clearFilters")}</Button> : null}</div>
                    {query.isLoading ? <div className="flex h-60 items-center justify-center"><Spin /></div> : null}
                    {!query.isLoading ? <div className="mt-4"><PromptGrid items={promptItems} onOpen={setSelectedPrompt} renderActions={(item) => <Tooltip title={t("common.addToAssets")}><Button type="text" size="small" icon={<FolderPlus className="size-3.5" />} aria-label={t("common.addToAssets")} onClick={() => savePromptAsset(item)} /></Tooltip>} onUse={startUsing} emptyText={t("prompts.empty")} /></div> : null}
                    <div className="mt-6 text-center text-xs text-stone-500 dark:text-stone-400">{query.isFetchingNextPage ? t("prompts.loading") : query.hasNextPage ? t("prompts.loadMore") : promptItems.length > 0 ? t("prompts.end") : null}</div>
                </div>
            </main>
            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={savePromptAsset} onUse={startUsing} />
        </div>
    );
}

function SceneButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
    return <button type="button" className={cn("shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors", active ? "border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:!text-stone-900" : "border-stone-200 bg-transparent text-stone-600 hover:border-stone-400 hover:text-stone-950 dark:border-stone-800 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-100")} onClick={onClick}>{children}</button>;
}

function PromptGrid({ items, onOpen, onUse, renderActions, emptyText }: { items: Prompt[]; onOpen: (item: Prompt) => void; onUse: (item: Prompt) => void; renderActions: (item: Prompt) => ReactNode; emptyText: string }) {
    return <div>{items.length > 0 ? <div className="columns-1 gap-4 sm:columns-2 xl:columns-4 2xl:columns-5">{items.map((item) => <div key={`${item.sourceId}:${item.id}`} className="mb-4 break-inside-avoid"><PromptCard item={item} onOpen={() => onOpen(item)} onCopy={() => onUse(item)} extraAction={renderActions(item)} /></div>)}</div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} className="py-16" />}</div>;
}
