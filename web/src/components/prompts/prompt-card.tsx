import { ArrowUpRight, Copy, FileText, ImagePlus } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Card, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { formatPromptDate, getPromptScenario, type Prompt } from "@/services/api/prompts";

export function PromptCard({
    item,
    onOpen,
    onCopy,
    actionLabel,
    actionIcon = <ArrowUpRight className="size-3.5" />,
    actionType = "primary",
    extraAction,
    compact = false,
}: {
    item: Prompt;
    onOpen: () => void;
    onCopy: () => void;
    actionLabel?: string;
    actionIcon?: ReactNode;
    actionType?: "text" | "primary";
    extraAction?: ReactNode;
    compact?: boolean;
}) {
    const { i18n, t } = useTranslation();
    const scenario = getPromptScenario(item);
    const description = item.description || item.problem || t("prompts.noDescription");

    return (
        <Card
            hoverable
            className={compact ? "group cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-1" : "flex h-full flex-col overflow-hidden border-stone-200/80 shadow-none dark:border-stone-800"}
            styles={{ body: compact ? { padding: 0 } : { display: "flex", flex: 1, flexDirection: "column", padding: 0 } }}
            cover={
                <button type="button" className="block w-full cursor-pointer overflow-hidden text-left" onClick={onOpen}>
                    {item.coverUrl ? <img src={item.coverUrl} alt={item.title} className="block h-auto max-h-[22rem] min-h-32 w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" loading="lazy" /> : <span className="grid aspect-[4/3] w-full place-items-center bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600"><FileText className="size-8" /></span>}
                </button>
            }
        >
            <button type="button" className={compact ? "block w-full cursor-pointer text-left" : "block w-full flex-1 cursor-pointer text-left"} onClick={onOpen}>
                <div className={compact ? "px-3 py-2.5" : "p-4"}>
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-stone-500 dark:text-stone-400"><ImagePlus className="size-3" />{scenario}</div>
                            <h2 className="line-clamp-2 text-sm font-semibold leading-5 text-stone-950 dark:text-stone-100">{item.title}</h2>
                        </div>
                        {!compact ? <span className="shrink-0 text-xs text-stone-400 dark:text-stone-500">{formatPromptDate(item.updatedAt, i18n.resolvedLanguage)}</span> : null}
                    </div>
                    {!compact ? <>
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-stone-600 dark:text-stone-400">{description}</p>
                        {item.output ? <p className="mt-2 line-clamp-1 text-xs text-stone-500 dark:text-stone-400"><span className="font-medium text-stone-700 dark:text-stone-300">{t("prompts.output")}：</span>{item.output}</p> : null}
                        <div className="mt-3 flex flex-wrap gap-1.5">{item.tags.slice(0, 3).map((tag) => <Tag key={tag} className="m-0 text-[11px]">{tag}</Tag>)}</div>
                    </> : null}
                </div>
            </button>
            {!compact ? <div className="mt-auto flex items-center gap-2 px-4 pb-4"><Button block type={actionType} size="small" icon={actionIcon} onClick={onCopy}>{actionLabel || t("prompts.start")}</Button>{extraAction || <Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={onCopy} aria-label={t("common.copyPrompt")} />}</div> : null}
        </Card>
    );
}
