import { ArrowUpRight, Copy, ExternalLink, FileText, FolderPlus, ImagePlus } from "lucide-react";
import { Button, Modal } from "antd";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { formatPromptDate, getPromptScenario, type Prompt } from "@/services/api/prompts";

export function PromptDetailDialog({ prompt, onClose, onCopy, onSaveAsset, onUse }: { prompt: Prompt | null; onClose: () => void; onCopy: (prompt: string) => void; onSaveAsset?: (prompt: Prompt) => void; onUse?: (prompt: Prompt) => void }) {
    const { i18n, t } = useTranslation();
    const scenario = prompt ? getPromptScenario(prompt) : "";
    const [imageFailed, setImageFailed] = useState(false);
    useEffect(() => setImageFailed(false), [prompt?.id]);

    return (
        <Modal title={null} open={Boolean(prompt)} onCancel={onClose} footer={null} width={980} centered styles={{ body: { padding: 0 } }}>
            {prompt ? <div className="grid max-h-[82vh] min-h-0 overflow-y-auto md:h-[82vh] md:max-h-[760px] md:grid-cols-[minmax(0,1.1fr)_minmax(320px,.9fr)] md:overflow-hidden">
                <div className="border-b border-stone-200 p-4 md:border-b-0 md:border-r md:p-6 dark:border-stone-800">
                    {prompt.featured ? <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">来源示例 · 生成效果随模型和输入素材变化</p> : null}
                    {prompt.coverUrl && !imageFailed ? <img src={prompt.coverUrl} alt={prompt.title} className="max-h-[68vh] w-full rounded-xl object-contain object-top" onError={() => setImageFailed(true)} /> : <div className="grid aspect-[4/3] w-full place-items-center rounded-xl bg-stone-100 text-stone-400 dark:bg-stone-900 dark:text-stone-600"><FileText className="size-9" /></div>}
                    {prompt.referenceImageUrls.length > 1 ? <div className="mt-3 grid grid-cols-6 gap-2">{prompt.referenceImageUrls.filter((url) => url !== prompt.coverUrl).slice(0, 6).map((url) => <img key={url} src={url} alt="" className="aspect-square w-full rounded-md object-cover" loading="lazy" />)}</div> : null}
                </div>
                <div className="flex min-h-0 flex-col p-5 md:h-full md:p-6">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-stone-500 dark:text-stone-400"><ImagePlus className="size-3.5" />{scenario}</div>
                    <h2 className="mt-2 text-xl font-semibold leading-7 text-stone-950 dark:text-stone-100">{prompt.title}</h2>
                    <div className="mt-5 min-h-0 flex-1 pr-1 md:overflow-y-auto">
                        <InfoBlock label={t("prompts.problem")} value={prompt.problem || prompt.description} />
                        <InfoBlock label={t("prompts.input")} value={prompt.inputHint || (prompt.requiresRef ? "需要参考图" : "无需额外素材")} />
                        <InfoBlock label={t("prompts.output")} value={prompt.output || prompt.preview} />
                        {prompt.featured ? <InfoBlock label="参考图要求" value={prompt.minReferenceImages ? `至少 ${prompt.minReferenceImages} 张，按输入说明排列；示例图是效果参考，请上传自己的素材。` : "可直接文字生图；保持真实商品或人物外观时可补充参考图。"} /> : null}
                        <InfoBlock label="来源 / 作者" value={[prompt.category, prompt.author].filter(Boolean).join(" · ")} />
                        {prompt.originalPrompt ? <details className="mb-4 text-sm"><summary className="cursor-pointer text-stone-500 dark:text-stone-400">查看来源原文：{prompt.originalTitle}</summary><p className="mt-2 whitespace-pre-wrap leading-6">{prompt.originalPrompt}</p></details> : null}
                        <div className="mt-5 rounded-xl bg-stone-50 p-4 dark:bg-stone-900/70"><div className="mb-2 text-xs font-semibold text-stone-500 dark:text-stone-400">{t("prompts.library")}</div><p className="whitespace-pre-wrap text-sm leading-6 text-stone-800 dark:text-stone-200">{prompt.prompt}</p></div>
                        {prompt.createdAt || prompt.updatedAt ? <div className="mt-4 text-xs text-stone-500 dark:text-stone-400">{prompt.createdAt ? t("common.created", { date: formatPromptDate(prompt.createdAt, i18n.resolvedLanguage) }) : null}{prompt.createdAt && prompt.updatedAt ? " · " : null}{prompt.updatedAt ? t("common.updated", { date: formatPromptDate(prompt.updatedAt, i18n.resolvedLanguage) }) : null}</div> : null}
                        {prompt.githubUrl ? <a href={prompt.githubUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100">{t("prompts.source")}<ExternalLink className="size-3" /></a> : null}
                    </div>
                    <div className="sticky bottom-0 z-10 mt-5 flex flex-wrap gap-2 border-t border-stone-200 bg-background py-4 md:pb-0 dark:border-stone-800">
                        {onUse ? <Button type="primary" icon={<ArrowUpRight className="size-4" />} onClick={() => onUse(prompt)}>{t("prompts.start")}</Button> : null}
                        <Button type={onUse ? "default" : "primary"} icon={<Copy className="size-4" />} onClick={() => onCopy(prompt.prompt)}>{t("common.copyPrompt")}</Button>
                        {onSaveAsset ? <Button icon={<FolderPlus className="size-4" />} onClick={() => onSaveAsset(prompt)}>{t("common.addToAssets")}</Button> : null}
                    </div>
                </div>
            </div> : null}
        </Modal>
    );
}

function InfoBlock({ label, value }: { label: string; value?: string }) {
    if (!value) return null;
    return <div className="mb-4"><div className="text-xs font-semibold text-stone-500 dark:text-stone-400">{label}</div><p className="mt-1 text-sm leading-6 text-stone-700 dark:text-stone-300">{value}</p></div>;
}
