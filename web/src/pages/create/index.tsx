import { useEffect, useMemo, useState } from "react";
import { ArrowRight, ImagePlus, Layers3, Maximize2, Menu, Moon, Play, Search, Sun, Video } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { UserStatusActions } from "@/components/layout/user-status-actions";
import { CreateMenu } from "@/components/layout/create-menu";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { baseItems, officialCaseItems, productSetItem, type CatalogItem } from "@/constant/create-catalog";
import { fetchCases, type CaseApp } from "@/services/api/cases";
import { useThemeStore } from "@/stores/use-theme-store";

type Medium = "all" | "image" | "video" | "canvas";
type Source = "all" | "official" | "creator";
function caseMedium(item: CaseApp): "image" | "video" {
    return /视频/.test([item.category, ...item.tags].join(" ")) ? "video" : "image";
}

function WorkbenchVisual({ medium }: { medium: "image" | "video" | "canvas" }) {
    if (medium === "image") {
        const examples = [
            { src: "/examples/workbench/product.jpg", label: "商品" },
            { src: "/examples/workbench/portrait.jpg", label: "人像" },
            { src: "/examples/workbench/illustration.jpg", label: "插画" },
        ];
        return (
            <div className="relative grid h-44 min-w-0 grid-cols-3 gap-1 bg-[#dce8e3] p-1 sm:h-52 md:h-[236px] dark:bg-[#244137]" aria-label="商品、人像和插画视觉灵感示例">
                {examples.map(({ src, label }) => (
                    <div key={src} className="relative min-w-0 overflow-hidden">
                        <img src={src} alt="" className="size-full object-cover" />
                        <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">{label}</span>
                    </div>
                ))}
                <span className="absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-[10px] text-white">视觉灵感示例</span>
            </div>
        );
    }

    if (medium === "video") {
        return (
            <div className="relative h-44 min-w-0 overflow-hidden bg-[#1b2426] sm:h-52 md:h-[236px]" aria-label="视频创作界面示意，画面为静态素材">
                <img src="/examples/workbench/video-still.jpg" alt="" className="size-full object-cover object-[center_40%]" />
                <div className="absolute inset-0 bg-black/20" />
                <span className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-[10px] text-white">视频创作示意 · 静帧</span>
                <span className="absolute left-1/2 top-[43%] flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-black/35 text-white shadow-lg">
                    <Play className="ml-0.5 size-5 fill-current" />
                </span>
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/65 to-transparent px-4 pb-3 pt-8">
                    <div className="mb-2 flex items-center justify-between text-[10px] font-medium text-white/90">
                        <span>分镜预览</span>
                        <span>00:08</span>
                    </div>
                    <div className="flex h-7 gap-1.5">
                        {["30%", "45%", "58%", "70%"].map((position, index) => (
                            <div key={position} className={`h-full flex-1 overflow-hidden rounded-sm border ${index === 1 ? "border-[#9ce2c8]" : "border-white/40"}`}>
                                <img src="/examples/workbench/video-still.jpg" alt="" className="size-full object-cover" style={{ objectPosition: `center ${position}` }} />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="relative h-44 min-w-0 overflow-hidden bg-[#e9f0ed] sm:h-52 md:h-[236px] dark:bg-[#1a2a29]" aria-label="画布流程示意：从创意输入连接到图片和视频生成">
            <div className="absolute inset-0 opacity-35 dark:opacity-25" style={{ backgroundImage: "radial-gradient(#78958a 1px, transparent 1px)", backgroundSize: "18px 18px" }} />
            <span className="absolute left-3 top-3 rounded bg-white/90 px-2 py-1 text-[10px] text-[#53645c] shadow-sm dark:bg-[#263936] dark:text-stone-300">画布流程示意</span>
            <div className="absolute left-[38%] right-[35%] top-1/2 border-t-2 border-[#70a993]" />
            <div className="absolute bottom-[29%] left-[65%] top-[29%] border-l-2 border-[#70a993]" />
            <div className="absolute left-[65%] right-[26%] top-[29%] border-t-2 border-[#70a993]" />
            <div className="absolute left-[65%] right-[26%] bottom-[29%] border-t-2 border-[#70a993]" />
            <div className="absolute left-[6%] top-1/2 flex w-[32%] -translate-y-1/2 items-center gap-2 rounded border border-[#bdd2c9] bg-white p-2 shadow-sm sm:p-3 dark:border-[#3b6255] dark:bg-[#263936]">
                <span className="flex size-8 shrink-0 items-center justify-center rounded bg-[#e2f2ed] text-[#176854] dark:bg-[#17483b] dark:text-[#a3e2cc]">
                    <Layers3 className="size-4" />
                </span>
                <span className="min-w-0 text-[11px] font-medium sm:text-xs">创意输入</span>
            </div>
            <div className="absolute right-[5%] top-[29%] flex w-[30%] -translate-y-1/2 items-center gap-2 rounded border border-[#bdd2c9] bg-white p-2 shadow-sm sm:p-3 dark:border-[#3b6255] dark:bg-[#263936]">
                <span className="flex size-8 shrink-0 items-center justify-center rounded bg-[#e8edf9] text-[#425dab] dark:bg-[#303b55] dark:text-[#b7c9fa]">
                    <ImagePlus className="size-4" />
                </span>
                <span className="min-w-0 text-[11px] font-medium sm:text-xs">图片生成</span>
            </div>
            <div className="absolute right-[5%] bottom-[29%] flex w-[30%] translate-y-1/2 items-center gap-2 rounded border border-[#bdd2c9] bg-white p-2 shadow-sm sm:p-3 dark:border-[#3b6255] dark:bg-[#263936]">
                <span className="flex size-8 shrink-0 items-center justify-center rounded bg-[#f7e9dc] text-[#a56535] dark:bg-[#513c2e] dark:text-[#f0c8a4]">
                    <Video className="size-4" />
                </span>
                <span className="min-w-0 text-[11px] font-medium sm:text-xs">视频生成</span>
            </div>
        </div>
    );
}

export default function CreatePage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const mediumParam = searchParams.get("medium");
    const sourceParam = searchParams.get("source");
    const medium: Medium = mediumParam === "image" || mediumParam === "video" || mediumParam === "canvas" ? mediumParam : "all";
    const source: Source = sourceParam === "official" || sourceParam === "creator" ? sourceParam : "all";
    const [query, setQuery] = useState("");
    const [cases, setCases] = useState<CaseApp[]>([]);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);

    useEffect(() => {
        let active = true;
        void fetchCases({ pageSize: 60 })
            .then((result) => {
                if (active) setCases(result.items);
            })
            .catch(() => {
                if (active) setCases([]);
            });
        return () => {
            active = false;
        };
    }, []);

    const items = useMemo<CatalogItem[]>(
        () => [
            productSetItem,
            ...cases
                .filter((item) => item.id !== "official-product-grid")
                .map((item) => ({
                    id: item.id,
                    title: item.title,
                    description: item.description || "填写公开参数，即可使用已封装的创作方案。",
                    category: item.category || "创作案例",
                    medium: item.isOfficial ? caseMedium(item) : ("canvas" as const),
                    source: item.isOfficial ? ("official" as const) : ("creator" as const),
                    price: item.priceCredits ? `${item.priceCredits} 算力点服务费，模型费另计` : "按后台模型算力点报价",
                    href: item.id === "official-image-variations" ? "/cases/image-variations" : `/cases?case=${encodeURIComponent(item.id)}`,
                    icon: officialCaseItems.find((tool) => tool.id === item.id)?.icon || (item.isOfficial ? Layers3 : Maximize2),
                    cover: officialCaseItems.some((tool) => tool.id === item.id) ? undefined : item.coverUrl || undefined,
                })),
        ],
        [cases],
    );

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = (item: CatalogItem) =>
        (medium === "all" || item.medium === medium) && (source === "all" || item.source === source) && (!normalizedQuery || `${item.title} ${item.description} ${item.category}`.toLocaleLowerCase().includes(normalizedQuery));
    const quickItems = baseItems.filter(matches);
    const visibleItems = items.filter(matches);
    const updateFilter = (key: "medium" | "source", value: Medium | Source) => {
        setSearchParams(
            (current) => {
                const next = new URLSearchParams(current);
                if (value === "all") next.delete(key);
                else next.set(key, value);
                return next;
            },
            { replace: true },
        );
    };

    return (
        <div className="h-full overflow-y-auto bg-[#f7f8fa] text-[#182025] dark:bg-[#111718] dark:text-stone-100">
            <header className="sticky top-0 z-20 border-b border-[#e5e9eb] bg-white/95 backdrop-blur dark:border-stone-800 dark:bg-[#181d1e]/95">
                <div className="mx-auto flex h-16 max-w-[1320px] items-center justify-between gap-2 px-4 sm:gap-4 sm:px-8">
                    <div className="flex min-w-0 items-center gap-4 sm:gap-7">
                        <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold text-inherit">
                            <span className="size-6 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                            <span className="hidden sm:inline">灵图画布</span>
                        </Link>
                        <nav className="flex h-16 shrink-0 items-stretch gap-3 text-sm sm:gap-7" aria-label="主导航">
                            <CreateMenu />
                            <Link to="/assets" className="hidden shrink-0 items-center whitespace-nowrap text-[#65737a] hover:text-[#182025] sm:flex dark:text-stone-400 dark:hover:text-white">
                                我的资产
                            </Link>
                            <Link to="/prompts" className="hidden items-center whitespace-nowrap text-[#65737a] hover:text-[#182025] lg:flex dark:text-stone-400 dark:hover:text-white">
                                提示词库
                            </Link>
                        </nav>
                    </div>
                    <div className="hidden shrink-0 lg:block">
                        <UserStatusActions showGitHub={false} />
                    </div>
                    <div className="flex shrink-0 items-center gap-1 lg:hidden">
                        <button type="button" title="打开导航菜单" aria-label="打开导航菜单" onClick={() => setMobileNavOpen(true)} className="flex size-8 items-center justify-center text-[#65737a] dark:text-stone-300">
                            <Menu className="size-4" />
                        </button>
                        <button
                            type="button"
                            title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                            aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
                            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                            className="flex size-8 items-center justify-center text-[#65737a] dark:text-stone-300"
                        >
                            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                        </button>
                        <UserStatusActions accountOnly />
                    </div>
                </div>
            </header>
            <MobileNavDrawer open={mobileNavOpen} pathname="/create" onClose={() => setMobileNavOpen(false)} />

            <main className="mx-auto max-w-[1320px] px-5 pb-16 pt-8 sm:px-8 sm:pt-10">
                <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
                    <div>
                        <h1 className="text-[28px] font-semibold leading-tight sm:text-[32px]">创作</h1>
                        <p className="mt-2 text-sm text-[#69767c] dark:text-stone-400">选择创作任务，直接开始制作</p>
                    </div>
                    <label className="flex h-11 w-full items-center gap-2 rounded-md border border-[#dce3e5] bg-white px-3 text-[#748088] focus-within:border-[#217a65] md:w-72 dark:border-stone-700 dark:bg-[#1c2324]">
                        <Search className="size-4 shrink-0" />
                        <input
                            aria-label="搜索工具与案例"
                            placeholder="搜索工具与案例"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            className="min-w-0 flex-1 bg-transparent text-sm text-[#182025] outline-none placeholder:text-[#879299] dark:text-stone-100"
                        />
                    </label>
                </div>

                <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-b border-[#e1e6e8] dark:border-stone-800">
                    <div className="flex gap-7" role="tablist" aria-label="创作类型">
                        {(
                            [
                                ["all", "全部"],
                                ["image", "图片"],
                                ["video", "视频"],
                                ["canvas", "画布"],
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                role="tab"
                                aria-selected={medium === value}
                                type="button"
                                onClick={() => updateFilter("medium", value)}
                                className={`h-11 border-b-2 px-1 text-sm transition ${medium === value ? "border-[#217a65] font-semibold text-[#176854] dark:text-[#80d1b9]" : "border-transparent text-[#6b777d] hover:text-[#182025] dark:text-stone-400 dark:hover:text-white"}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-2 pb-3" aria-label="案例来源">
                        {(
                            [
                                ["all", "全部来源"],
                                ["official", "平台出品"],
                                ["creator", "创作者"],
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={source === value}
                                onClick={() => updateFilter("source", value)}
                                className={`rounded-md px-3 py-1.5 text-xs transition ${source === value ? "bg-[#e2f2ed] font-medium text-[#176854] dark:bg-[#17483b] dark:text-[#a3e2cc]" : "text-[#6b777d] hover:bg-[#e9edef] dark:text-stone-400 dark:hover:bg-stone-800"}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>

                {quickItems.length ? (
                    <section className="mt-8" aria-labelledby="quick-start-title">
                        <h2 id="quick-start-title" className="mb-4 text-lg font-semibold">
                            快速开始
                        </h2>
                        <div className={`grid gap-3 ${medium === "all" ? "md:grid-cols-3" : ""}`}>
                            {quickItems.map((item) => {
                                const Icon = item.icon;
                                if (medium !== "all") {
                                    return (
                                        <Link
                                            key={item.id}
                                            to={item.href}
                                            className="group grid overflow-hidden rounded-md border border-[#d6e4df] bg-white transition hover:border-[#80b5a5] hover:shadow-sm md:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.15fr)] dark:border-[#345148] dark:bg-[#1c2324] dark:hover:border-[#70a993]"
                                        >
                                            <div className="flex flex-col justify-center p-5 sm:p-7">
                                                <span className="text-xs font-medium text-[#217a65] dark:text-[#a3e2cc]">{{ image: "图片创作", video: "视频创作", canvas: "画布创作" }[item.medium]} · 自由创作</span>
                                                <h3 className="mt-3 text-[23px] font-semibold leading-tight">{item.title}</h3>
                                                <p className="mt-2 max-w-md text-sm leading-6 text-[#68767c] dark:text-stone-400">{item.description}</p>
                                                <span className="mt-3 text-xs text-[#879299] dark:text-stone-400">{item.price}</span>
                                                <span className="mt-5 inline-flex h-9 w-fit items-center gap-2 rounded-md bg-[#176854] px-4 text-sm font-medium text-white transition group-hover:bg-[#125440]">
                                                    进入工作台 <ArrowRight className="size-4" />
                                                </span>
                                            </div>
                                            <WorkbenchVisual medium={item.medium} />
                                        </Link>
                                    );
                                }
                                return (
                                    <Link
                                        key={item.id}
                                        to={item.href}
                                        className="group grid min-h-[142px] grid-cols-[40px_minmax(0,1fr)_16px] content-start gap-x-4 rounded-md border border-[#d6e4df] bg-white p-5 transition hover:border-[#80b5a5] hover:shadow-sm dark:border-[#345148] dark:bg-[#1c2324] dark:hover:border-[#70a993]"
                                    >
                                        <span className="flex size-10 items-center justify-center rounded-md bg-[#e2f2ed] text-[#176854] dark:bg-[#244137] dark:text-[#a3e2cc]">
                                            <Icon className="size-5" />
                                        </span>
                                        <div className="min-w-0">
                                            <h3 className="text-base font-semibold group-hover:text-[#176854] dark:group-hover:text-[#a3e2cc]">{item.title}</h3>
                                            <p className="mt-1 text-[13px] leading-5 text-[#68767c] dark:text-stone-400">{item.description}</p>
                                        </div>
                                        <ArrowRight className="mt-1 size-4 text-[#879299]" />
                                        <span className="col-start-2 col-end-4 mt-4 text-xs text-[#879299] dark:text-stone-400">{item.price}</span>
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                ) : null}

                <section className="mt-9" aria-labelledby="catalog-title">
                    <div className="mb-4 flex items-baseline justify-between gap-3">
                        <h2 id="catalog-title" className="text-lg font-semibold">
                            {medium === "canvas" ? "已上架画布" : "场景工具与案例"}
                        </h2>
                        <span className="text-xs text-[#849097]">{visibleItems.length} 项</span>
                    </div>
                    {visibleItems.length ? (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {visibleItems.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <Link
                                        key={item.id}
                                        to={item.href}
                                        className="group grid min-h-[112px] grid-cols-[72px_minmax(0,1fr)_16px] gap-3 rounded-md border border-[#e1e6e8] bg-white p-3 transition hover:border-[#80b5a5] hover:shadow-sm dark:border-stone-700 dark:bg-[#1c2324] dark:hover:border-[#54947e]"
                                    >
                                        <div className="size-[72px] overflow-hidden rounded bg-[#e8f1ed] dark:bg-[#244137]">
                                            {item.cover ? (
                                                <img src={item.cover} alt="" className="size-full object-cover" />
                                            ) : (
                                                <span className="flex size-full items-center justify-center text-[#217a65] dark:text-[#a3e2cc]">
                                                    <Icon className="size-6" />
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex min-w-0 flex-col">
                                            <div className="flex min-w-0 items-center justify-between gap-2">
                                                <h3 className="min-w-0 truncate text-sm font-semibold group-hover:text-[#176854] dark:group-hover:text-[#a3e2cc]">{item.title}</h3>
                                                <span className="shrink-0 text-[11px] text-[#879299] dark:text-stone-400">{item.source === "official" ? "平台" : "创作者"}</span>
                                            </div>
                                            <p className="mt-1 line-clamp-2 text-xs leading-[18px] text-[#68767c] dark:text-stone-400">{item.description}</p>
                                            <span className="mt-auto pt-2 text-[11px] text-[#879299] dark:text-stone-400">{item.price}</span>
                                        </div>
                                        <ArrowRight className="mt-0.5 size-4 text-[#9aa5aa]" />
                                    </Link>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="rounded-md border border-dashed border-[#d7e0e2] py-12 text-center text-sm text-[#738087] dark:border-stone-700 dark:text-stone-400">
                            {medium === "canvas" && !normalizedQuery ? "暂无已上架的创作者画布" : "没有符合条件的工具或案例"}
                        </div>
                    )}
                </section>
            </main>
        </div>
    );
}
