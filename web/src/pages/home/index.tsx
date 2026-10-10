import { ArrowRight, Check, ChevronDown, Clapperboard, ImagePlus, Layers3, Maximize2, Sparkles, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "antd";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { PromptDetailDialog } from "@/pages/prompts/components/prompt-detail-dialog";
import { loadHomepagePrompts } from "@/services/api/prompt-editorial";
import type { Prompt } from "@/services/api/prompts";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { useCopyText } from "@/hooks/use-copy-text";
import { trackEvent } from "@/lib/analytics";
import { DOCS_URL } from "@/constant/env";
import { HomeCreationEntry } from "./creation-entry";
import { useHomeDraftStore, type HomeCreationKind } from "@/stores/use-home-draft-store";
import { VIDEO_SCRIPT_TEMPLATES } from "@/lib/video-script-templates";

const tasks = [
    { key: "product", icon: Layers3, href: "/cases/product-listing-set" },
    { key: "image", icon: ImagePlus, href: "/image" },
    { key: "video", icon: Clapperboard, href: "/video" },
    { key: "human", icon: UserRound, href: "/digital-human" },
];

export default function IndexPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const dispatchImage = useWorkbenchAgentStore((state) => state.dispatchImage);
    const showcaseRef = useRef<HTMLElement>(null);
    const [promptShowcase, setPromptShowcase] = useState<Prompt[]>([]);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    const [failedImages, setFailedImages] = useState<string[]>([]);
    const kind = useHomeDraftStore((state) => state.kind);
    const fillScript = (prompt: string, target: HomeCreationKind) => {
        const draft = useHomeDraftStore.getState();
        draft.setPrompt(target, prompt);
        if (target === "human") draft.setHumanCopySource("manual");
        trackEvent("home_script_use", { target });
        document.getElementById("home-creation")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
        document.getElementById("home-creation-prompt")?.focus({ preventScroll: true });
    };
    const scriptTemplates = kind === "video" ? VIDEO_SCRIPT_TEMPLATES : ["product", "knowledge", "store"].map((key) => ({ title: t(`home.entry.humanTemplates.${key}.title`), prompt: t(`home.entry.humanTemplates.${key}.prompt`) }));

    useEffect(() => {
        let active = true;
        setLoading(true);
        setLoadFailed(false);
        void loadHomepagePrompts()
            .then((items) => {
                if (active) setPromptShowcase(items);
            })
            .catch(() => { if (active) setLoadFailed(true); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [retry]);

    const openPage = (target: string, placement: string) => {
        trackEvent("home_cta_click", { placement, target });
        navigate(target);
    };
    const usePrompt = (item: Prompt) => {
        trackEvent("home_template_use", { target: item.id });
        dispatchImage({ prompt: item.prompt, run: false, templateInput: { title: item.title, inputHint: item.inputHint || "", minReferenceImages: item.minReferenceImages ?? (item.requiresRef ? 1 : 0) } });
        navigate("/image");
    };

    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto max-w-7xl px-4 sm:px-6">
                <section className="grid items-center gap-6 pb-10 pt-6 sm:gap-10 sm:pb-12 sm:pt-10 lg:grid-cols-[1fr_1.05fr] lg:gap-12 lg:py-12" aria-labelledby="home-title">
                    <div className="min-w-0">
                        <p className="inline-flex items-center gap-2 text-xs font-medium tracking-wide text-[#217a65] sm:text-sm dark:text-[#80d1b9]"><Sparkles className="size-4" />{t("home.eyebrow")}</p>
                        <h1 id="home-title" className="mt-3 text-balance text-[32px] font-semibold leading-[1.2] tracking-tight sm:text-[42px] lg:text-[46px]">
                            {t("home.titleLead")}<br /><span className="text-[#217a65] dark:text-[#80d1b9]">{t("home.titleEnd")}</span>
                        </h1>
                        <p className="mt-3 max-w-lg text-sm leading-6 text-stone-500 sm:text-base dark:text-stone-400">{t("home.entry.description")}</p>
                        <HomeCreationEntry />
                        <Button className="mt-2 !px-0" type="link" onClick={() => { trackEvent("home_cta_click", { placement: "hero", target: "showcase" }); showcaseRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); }} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">{t("home.viewCases")}</Button>
                    </div>
                    <figure className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                            <span className="text-xs font-medium sm:text-sm">{t("home.demo.title")}</span>
                            <span className="rounded-full bg-[#217a65]/10 px-2 py-1 text-[11px] text-[#217a65] dark:bg-[#80d1b9]/10 dark:text-[#80d1b9]">{t("home.demo.verified")}</span>
                        </div>
                        <img src="/examples/home/fusion-result.webp" width={960} height={640} alt={t("home.demo.resultAlt")} fetchPriority="high" className="aspect-[3/2] w-full object-contain" />
                        <figcaption className="px-4 py-3 sm:py-4">
                            <div className="flex items-center gap-3">
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <img src="/examples/home/fusion-subject.webp" width={320} height={320} alt={t("home.demo.subject")} className="size-11 rounded-md object-cover" />
                                    <span className="text-xs text-stone-500 dark:text-stone-400">{t("home.demo.subject")}</span>
                                </div>
                                <span className="text-stone-400" aria-hidden="true">+</span>
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <img src="/examples/home/fusion-reference.webp" width={240} height={320} alt={t("home.demo.reference")} className="h-11 w-9 rounded-md object-cover" />
                                    <span className="text-xs text-stone-500 dark:text-stone-400">{t("home.demo.reference")}</span>
                                </div>
                                <ArrowRight className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
                            </div>
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                                <p className="text-xs text-stone-500 dark:text-stone-400">{t("home.demo.note")}</p>
                                <Button type="link" size="small" onClick={() => openPage("/cases?case=official-fusion", "demo")} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">{t("home.demo.try")}</Button>
                            </div>
                        </figcaption>
                    </figure>
                </section>

                <section className="border-t border-border py-12 sm:py-16" aria-labelledby="home-tasks">
                    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
                        <div><h2 id="home-tasks" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("home.tasksTitle")}</h2><p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{t("home.tasksDescription")}</p></div>
                        <Button type="link" onClick={() => openPage("/create", "tasks")} icon={<ArrowRight className="size-4" />} iconPlacement="end">{t("home.allTools")}</Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {tasks.map(({ key, icon: Icon, href }) => <Link key={key} to={href} onClick={() => trackEvent("home_cta_click", { placement: "task", target: href })} className="group flex flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-[#217a65]/50 dark:hover:border-[#80d1b9]/50">
                            <Icon className="mb-5 size-6 text-[#217a65] dark:text-[#80d1b9]" />
                            <h3 className="text-base font-semibold">{t(`home.tasks.${key}.title`)}</h3>
                            <p className="mt-2 flex-1 text-sm leading-6 text-stone-500 dark:text-stone-400">{t(`home.tasks.${key}.description`)}</p>
                            <span className="mt-5 flex items-center gap-2 text-xs font-medium">{t(`home.tasks.${key}.action`)}<ArrowRight className="size-3.5 transition-transform motion-safe:group-hover:translate-x-1" /></span>
                        </Link>)}
                    </div>
                </section>

                <section ref={showcaseRef} className="scroll-mt-6 border-t border-border py-12 sm:py-16" aria-labelledby="home-showcase">
                    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
                        <div><h2 id="home-showcase" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t(kind === "image" ? "home.showcaseTitle" : `home.entry.${kind}.showcaseTitle`)}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">{t(kind === "image" ? "home.showcaseDescription" : `home.entry.${kind}.showcaseDescription`)}</p></div>
                        <Button type="link" onClick={() => openPage(kind === "image" ? "/prompts" : kind === "video" ? "/video" : "/digital-human", "showcase")} icon={<ArrowRight className="size-4" />} iconPlacement="end">{t(kind === "image" ? "home.viewPrompts" : `home.entry.${kind}.continue`)}</Button>
                    </div>
                    {kind !== "image" ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{scriptTemplates.map((item) => <article key={item.title} className="flex flex-col rounded-xl border border-border bg-card p-5"><div className="mb-4 flex items-center gap-2 text-xs text-[#217a65] dark:text-[#80d1b9]">{kind === "video" ? <Clapperboard className="size-4" /> : <UserRound className="size-4" />}{t("home.entry.scriptTemplate")}</div><h3 className="text-base font-semibold">{item.title}</h3><p className="mt-3 flex-1 text-sm leading-7 text-muted-foreground">{item.prompt}</p><div className="mt-5 border-t border-border pt-3"><Button onClick={() => fillScript(item.prompt, kind)} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">{t("home.entry.fillScript")}</Button></div></article>)}</div> : loading ? <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label={t("home.loading")}>{[0, 1, 2, 3, 4, 5].map((id) => <div key={id} className="h-80 animate-pulse rounded-xl bg-stone-100 motion-reduce:animate-none dark:bg-stone-900" />)}</div> : loadFailed || !promptShowcase.length ? <div className="rounded-xl border border-border px-5 py-10 text-center" role="status"><p className="mb-4 text-sm text-stone-500 dark:text-stone-400">{t("home.promptError")}</p><Button onClick={() => setRetry((value) => value + 1)}>{t("home.retry")}</Button></div> : <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {promptShowcase.map((item) => <article key={item.id} className="overflow-hidden rounded-xl border border-border bg-card">
                            <button type="button" onClick={() => { trackEvent("home_template_open", { target: item.id }); setSelectedPrompt(item); }} className="group block aspect-[4/3] w-full cursor-pointer overflow-hidden bg-stone-100 p-3 dark:bg-stone-900" aria-label={t("home.caseDetails", { title: item.title })}>
                                {failedImages.includes(item.id) ? <span className="flex h-full flex-col items-center justify-center gap-3 text-sm text-stone-500 dark:text-stone-400"><ImagePlus className="size-7" />{t("home.imageUnavailable")}</span> : <img src={item.coverUrl} alt={item.title} loading="lazy" decoding="async" className="h-full w-full object-contain transition-transform motion-safe:group-hover:scale-[1.02]" onError={() => setFailedImages((items) => [...items, item.id])} />}
                            </button>
                            <div className="p-4 sm:p-5">
                                <p className="text-[11px] text-stone-500 dark:text-stone-400">{t("home.sourceExample")}</p>
                                <h3 className="mt-2 text-base font-semibold">{item.title}</h3>
                                <p className="mt-2 min-h-10 text-xs leading-5 text-stone-500 dark:text-stone-400">{item.inputHint || t("home.noReference")}</p>
                                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                                    <Button type="text" size="small" onClick={() => { trackEvent("home_template_open", { target: item.id }); setSelectedPrompt(item); }}>{t("common.details")}</Button>
                                    <Button size="small" onClick={() => usePrompt(item)} icon={<ArrowRight className="size-3.5" />} iconPlacement="end">{t("home.useTemplate")}</Button>
                                </div>
                            </div>
                        </article>)}
                    </div>}
                </section>

                <section className="grid items-center gap-8 border-t border-border py-12 sm:py-16 lg:grid-cols-[.75fr_1.25fr] lg:gap-12" aria-labelledby="home-canvas">
                    <div>
                        <p className="flex items-center gap-2 text-xs font-medium text-[#217a65] dark:text-[#80d1b9]"><Maximize2 className="size-4" />{t("home.canvas.label")}</p>
                        <h2 id="home-canvas" className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">{t("home.canvas.title")}</h2>
                        <p className="mt-4 text-sm leading-7 text-stone-500 dark:text-stone-400">{t("home.canvas.description")}</p>
                        <ul className="my-6 space-y-3 text-sm">{["organize", "connect", "iterate"].map((key) => <li key={key} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-[#217a65] dark:text-[#80d1b9]" />{t(`home.canvas.${key}`)}</li>)}</ul>
                        <Button onClick={() => openPage("/canvas", "canvas")} icon={<ArrowRight className="size-4" />} iconPlacement="end">{t("home.openCanvas")}</Button>
                    </div>
                    <figure className="min-w-0">
                        <img src="/examples/home/canvas-light.webp" width={1120} height={720} loading="lazy" alt={t("home.canvas.previewAlt")} className="w-full rounded-xl border border-border dark:hidden" />
                        <img src="/examples/home/canvas-dark.webp" width={1120} height={720} loading="lazy" alt={t("home.canvas.previewAlt")} className="hidden w-full rounded-xl border border-border dark:block" />
                        <figcaption className="mt-3 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("home.canvas.caption")}</figcaption>
                    </figure>
                </section>

                <section className="border-t border-border py-12 sm:py-16" aria-labelledby="home-steps">
                    <h2 id="home-steps" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("home.stepsTitle")}</h2>
                    <ol className="mt-8 grid gap-6 sm:grid-cols-3">{["choose", "prepare", "generate"].map((key, index) => <li key={key} className="flex items-start gap-4"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-stone-100 text-xs font-medium dark:bg-stone-900">{index + 1}</span><div><h3 className="text-sm font-semibold">{t(`home.steps.${key}.title`)}</h3><p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{t(`home.steps.${key}.description`)}</p></div></li>)}</ol>
                </section>

                <section className="grid gap-6 border-t border-border py-12 sm:py-16 lg:grid-cols-[.75fr_1.25fr] lg:gap-12" aria-labelledby="home-faq">
                    <div><h2 id="home-faq" className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("home.faqTitle")}</h2><p className="mt-3 text-sm leading-7 text-stone-500 dark:text-stone-400">{t("home.faqDescription")}</p></div>
                    <div>{["cost", "materials", "setup", "storage"].map((key) => <details key={key} className="group border-b border-border py-4 first:pt-0"><summary style={{ display: "flex" }} className="cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium [&::-webkit-details-marker]:hidden">{t(`home.faq.${key}.question`)}<ChevronDown className="size-4 shrink-0 text-stone-400 transition-transform group-open:rotate-180" /></summary><p className="mt-3 text-sm leading-7 text-stone-500 dark:text-stone-400">{t(`home.faq.${key}.answer`)}</p></details>)}</div>
                </section>

                <section className="mb-12 flex flex-col items-start justify-between gap-5 rounded-2xl bg-stone-100 px-6 py-8 sm:flex-row sm:items-center sm:px-8 dark:bg-stone-900">
                    <div><h2 className="text-xl font-semibold sm:text-2xl">{t("home.closingTitle")}</h2><p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{t("home.closingDescription")}</p></div>
                    <Button type="primary" size="large" onClick={() => openPage("/image", "closing")} icon={<ArrowRight className="size-4" />} iconPlacement="end">{t("home.start")}</Button>
                </section>
                <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-6 text-xs text-stone-500 dark:text-stone-400">
                    <span>{t("meta.title")} · {t("home.footer")}</span>
                    <nav className="flex flex-wrap gap-5" aria-label={t("home.footerNavigation")}><Link to="/create">{t("home.allTools")}</Link><Link to="/prompts">{t("home.viewPrompts")}</Link><a href={DOCS_URL} target="_blank" rel="noreferrer">{t("home.docs")}</a><Link to="/config">{t("home.settings")}</Link></nav>
                </footer>
            </div>
            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onUse={usePrompt} />
        </main>
    );
}
