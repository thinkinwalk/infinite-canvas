import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { App, Empty, Input, Modal, Spin } from "antd";
import { ArrowLeft, Check, ClipboardPaste, Download, FolderOpen, History, ImagePlus, LoaderCircle, Minus, Pencil, Plus, RefreshCw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { saveAs } from "file-saver";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import {
    analyzeProductSet,
    fetchCaseRuns,
    fetchProductSetImagePrice,
    fetchProductSetConfig,
    fetchProductSetPlanPrice,
    parseProductSet,
    planProductSet,
    recommendProductSetStyle,
    streamProductSet,
    type CaseRun,
    type ProductSetCard,
    type ProductSetConfig,
    type ProductSetInput,
    type ProductSetRunResult,
    type ProductSetStyle,
} from "@/services/api/cases";
import { fetchImageBlob } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { createProductSetZip, findImageURL, productSetDownloads } from "./product-set-download";
import "./product-set-workspace.css";

const CASE_ID = "official-product-grid";
const MAX_IMAGES = 6;
const MAX_REFERENCE_IMAGES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

type LocalImage = { id: string; name: string; src: string; dataUrl: string };
type WorkspaceMode = "example" | "history" | "preview";

const fallbackConfig: ProductSetConfig = {
    entry: { title: "商品套图", description: "上传商品图，生成适配电商平台的商品套图方案和结果。" },
    platforms: [
        { label: "淘宝", value: "淘宝", isDefault: true, marketValues: ["中国"] },
        { label: "抖音", value: "抖音", marketValues: ["中国"] },
        { label: "小红书", value: "小红书", marketValues: ["中国"] },
        { label: "TikTok Shop", value: "TikTok Shop", marketValues: ["us", "eu", "sea", "日本", "韩国", "南非", "新加坡"] },
        { label: "Amazon", value: "Amazon", marketValues: ["us", "eu", "sea", "日本", "韩国", "南非", "新加坡"] },
        { label: "Temu", value: "Temu", marketValues: ["us", "eu", "sea", "日本", "韩国", "南非", "新加坡"] },
        { label: "拼多多", value: "拼多多", marketValues: ["中国"] },
        { label: "京东", value: "京东", marketValues: ["中国"] },
        { label: "阿里国际站", value: "阿里国际站", marketValues: ["新加坡", "南非", "韩国", "日本", "sea", "eu", "us"] },
        { label: "OZON", value: "OZON", marketValues: ["俄罗斯"] },
        { label: "阿里巴巴", value: "阿里巴巴" },
    ],
    markets: [
        { label: "中国", value: "中国", isDefault: true },
        { label: "美国", value: "us" },
        { label: "欧洲", value: "eu" },
        { label: "东南亚", value: "sea" },
        { label: "日本", value: "日本" },
        { label: "韩国", value: "韩国" },
        { label: "南非", value: "南非" },
        { label: "新加坡", value: "新加坡" },
        { label: "俄罗斯", value: "俄罗斯" },
    ],
    languages: [
        { label: "English", value: "en" },
        { label: "简体中文", value: "zh-CN", isDefault: true },
        { label: "日本語", value: "ja" },
        { label: "繁体中文", value: "繁体中文" },
        { label: "无文字", value: "无文字" },
    ],
    examples: [
        { title: "01 白底主图", src: "/examples/product-set/01-main.png" },
        { title: "02 品牌主视觉海报", src: "/examples/product-set/02-hero.png" },
        { title: "03 核心卖点海报", src: "/examples/product-set/03-selling-points.png" },
        { title: "04 材质与结构说明图", src: "/examples/product-set/04-structure.png" },
        { title: "05 工艺细节图", src: "/examples/product-set/05-details.png" },
        { title: "06 品质展示图", src: "/examples/product-set/06-quality.png" },
        { title: "07 真实使用场景图", src: "/examples/product-set/07-lifestyle.png" },
        { title: "08 收官价值视觉图", src: "/examples/product-set/08-gift.png" },
    ],
    styles: [
        { id: "clean-commerce", title: "干净高级电商", description: "明亮留白、柔和光线、突出商品材质和轮廓。" },
        { id: "warm-lifestyle", title: "温暖生活方式", description: "自然光和真实使用场景，适合生活方式类商品。" },
        { id: "premium-editorial", title: "高端品牌画册", description: "克制构图、质感光影和品牌化视觉语言。" },
    ],
    targetImageCounts: [7, 8],
};

const stylePalettes = ["from-[#f5d36b] via-[#172d4d] to-[#f6f6f6]", "from-[#d7bd94] via-[#faf9f3] to-[#7b8e62]", "from-[#161616] via-[#8e7966] to-[#ded2c6]", "from-[#d9e1e8] via-[#f5f5f5] to-[#7c9bb7]"];

function readImage(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });
}

function imageFromPayload(payload: InsertAssetPayload): LocalImage | null {
    if (payload.kind !== "image") return null;
    return { id: `asset-${Date.now()}-${Math.random()}`, name: payload.title, src: payload.dataUrl, dataUrl: payload.dataUrl };
}

function formatDate(value: string) {
    if (!value) return "刚刚";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function platformsForMarket(platforms: ProductSetConfig["platforms"], market: string) {
    return platforms.filter((item) => !item.marketValues?.length || item.marketValues.includes(market));
}

function defaultPlatform(platforms: ProductSetConfig["platforms"]) {
    return platforms.find((item) => item.isDefault)?.value || platforms[0]?.value || "";
}

function historyResults(run: CaseRun): ProductSetRunResult["items"] {
    try {
        const value: unknown = JSON.parse(run.responseBody || "[]");
        return Array.isArray(value) ? value.filter((item) => item && typeof item === "object" && typeof item.cardId === "string") : [];
    } catch {
        return [];
    }
}

export default function ProductSetWorkspacePage() {
    const { message, modal } = App.useApp();
    const token = useUserStore((state) => state.token);
    const productInput = useRef<HTMLInputElement>(null);
    const referenceInput = useRef<HTMLInputElement>(null);
    const [config, setConfig] = useState<ProductSetConfig>(fallbackConfig);
    const [configLoading, setConfigLoading] = useState(true);
    const [images, setImages] = useState<LocalImage[]>([]);
    const [references, setReferences] = useState<LocalImage[]>([]);
    const [market, setMarket] = useState("中国");
    const [platform, setPlatform] = useState("淘宝");
    const [language, setLanguage] = useState("zh-CN");
    const [productBrief, setProductBrief] = useState("");
    const [styleMode, setStyleMode] = useState<ProductSetInput["styleMode"]>("ai");
    const [styleText, setStyleText] = useState("");
    const [customStyleText, setCustomStyleText] = useState("");
    const [layoutMode, setLayoutMode] = useState<ProductSetInput["layoutMode"]>("default");
    const [layoutCounts, setLayoutCounts] = useState({ whiteBackground: 1, scene: 3, sellingPoint: 3, other: 0 });
    const [targetImageCount, setTargetImageCount] = useState(8);
    const [cards, setCards] = useState<ProductSetCard[]>([]);
    const [planInput, setPlanInput] = useState<ProductSetInput | null>(null);
    const [selectedCards, setSelectedCards] = useState<string[]>([]);
    const [styles, setStyles] = useState<ProductSetStyle[]>([]);
    const [results, setResults] = useState<ProductSetRunResult["items"]>([]);
    const [history, setHistory] = useState<CaseRun[]>([]);
    const [mode, setMode] = useState<WorkspaceMode>("example");
    const returnMode = useRef<"example" | "preview">("example");
    const [assetPickerTarget, setAssetPickerTarget] = useState<"product" | "reference" | null>(null);
    const [dragTarget, setDragTarget] = useState<"product" | "reference" | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [parsingAll, setParsingAll] = useState(false);
    const [recommending, setRecommending] = useState(false);
    const [planning, setPlanning] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [runProgress, setRunProgress] = useState<{ completed: number; total: number } | null>(null);
    const [retrying, setRetrying] = useState<string | null>(null);
    const [previewImage, setPreviewImage] = useState<string | null>(null);
    const [editingCard, setEditingCard] = useState<Pick<ProductSetCard, "id" | "title" | "description"> | null>(null);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
    const [imagePrice, setImagePrice] = useState<number | null>(null);
    const [quoting, setQuoting] = useState(false);

    const customImageCount = Object.values(layoutCounts).reduce((sum, value) => sum + value, 0);
    const effectiveTargetImageCount = layoutMode === "custom" ? Math.max(7, Math.min(16, customImageCount)) : targetImageCount;
    const input = useMemo<ProductSetInput>(
        () => ({
            images: images.map((item) => item.dataUrl),
            platform,
            market,
            language,
            productBrief,
            styleMode,
            styleText: styleMode === "custom" ? customStyleText : styleMode === "ai" ? styleText : "",
            styleReferenceImages: references.map((item) => item.dataUrl),
            layoutMode,
            customLayout: layoutMode === "custom" ? JSON.stringify(layoutCounts) : undefined,
            targetImageCount: effectiveTargetImageCount,
            cardIds: selectedCards,
        }),
        [images, references, platform, market, language, productBrief, styleMode, styleText, customStyleText, layoutMode, layoutCounts, targetImageCount, effectiveTargetImageCount, selectedCards],
    );

    const platformOptions = useMemo(() => platformsForMarket(config.platforms, market), [config.platforms, market]);
    const planOutdated =
        planInput !== null &&
        Object.entries(planInput).some(([key, value]) => {
            if (key === "cardIds") return false;
            const current = input[key as keyof ProductSetInput];
            return Array.isArray(value) ? !Array.isArray(current) || value.length !== current.length || value.some((item, index) => item !== current[index]) : value !== current;
        });

    useEffect(() => {
        let active = true;
        void fetchProductSetConfig(CASE_ID)
            .then((data) => {
                if (!active) return;
                const defaultMarket = data.markets.find((item) => item.isDefault)?.value || data.markets[0]?.value || "";
                setConfig({ ...data, examples: fallbackConfig.examples });
                setMarket(defaultMarket);
                setPlatform(defaultPlatform(platformsForMarket(data.platforms, defaultMarket)));
                setLanguage(data.languages.find((item) => item.isDefault)?.value || data.languages[0]?.value || "zh-CN");
                setTargetImageCount(data.targetImageCounts.includes(8) ? 8 : data.targetImageCounts[0] || 8);
            })
            .catch(() => message.warning("商品套图配置加载失败，已使用默认配置"))
            .finally(() => {
                if (active) setConfigLoading(false);
            });
        return () => {
            active = false;
        };
    }, [message]);

    useEffect(() => {
        if (!token) return;
        void fetchCaseRuns(token, { page: 1, pageSize: 40 })
            .then((data) => setHistory(data.items.filter((item) => item.caseId === CASE_ID)))
            .catch(() => undefined);
    }, [token, mode]);

    useEffect(() => {
        if (!token || mode !== "preview" || !planInput) {
            setImagePrice(null);
            return;
        }
        let active = true;
        setImagePrice(null);
        void fetchProductSetImagePrice(token, CASE_ID)
            .then((quote) => {
                if (active) setImagePrice(quote.pointsPerImage);
            })
            .catch(() => {
                if (active) message.error("图片算力点报价获取失败，请点击生成时重新核价");
            });
        return () => {
            active = false;
        };
    }, [token, mode, planInput, message]);

    const appendFiles = async (files: FileList | File[], target: "product" | "reference") => {
        const current = target === "product" ? images : references;
        const limit = target === "product" ? MAX_IMAGES : MAX_REFERENCE_IMAGES;
        const next: LocalImage[] = [];
        for (const file of Array.from(files).slice(0, limit - current.length)) {
            if (!/^image\/(jpeg|png)$/i.test(file.type)) {
                message.warning("图片请使用 JPG 或 PNG 格式");
                continue;
            }
            if (file.size > MAX_FILE_BYTES) {
                message.warning(`${file.name} 超过 10MB，未添加`);
                continue;
            }
            try {
                const dataUrl = await readImage(file);
                next.push({ id: `${file.name}-${file.lastModified}-${Math.random()}`, name: file.name, src: dataUrl, dataUrl });
            } catch (error) {
                message.error(error instanceof Error ? error.message : "图片读取失败");
            }
        }
        if (target === "product") setImages((currentValue) => [...currentValue, ...next].slice(0, MAX_IMAGES));
        else setReferences((currentValue) => [...currentValue, ...next].slice(0, MAX_REFERENCE_IMAGES));
    };

    const handleDrag = (event: DragEvent<HTMLDivElement>, target: "product" | "reference", active: boolean) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (active && event.dataTransfer.types.includes("Files")) setDragTarget(target);
        if (!active && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        if (!active) setDragTarget(null);
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>, target: "product" | "reference") => {
        event.preventDefault();
        setDragTarget(null);
        void appendFiles(event.dataTransfer.files, target);
    };

    const addClipboardFiles = async (target: "product" | "reference") => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) throw new Error("剪切板里没有可读取的图片");
            await appendFiles(blobs.map((blob, index) => new File([blob], `clipboard-${index + 1}.png`, { type: blob.type || "image/png" })), target);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "剪切板读取失败");
        }
    };

    const addPickedAsset = (payload: InsertAssetPayload) => {
        const image = imageFromPayload(payload);
        if (!image) {
            message.warning("这里只支持选择图片资产");
            return;
        }
        if (assetPickerTarget === "reference") setReferences((current) => [...current, image].slice(0, MAX_REFERENCE_IMAGES));
        else setImages((current) => [...current, image].slice(0, MAX_IMAGES));
        setAssetPickerTarget(null);
    };

    const ensureReady = (requireBrief = true) => {
        if (!token) {
            message.warning("请先登录后使用商品套图");
            return false;
        }
        if (!images.length) {
            message.warning("请至少上传 1 张商品图片");
            return false;
        }
        if (!platform || !market || !language) {
            message.warning("请选择目标平台、市场和语言");
            return false;
        }
        if (requireBrief && !productBrief.trim()) {
            message.warning("请先输入或生成产品卖点");
            return false;
        }
        return true;
    };

    const analyze = async () => {
        if (!ensureReady(false)) return;
        setAnalyzing(true);
        try {
            const data = await analyzeProductSet(token!, CASE_ID, input);
            setProductBrief(data.productBrief);
            message.success("产品卖点已生成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "产品分析失败");
        } finally {
            setAnalyzing(false);
        }
    };

    const recommendStyle = async () => {
        if (!token) {
            message.warning("请先登录后使用商品套图");
            return;
        }
        if (!productBrief.trim()) {
            message.warning("请先输入产品卖点");
            return;
        }
        setRecommending(true);
        setStyles([]);
        setStyleText("");
        try {
            const data = await recommendProductSetStyle(token!, CASE_ID, input);
            setStyles(data.styles);
            setStyleText(data.styles[0]?.description || "");
            setStyleMode("ai");
            message.success("AI 风格方案已生成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "风格推荐失败");
        } finally {
            setRecommending(false);
        }
    };

    const parseAll = async () => {
        if (!ensureReady(false)) return;
        setParsingAll(true);
        setAnalyzing(true);
        setRecommending(true);
        setStyles([]);
        setStyleText("");
        try {
            const data = await parseProductSet(token!, CASE_ID, input);
            setProductBrief(data.productBrief);
            setStyles(data.styles);
            setStyleText(data.styles[0]?.description || "");
            setStyleMode("ai");
            message.success("产品卖点与设计风格已解析");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "一键解析失败");
        } finally {
            setParsingAll(false);
            setAnalyzing(false);
            setRecommending(false);
        }
    };

    const plan = async () => {
        if (!ensureReady()) return;
        setPlanning(true);
        try {
            const { points } = await fetchProductSetPlanPrice(token!, CASE_ID);
            modal.confirm({
                title: "生成套图方案",
                content: `将调用文本模型，预计扣除 ${points} 算力点；实际成图需另行生成并扣费。`,
                okText: "确认生成",
                cancelText: "取消",
                onCancel: () => setPlanning(false),
                onOk: async () => {
                    try {
                        const data = await planProductSet(token!, CASE_ID, input);
                        setCards(data.cards);
                        setPlanInput(input);
                        setSelectedCards(data.cards.map((card) => card.id));
                        setResults([]);
                        setMode("preview");
                        message.success("套图方案已生成");
                    } catch (error) {
                        message.error(error instanceof Error ? error.message : "套图方案生成失败");
                    } finally {
                        setPlanning(false);
                    }
                },
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "方案算力点报价获取失败");
            setPlanning(false);
        }
    };

    const generate = async (cardIds = pendingCardIds) => {
        if (!ensureReady()) return;
        if (!planInput) {
            message.warning("请先生成新的套图方案，再正式生成");
            return;
        }
        if (planOutdated) {
            message.warning("商品或设计配置已修改，请重新生成方案");
            return;
        }
        if (!cardIds.length) {
            message.warning("请至少选择一张套图");
            return;
        }
        if (quoting || generating) return;
        setQuoting(true);
        try {
            const quote = await fetchProductSetImagePrice(token!, CASE_ID);
            setImagePrice(quote.pointsPerImage);
            const confirmed = await new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: "确认生成商品套图",
                    content: `本次选择 ${cardIds.length} 张，${quote.model} 每张 ${quote.pointsPerImage} 算力点，预计消耗 ${cardIds.length * quote.pointsPerImage} 算力点。成功的图片按张扣费，失败的模型调用自动返还算力点。`,
                    okText: "确认生成",
                    cancelText: "取消",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            });
            if (!confirmed) return;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片算力点报价获取失败");
            return;
        } finally {
            setQuoting(false);
        }
        setGenerating(true);
        setRunProgress({ completed: 0, total: cardIds.length });
        setResults((current) => current.filter((item) => !cardIds.includes(item.cardId)));
        try {
            const data = await streamProductSet(token!, CASE_ID, { ...planInput, cardIds, planCards: cards }, (item, completed, total) => {
                setResults((current) => [...current.filter((existing) => existing.cardId !== item.cardId), item]);
                setRunProgress({ completed, total });
            });
            setResults((current) => [...current.filter((item) => !cardIds.includes(item.cardId)), ...data.items]);
            setMode("preview");
            data.failed ? message.warning(`已完成 ${data.total - data.failed}/${data.total} 张，失败的图片可单独重试`) : message.success("商品套图生成完成");
            if (token)
                void fetchCaseRuns(token, { page: 1, pageSize: 40 })
                    .then((runs) => setHistory(runs.items.filter((item) => item.caseId === CASE_ID)))
                    .catch(() => undefined);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "商品套图生成失败");
        } finally {
            setGenerating(false);
            setRunProgress(null);
        }
    };

    const retry = async (cardId: string) => {
        setRetrying(cardId);
        try {
            await generate([cardId]);
        } finally {
            setRetrying(null);
        }
    };

    const download = (url: string, name: string) => {
        try {
            saveAs(url, name);
        } catch {
            message.error("下载失败，请稍后重试");
        }
    };

    const previewCards = cards.length ? cards : config.examples.map((example, index) => ({ id: `example-${index}`, title: example.title, description: "查看商品套图的常见构图和信息层级", aspectRatio: "1:1" }));
    const selectedCount = selectedCards.length;
    const downloadableImages = useMemo(() => productSetDownloads(cards, results), [cards, results]);
    const successfulIds = new Set(downloadableImages.map((image) => cards[image.index - 1].id));
    const pendingCardIds = selectedCards.filter((id) => !successfulIds.has(id));
    const failedCount = results.filter((item) => item.error).length;
    const allComplete = cards.length > 0 && downloadableImages.length === cards.length;
    const downloadAll = async () => {
        if (downloadProgress !== null || generating) return;
        setDownloadProgress(0);
        try {
            const zip = await createProductSetZip(downloadableImages, fetchImageBlob, setDownloadProgress);
            saveAs(zip, `商品套图-${downloadableImages.length}张.zip`);
            message.success(`已打包 ${downloadableImages.length} 张原图`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "套图下载失败，请重试");
        } finally {
            setDownloadProgress(null);
        }
    };
    const restoreHistory = (run: CaseRun) => {
        const items = historyResults(run);
        if (!items.length) {
            message.warning("这次生成没有可恢复的结果");
            return;
        }
        setCards(items.map((item) => ({ id: item.cardId, category: item.category, title: item.title, description: item.description || "历史生成结果", aspectRatio: "1:1" })));
        setPlanInput(null);
        setSelectedCards(items.map((item) => item.cardId));
        setResults(items);
        setMode("preview");
    };
    const saveEditedCard = () => {
        if (!editingCard) return;
        const title = editingCard.title.trim();
        const description = editingCard.description.trim();
        if (!title || !description) {
            message.warning("请填写方案标题和画面描述");
            return;
        }
        setCards((current) => current.map((card) => (card.id === editingCard.id ? { ...card, title, description } : card)));
        setEditingCard(null);
    };
    const toggleHistory = () => {
        if (mode === "history") {
            setMode(returnMode.current);
        } else {
            returnMode.current = mode;
            setMode("history");
        }
    };

    return (
        <div className="product-listing-set-workspace h-full bg-[#f0f2f5] text-[#111827]">
            <main className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:items-stretch lg:overflow-hidden">
                <aside className="flex w-full max-w-[460px] shrink-0 flex-col overflow-visible border border-gray-200 bg-white lg:h-[calc(100vh-88px)] lg:overflow-hidden">
                    <div className="scrollbar-hover flex-1 overflow-y-auto px-4 py-5">
                        <section>
                            <h1 className="text-[16px] font-semibold">{config.entry.title || "商品套图"}</h1>
                            <p className="mt-1 text-[12px] leading-5 text-[#6b7280]">{config.entry.description || "上传商品图，生成适配电商平台的商品套图方案和结果。"}</p>
                            <h2 className="mt-5 text-[13px] font-medium text-[#6b7280]">基础信息</h2>
                            <div className="mt-4">
                                <div className="mb-2 flex items-center justify-between">
                                    <h3 className="text-[14px] font-medium">上传图片</h3>
                                    <span className="text-[14px] font-medium text-[#6b7280]">
                                        {images.length}/{MAX_IMAGES}
                                    </span>
                                </div>
                                {images.length ? (
                                    <div
                                        className="rounded-[16px] border border-gray-200 bg-white p-3"
                                        onDragOver={(event) => handleDrag(event, "product", true)}
                                        onDragLeave={(event) => handleDrag(event, "product", false)}
                                        onDrop={(event) => handleDrop(event, "product")}
                                    >
                                        <div className="grid grid-cols-4 gap-x-3.5 gap-y-3.5">
                                            {images.map((image, index) => (
                                                <div key={image.id} className="group relative h-20 overflow-hidden rounded-[9px] bg-gray-50">
                                                    <img src={image.src} alt={image.name} className="h-full w-full object-cover" />
                                                    <span className="absolute bottom-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-white px-1.5 text-[11px] shadow">{index + 1}</span>
                                                    <button
                                                        type="button"
                                                        aria-label="移除图片"
                                                        className="absolute right-1 top-1 hidden h-6 w-6 place-items-center rounded-full bg-black/60 text-white group-hover:grid"
                                                        onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                                                    >
                                                        <X className="size-3.5" />
                                                    </button>
                                                </div>
                                            ))}
                                            {images.length < MAX_IMAGES ? (
                                                <button
                                                    type="button"
                                                    className="flex h-20 items-center justify-center rounded-[9px] border border-dashed border-gray-300 text-2xl font-light text-[#6b7280] hover:bg-gray-50"
                                                    onClick={() => productInput.current?.click()}
                                                >
                                                    +
                                                </button>
                                            ) : null}
                                            <button type="button" className="flex h-20 items-center justify-center rounded-[9px] border border-dashed border-gray-300 text-[#6b7280] hover:bg-gray-50" onClick={() => setAssetPickerTarget("product")}>
                                                <FolderOpen className="size-5" />
                                            </button>
                                            {images.length < MAX_IMAGES ? (
                                                <button type="button" aria-label="从剪切板上传图片" className="flex h-20 items-center justify-center rounded-[9px] border border-dashed border-gray-300 text-[#6b7280] hover:bg-gray-50" onClick={() => void addClipboardFiles("product")}>
                                                    <ClipboardPaste className="size-5" />
                                                </button>
                                            ) : null}
                                        </div>
                                    </div>
                                ) : (
                                    <div
                                        className={`flex h-40 flex-col items-center justify-center rounded-[18px] border-2 border-dashed px-4 py-5 text-center transition ${dragTarget === "product" ? "border-[#5b8dff] bg-blue-50" : "border-[#c8c8c8] bg-white hover:border-[#8f8f8f]"}`}
                                        onClick={() => productInput.current?.click()}
                                        onDragOver={(event) => handleDrag(event, "product", true)}
                                        onDragLeave={(event) => handleDrag(event, "product", false)}
                                        onDrop={(event) => handleDrop(event, "product")}
                                    >
                                        <ImagePlus className="mb-3 size-9" />
                                        <div className="text-[14px] font-medium">{dragTarget === "product" ? "松开鼠标上传图片" : "点击或拖拽上传图片"}</div>
                                        <div className="mt-2 text-[12px] text-[#6b7280]">支持 JPG、JPEG、PNG，单张不超过 10MB</div>
                                        <div className="mt-4 flex items-center gap-3">
                                            <button
                                                type="button"
                                                className="rounded-lg bg-gray-50 px-4 py-2 text-[13px] font-medium shadow-sm hover:bg-gray-100"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    productInput.current?.click();
                                                }}
                                            >
                                                选择文件
                                            </button>
                                            <button
                                                type="button"
                                                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 px-4 py-2 text-[13px] font-medium shadow-sm hover:bg-gray-100"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    setAssetPickerTarget("product");
                                                }}
                                            >
                                                <FolderOpen className="size-4" />
                                                从资产库选择
                                            </button>
                                            <button
                                                type="button"
                                                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 px-4 py-2 text-[13px] font-medium shadow-sm hover:bg-gray-100"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    void addClipboardFiles("product");
                                                }}
                                            >
                                                <ClipboardPaste className="size-4" />
                                                从剪切板上传
                                            </button>
                                        </div>
                                    </div>
                                )}
                                <input
                                    ref={productInput}
                                    type="file"
                                    accept="image/jpeg,image/png"
                                    multiple
                                    hidden
                                    onChange={(event) => {
                                        void appendFiles(event.target.files || [], "product");
                                        event.target.value = "";
                                    }}
                                />
                            </div>
                            <div className="mt-5">
                                <FieldLabel label="目标市场">
                                    <select
                                        className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] outline-none focus:border-[#5b8dff]"
                                        value={market}
                                        onChange={(event) => {
                                            const nextMarket = event.target.value;
                                            const nextPlatforms = platformsForMarket(config.platforms, nextMarket);
                                            setMarket(nextMarket);
                                            setPlatform((current) => (nextPlatforms.some((item) => item.value === current) ? current : defaultPlatform(nextPlatforms)));
                                        }}
                                    >
                                        {config.markets.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                </FieldLabel>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                                <FieldLabel label="目标平台">
                                    <select className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] outline-none focus:border-[#5b8dff]" value={platform} onChange={(event) => setPlatform(event.target.value)}>
                                        {platformOptions.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                </FieldLabel>
                                <FieldLabel label="文案语言">
                                    <select className="h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-[13px] outline-none focus:border-[#5b8dff]" value={language} onChange={(event) => setLanguage(event.target.value)}>
                                        {config.languages.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </select>
                                </FieldLabel>
                            </div>
                        </section>

                        <section className="mt-8">
                            <div className="mb-5 flex items-center justify-between gap-3">
                                <h2 className="text-[13px] font-medium text-[#6b7280]">产品卖点与设计风格</h2>
                                <button
                                    type="button"
                                    disabled={analyzing || recommending || planning}
                                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-gray-300 bg-gradient-to-b from-white to-gray-100 px-4 text-[13px] font-medium shadow-sm disabled:opacity-60"
                                    onClick={() => void parseAll()}
                                >
                                    <Sparkles className="size-4" />
                                    {parsingAll ? "正在解析..." : "一键解析 · 按模型实际算力点扣除"}
                                </button>
                            </div>
                            <div className="mb-3 flex items-center justify-between">
                                <h3 className="text-[14px] font-medium">产品卖点</h3>
                                <button type="button" disabled={analyzing} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-[#4b5563] hover:bg-gray-100 disabled:opacity-60" onClick={() => void analyze()}>
                                    <Sparkles className="size-3.5" />
                                    AI生成 · 按模型实际算力点扣除
                                </button>
                            </div>
                            {analyzing ? (
                                <div className="flex h-[120px] flex-col items-center justify-center rounded-[14px] border border-dashed border-gray-200">
                                    <LoaderCircle className="size-5 animate-spin" />
                                    <span className="mt-3 text-[13px] font-medium text-[#4b5563]">正在分析产品图片...</span>
                                </div>
                            ) : (
                                <textarea
                                    value={productBrief}
                                    onChange={(event) => setProductBrief(event.target.value)}
                                    rows={5}
                                    className="h-[120px] w-full resize-y rounded-md border border-gray-300 bg-white p-3 text-[13px] leading-6 outline-none focus:border-[#5b8dff]"
                                    placeholder={"产品名：\n核心卖点：\n适用人群：\n期望场景：\n尺寸参数："}
                                />
                            )}

                            <div className="mt-6">
                                <div className="mb-4 flex items-center justify-between">
                                    <h3 className="text-[14px] font-medium">设计风格</h3>
                                    <button
                                        type="button"
                                        disabled={recommending || analyzing}
                                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-[#6b7280] hover:bg-gray-100 disabled:opacity-60"
                                        onClick={() => void recommendStyle()}
                                    >
                                        <Sparkles className="size-3.5" />
                                        AI推荐 · 按模型实际算力点扣除
                                    </button>
                                </div>
                                <div className="rounded-xl bg-gray-50 p-2">
                                    <div className="grid grid-cols-3 gap-2">
                                        {(
                                            [
                                                ["ai", "AI推荐"],
                                                ["reference", "参考排版"],
                                                ["custom", "自定义要求"],
                                            ] as const
                                        ).map(([value, label]) => (
                                            <button
                                                key={value}
                                                type="button"
                                                className={`h-9 rounded-lg text-[14px] font-medium transition ${styleMode === value ? "border border-[#5b8dff]/70 bg-white text-[#3155b5] shadow-sm" : "text-[#6b7280]"}`}
                                                onClick={() => setStyleMode(value)}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    {styleMode === "ai" ? (
                                        <div className={`mt-4 flex min-h-[196px] flex-col ${styles.length ? "" : "items-center justify-center"}`}>
                                            {styles.length ? (
                                                <div className="grid w-full grid-cols-2 gap-3">
                                                    {styles.map((style, index) => (
                                                        <button
                                                            key={style.id}
                                                            type="button"
                                                            aria-pressed={styleText === style.description}
                                                            className={`min-h-[108px] rounded-lg border p-3 text-left transition ${styleText === style.description ? "border-[#5b8dff]/70 bg-white shadow-sm" : "border-gray-200 bg-white hover:border-[#5b8dff]/55"}`}
                                                            onClick={() => setStyleText(style.description)}
                                                        >
                                                            <div className={`flex h-[22px] overflow-hidden rounded-full border border-black/10 bg-gradient-to-r ${stylePalettes[index % stylePalettes.length]}`} />
                                                            <h3 className="mt-2.5 text-[14px] font-medium">{style.title}</h3>
                                                            <p className="mt-1 line-clamp-3 text-[12px] leading-5 text-[#4b5563]">{style.description}</p>
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : recommending ? (
                                                <div className="flex flex-col items-center gap-3 text-[13px] text-[#6b7280]">
                                                    <LoaderCircle className="size-5 animate-spin" />
                                                    正在分析商品风格...
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    disabled={analyzing}
                                                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 text-[13px] font-medium shadow-sm disabled:opacity-60"
                                                    onClick={() => void recommendStyle()}
                                                >
                                                    <Sparkles className="size-4" />
                                                    AI推荐风格分析 · 按模型实际算力点扣除
                                                </button>
                                            )}
                                        </div>
                                    ) : null}
                                    {styleMode === "reference" ? (
                                        <ReferencePicker
                                            references={references}
                                            dragTarget={dragTarget}
                                            inputRef={referenceInput}
                                            onOpenFile={() => referenceInput.current?.click()}
                                            onOpenAssets={() => setAssetPickerTarget("reference")}
                                            onPaste={() => void addClipboardFiles("reference")}
                                            onFiles={(files) => void appendFiles(files, "reference")}
                                            onDrag={(event, active) => handleDrag(event, "reference", active)}
                                            onDrop={(event) => handleDrop(event, "reference")}
                                            onRemove={(id) => setReferences((current) => current.filter((item) => item.id !== id))}
                                        />
                                    ) : null}
                                    {styleMode === "custom" ? (
                                        <textarea
                                            value={customStyleText}
                                            onChange={(event) => setCustomStyleText(event.target.value)}
                                            rows={6}
                                            className="mt-4 w-full resize-y rounded-md border border-gray-300 bg-white p-3 text-[13px] leading-6 outline-none focus:border-[#5b8dff]"
                                            placeholder="描述画面风格、色彩、构图和品牌氛围"
                                        />
                                    ) : null}
                                </div>
                            </div>
                            <div className="mt-8">
                                <div className="mb-4 flex items-center justify-between text-[13px] font-medium text-[#6b7280]">
                                    <h3>套图结构配置</h3>
                                    <span>{layoutMode === "custom" ? customImageCount : "智能匹配"}</span>
                                </div>
                                <div className="space-y-3">
                                    {(
                                        [
                                            ["default", "智能匹配", "AI智能分析商品图，匹配合适的 Listing 套图"],
                                            ["custom", "自定义配置", "可自由调整各类型图片数量，至少选择7张"],
                                        ] as const
                                    ).map(([value, label, description]) => (
                                        <button
                                            key={value}
                                            type="button"
                                            aria-pressed={layoutMode === value}
                                            className={`flex min-h-[74px] w-full items-start justify-between gap-3 rounded-lg border px-4 py-4 text-left ${layoutMode === value ? "border-[#5b8dff] bg-blue-50" : "border-gray-200 bg-white hover:border-[#5b8dff]"}`}
                                            onClick={() => setLayoutMode(value)}
                                        >
                                            <span className="min-w-0">
                                                <span className="block text-[14px] font-medium">{label}</span>
                                                <span className="mt-1 block text-[12px] leading-5 text-[#6b7280]">{description}</span>
                                            </span>
                                            <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${layoutMode === value ? "border-[#5b8dff] bg-[#5b8dff] text-white" : "border-gray-300"}`}>
                                                {layoutMode === value ? <Check className="size-3" /> : null}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {layoutMode === "custom" ? (
                                <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
                                    {[
                                        ["whiteBackground", "白底图", "白底主图，多角度呈现商品细节"],
                                        ["scene", "场景图", "展示商品的生活使用场景和人物搭配"],
                                        ["sellingPoint", "卖点图", "展示商品的核心卖点及细节特写"],
                                        ["other", "其他", "对比图、尺寸图等，根据商品智能匹配"],
                                    ].map(([key, label, description]) => (
                                        <div key={key} className="flex min-h-[62px] items-center justify-between gap-3 px-1 py-2">
                                            <div>
                                                <div className="text-[14px] font-medium">{label}</div>
                                                <p className="mt-1 text-[12px] leading-5 text-[#6b7280]">{description}</p>
                                            </div>
                                            <div className="flex h-8 items-center overflow-hidden rounded-lg bg-gray-100">
                                                <button
                                                    type="button"
                                                    aria-label={`减少${label}`}
                                                    className="h-8 w-9 text-lg disabled:cursor-not-allowed disabled:text-gray-300"
                                                    disabled={customImageCount <= 7 || layoutCounts[key as keyof typeof layoutCounts] <= 0}
                                                    onClick={() => setLayoutCounts((current) => ({ ...current, [key]: Math.max(0, current[key as keyof typeof current] - 1) }))}
                                                >
                                                    <Minus className="mx-auto size-3.5" />
                                                </button>
                                                <span className="flex h-8 w-9 items-center justify-center text-[14px] font-medium">{layoutCounts[key as keyof typeof layoutCounts]}</span>
                                                <button
                                                    type="button"
                                                    aria-label={`增加${label}`}
                                                    className="h-8 w-9 text-lg disabled:cursor-not-allowed disabled:text-gray-300"
                                                    disabled={customImageCount >= 16}
                                                    onClick={() => setLayoutCounts((current) => ({ ...current, [key]: current[key as keyof typeof current] + 1 }))}
                                                >
                                                    <Plus className="mx-auto size-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    <p className="mt-2 text-[12px] text-[#6b7280]">当前共 {customImageCount} 张，至少 7 张</p>
                                </div>
                            ) : null}
                        </section>
                    </div>
                    <div className="border-t border-gray-200 bg-white/95 px-4 py-4">
                        <button
                            type="button"
                            disabled={configLoading || planning || analyzing || recommending || !images.length}
                            className="product-set-primary-action flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#111827] text-[14px] font-medium text-white shadow-sm transition hover:bg-black disabled:cursor-not-allowed"
                            onClick={() => void plan()}
                        >
                            <Sparkles className="size-4" />
                            {planning ? "生成预览中..." : "生成预览"}
                        </button>
                    </div>
                </aside>

                <section className="min-w-0 flex-1 overflow-y-auto border border-gray-200 bg-white px-5 py-5 lg:h-[calc(100vh-88px)]">
                    <div className="flex justify-end">
                        <button
                            type="button"
                            aria-pressed={mode === "history"}
                            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition hover:bg-gray-100 ${mode === "history" ? "bg-gray-100 text-[#111827]" : "text-[#4b5563]"}`}
                            onClick={toggleHistory}
                        >
                            <History className="size-4" />
                            <span>{mode === "history" ? "返回" : "历史"}</span>
                        </button>
                    </div>
                    <div className="mt-1">
                        {mode === "example" ? <ExamplePanel examples={config.examples} /> : null}
                        {mode === "history" ? (
                            <HistoryPanel
                                history={history}
                                onBack={toggleHistory}
                                backLabel={returnMode.current === "preview" ? "返回套图方案" : "返回示例"}
                                onOpen={restoreHistory}
                                onRefresh={() => token && void fetchCaseRuns(token, { page: 1, pageSize: 40 }).then((data) => setHistory(data.items.filter((item) => item.caseId === CASE_ID)))}
                            />
                        ) : null}
                        {mode === "preview" ? (
                            <>
                                <PreviewPanel
                                    cards={previewCards}
                                    selectedCards={selectedCards}
                                    setSelectedCards={setSelectedCards}
                                    results={results}
                                    retrying={retrying}
                                    onRetry={(id) => void retry(id)}
                                    onPreview={setPreviewImage}
                                    onDownload={download}
                                    onEdit={(card) => setEditingCard({ id: card.id, title: card.title, description: card.description })}
                                    editable={planInput !== null && !generating}
                                />
                                <div className="sticky bottom-0 mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-white py-4">
                                    <div className="min-w-0 flex-1">
                                        {results.length > 0 && !generating ? (
                                            <p role="status" className="mb-1 flex items-center gap-1.5 text-[13px] font-medium">
                                                {allComplete ? <Check className="size-4" /> : null}
                                                {allComplete ? `生成完成 ${downloadableImages.length}/${cards.length} 张` : `已生成 ${downloadableImages.length}/${cards.length} 张${failedCount ? `，失败 ${failedCount} 张` : ""}`}
                                            </p>
                                        ) : null}
                                        <span className="text-[12px] text-[#6b7280]">{planOutdated ? "配置已修改，请重新生成方案" : planInput ? `所选待生成 ${pendingCardIds.length} 张 · ${imagePrice === null ? "报价加载中" : `每张 ${imagePrice} 算力点，预计消耗 ${pendingCardIds.length * imagePrice} 算力点`}；失败调用自动退款` : "历史生成结果"}</span>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                                        {downloadableImages.length > 0 ? (
                                            <button
                                                type="button"
                                                disabled={generating || downloadProgress !== null}
                                                className="product-set-primary-action inline-flex h-10 items-center gap-2 rounded-lg bg-[#111827] px-4 text-[13px] font-medium text-white disabled:cursor-not-allowed"
                                                onClick={() => void downloadAll()}
                                            >
                                                {downloadProgress !== null ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                                                {downloadProgress !== null ? `打包中 ${downloadProgress}/${downloadableImages.length}` : `一键下载 ${downloadableImages.length} 张`}
                                            </button>
                                        ) : null}
                                        {!allComplete || generating ? (
                                            <button
                                                type="button"
                                                disabled={generating || quoting || !planInput || planOutdated || !pendingCardIds.length || !cards.length || !images.length}
                                                className="product-set-primary-action inline-flex h-10 items-center gap-2 rounded-lg bg-[#111827] px-5 text-[13px] font-medium text-white disabled:cursor-not-allowed"
                                                onClick={() => void generate()}
                                            >
                                                {generating || quoting ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                                                {generating ? `已完成 ${runProgress?.completed || 0}/${runProgress?.total || selectedCount}` : quoting ? "核对算力点..." : `正式生成 ${pendingCardIds.length} 张${imagePrice === null ? "" : ` · 预计 ${pendingCardIds.length * imagePrice} 算力点`}`}
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                            </>
                        ) : null}
                    </div>
                </section>
            </main>

            <AssetPickerModal open={assetPickerTarget !== null} defaultTab="my-assets" onInsert={addPickedAsset} onClose={() => setAssetPickerTarget(null)} />
            <Modal open={Boolean(previewImage)} footer={null} onCancel={() => setPreviewImage(null)} width={760} centered>
                <div className="flex max-h-[75vh] items-center justify-center bg-gray-50 p-3 dark:bg-stone-900">{previewImage ? <img src={previewImage} alt="商品套图预览" className="max-h-[68vh] max-w-full object-contain" /> : null}</div>
            </Modal>
            <Modal title="编辑套图方案" open={editingCard !== null} onOk={saveEditedCard} onCancel={() => setEditingCard(null)} okText="保存方案" cancelText="取消" destroyOnHidden>
                <div className="space-y-4 py-2">
                    <label className="block text-[13px] font-medium">
                        方案标题
                        <Input value={editingCard?.title || ""} onChange={(event) => setEditingCard((card) => card && { ...card, title: event.target.value })} className="mt-1.5" />
                    </label>
                    <label className="block text-[13px] font-medium">
                        画面描述
                        <Input.TextArea value={editingCard?.description || ""} onChange={(event) => setEditingCard((card) => card && { ...card, description: event.target.value })} rows={7} className="mt-1.5" />
                    </label>
                </div>
            </Modal>
        </div>
    );
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex min-w-0 flex-col gap-2">
            <span className="text-[13px] font-medium leading-none text-[#374151]">{label}</span>
            {children}
        </label>
    );
}

function ReferencePicker({
    references,
    dragTarget,
    inputRef,
    onOpenFile,
    onOpenAssets,
    onPaste,
    onFiles,
    onDrag,
    onDrop,
    onRemove,
}: {
    references: LocalImage[];
    dragTarget: "product" | "reference" | null;
    inputRef: React.RefObject<HTMLInputElement | null>;
    onOpenFile: () => void;
    onOpenAssets: () => void;
    onPaste: () => void;
    onFiles: (files: FileList | File[]) => void;
    onDrag: (event: DragEvent<HTMLDivElement>, active: boolean) => void;
    onDrop: (event: DragEvent<HTMLDivElement>) => void;
    onRemove: (id: string) => void;
}) {
    return (
        <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[14px] font-medium">风格/排版参考图（可选）</h3>
                <span className="text-[13px] text-[#6b7280]">{references.length}/5</span>
            </div>
            <div
                className={`flex min-h-[164px] flex-col items-center justify-center rounded-[18px] border-2 border-dashed px-4 py-5 text-center transition ${dragTarget === "reference" ? "border-[#5b8dff] bg-blue-50" : "border-[#c8c8c8] bg-white hover:border-[#8f8f8f]"}`}
                onDragOver={(event) => onDrag(event, true)}
                onDragLeave={(event) => onDrag(event, false)}
                onDrop={onDrop}
            >
                <Upload className="mb-3 size-8" />
                <div className="text-[14px] font-medium">点击或拖拽上传图片</div>
                <div className="mt-2 text-[12px] text-[#6b7280]">支持 JPG、JPEG、PNG，单张不超过 10MB</div>
                <div className="mt-4 flex items-center gap-3">
                    <button type="button" className="rounded-lg bg-gray-50 px-4 py-2 text-[13px] font-medium shadow-sm" onClick={onOpenFile}>
                        选择文件
                    </button>
                    <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 px-4 py-2 text-[13px] font-medium shadow-sm" onClick={onOpenAssets}>
                        <FolderOpen className="size-4" />
                        从资产库选择
                    </button>
                    <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-gray-50 px-4 py-2 text-[13px] font-medium shadow-sm" onClick={onPaste}>
                        <ClipboardPaste className="size-4" />
                        从剪切板上传
                    </button>
                </div>
            </div>
            <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png"
                multiple
                hidden
                onChange={(event) => {
                    onFiles(event.target.files || []);
                    event.currentTarget.value = "";
                }}
            />
            {references.length ? (
                <div className="mt-3 grid grid-cols-4 gap-3">
                    {references.map((image) => (
                        <div key={image.id} className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200 bg-white">
                            <img src={image.src} alt={image.name} className="h-full w-full object-cover" />
                            <button type="button" className="absolute right-1 top-1 hidden h-7 w-7 place-items-center rounded-full bg-black/55 text-white group-hover:grid" onClick={() => onRemove(image.id)}>
                                <Trash2 className="size-4" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            <p className="mt-3 text-[13px] leading-5 text-[#6b7280]">上传后，AI 将参考其视觉风格和排版。</p>
        </div>
    );
}

function ExamplePanel({ examples }: { examples: ProductSetConfig["examples"] }) {
    const [failedImages, setFailedImages] = useState<string[]>([]);

    return (
        <section>
            <div className="mx-auto max-w-[980px] pt-8 text-center">
                <h2 className="text-[26px] font-semibold leading-9 text-[#050505]">AI商品套图</h2>
                <p className="mt-3 text-[13px] leading-5 text-[#6b7280]">上传商品图，AI 即刻生成符合多电商平台规范的高转化率商品套图</p>
            </div>
            <div className="mx-auto mt-7 grid max-w-[980px] grid-cols-2 gap-3 lg:grid-cols-4">
                {examples.map((example) => (
                    <figure key={example.title} className="group relative aspect-square overflow-hidden rounded-[14px] bg-gray-100">
                        {failedImages.includes(example.src) ? (
                            <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-[#6b7280]">
                                <p>示例图片加载失败</p>
                                <button type="button" onClick={() => setFailedImages((items) => items.filter((src) => src !== example.src))} className="inline-flex items-center gap-1.5 px-2 py-1 hover:text-[#111827]">
                                    <RefreshCw className="size-4" />
                                    重试
                                </button>
                            </div>
                        ) : (
                            <img
                                src={example.src}
                                alt={example.title}
                                onError={() => setFailedImages((items) => [...items, example.src])}
                                className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
                            />
                        )}
                        <figcaption className="absolute left-3 top-3 rounded-md bg-white/80 px-2 py-1 text-[12px] font-medium backdrop-blur">{example.title}</figcaption>
                    </figure>
                ))}
            </div>
        </section>
    );
}

function HistoryPanel({ history, onRefresh, onOpen, onBack, backLabel }: { history: CaseRun[]; onRefresh: () => void; onOpen: (run: CaseRun) => void; onBack: () => void; backLabel: string }) {
    return (
        <section className="min-h-[520px]">
            <div className="mb-5 flex items-center justify-between">
                <div>
                    <button type="button" className="mb-3 inline-flex items-center gap-1 text-[12px] text-[#6b7280] hover:text-[#111827]" onClick={onBack}>
                        <ArrowLeft className="size-3.5" />
                        {backLabel}
                    </button>
                    <h2 className="text-[20px] font-semibold">商品套图历史</h2>
                </div>
                <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-[12px] font-medium hover:bg-gray-50" onClick={onRefresh}>
                    <RefreshCw className="size-3.5" />
                    刷新
                </button>
            </div>
            {history.length ? (
                <div className="space-y-3">
                    {history.map((item) => (
                        <article key={item.id} className="rounded-lg border border-gray-200 bg-white p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-[15px] font-medium">商品套图批次</h3>
                                    <p className="mt-1 text-[12px] text-[#6b7280]">{formatDate(item.createdAt)}</p>
                                </div>
                                <span className="text-[12px] text-[#6b7280]">{item.status === "succeeded" ? "已完成" : item.status === "partial" ? "部分完成" : item.status === "failed" ? "失败" : "处理中"}</span>
                            </div>
                            <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-[#6b7280]">
                                <span>{item.chargedCredits ? `历史案例服务费 ${item.chargedCredits} 算力点` : "图片按成功张数扣费"}</span>
                                {historyResults(item).length ? (
                                    <button type="button" className="rounded border border-gray-200 px-3 py-1.5 text-[#111827]" onClick={() => onOpen(item)}>
                                        查看结果
                                    </button>
                                ) : null}
                            </div>
                            {item.errorMessage ? <p className="mt-2 text-[12px] text-red-500">{item.errorMessage}</p> : null}
                        </article>
                    ))}
                </div>
            ) : (
                <div className="flex min-h-[420px] items-center justify-center">
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史记录" />
                </div>
            )}
        </section>
    );
}

function PreviewPanel({
    cards,
    selectedCards,
    setSelectedCards,
    results,
    retrying,
    onRetry,
    onPreview,
    onDownload,
    onEdit,
    editable,
}: {
    cards: ProductSetCard[];
    selectedCards: string[];
    setSelectedCards: (ids: string[]) => void;
    results: ProductSetRunResult["items"];
    retrying: string | null;
    onRetry: (id: string) => void;
    onPreview: (url: string) => void;
    onDownload: (url: string, name: string) => void;
    onEdit: (card: ProductSetCard) => void;
    editable: boolean;
}) {
    const resultById = new Map(results.map((item) => [item.cardId, item]));
    return (
        <section className="min-h-[520px]">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-[20px] font-semibold">套图方案预览</h2>
                </div>
                <span className="rounded-full border border-gray-200 px-3 py-1 text-[12px] text-[#6b7280]">
                    已选 {selectedCards.length}/{cards.length}
                </span>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-2">
                {cards.map((card) => {
                    const selected = selectedCards.includes(card.id);
                    const result = resultById.get(card.id);
                    const url = result ? findImageURL(result.data) : null;
                    return (
                        <article key={card.id} className={`overflow-hidden rounded-lg border bg-white transition ${result?.error ? "border-red-300" : selected ? "border-[#5b8dff]/70" : "border-gray-200"}`}>
                            <button type="button" className="w-full text-left" onClick={() => setSelectedCards(selected ? selectedCards.filter((id) => id !== card.id) : [...selectedCards, card.id])}>
                                <div className="flex items-center justify-between gap-3 p-3">
                                    <div className="min-w-0">
                                        {card.category ? <span className="mb-1 block text-[12px] text-[#6b7280]">{card.category}</span> : null}
                                        <h3 className="text-[14px] font-medium leading-5">{card.title}</h3>
                                    </div>
                                    <span className={`grid h-5 w-5 place-items-center rounded-full border text-[12px] ${selected ? "border-[#1f6bff] bg-[#1f6bff] text-white" : "border-gray-300 text-transparent"}`}>
                                        <Check className="size-3" />
                                    </span>
                                </div>
                                <p className="px-3 pb-3 text-[13px] leading-5 text-[#4b5563]">{card.description}</p>
                                {result ? (
                                    <div className="flex aspect-square items-center justify-center bg-[#f5f5f5]">
                                        {url ? (
                                            <img
                                                src={url}
                                                alt={card.title}
                                                className="h-full w-full object-contain"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onPreview(url);
                                                }}
                                            />
                                        ) : result?.error ? (
                                            <div className="p-5 text-center text-[13px] text-red-500">{result.error}</div>
                                        ) : (
                                            <div className="text-center text-[13px] text-[#6b7280]">未返回图片</div>
                                        )}
                                    </div>
                                ) : null}
                            </button>
                            {editable && (!result || result.error) ? (
                                <div className="flex justify-end px-3 pb-3">
                                    <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[#4b5563] hover:bg-gray-100 hover:text-[#111827]" onClick={() => onEdit(card)}>
                                        <Pencil className="size-3.5" />
                                        编辑方案
                                    </button>
                                </div>
                            ) : null}
                            {result && !result.error && url ? (
                                <div className="flex justify-center gap-2 p-3">
                                    <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-[12px]" onClick={() => onPreview(url)}>
                                        查看大图
                                    </button>
                                    <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-[12px]" onClick={() => onDownload(url, `${card.title}.png`)}>
                                        <Download className="size-3.5" />
                                        下载
                                    </button>
                                </div>
                            ) : result?.error ? (
                                <div className="flex justify-center p-3">
                                    <button type="button" disabled={retrying === card.id} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-[12px] disabled:opacity-60" onClick={() => onRetry(card.id)}>
                                        {retrying === card.id ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}重新生成
                                    </button>
                                </div>
                            ) : null}
                        </article>
                    );
                })}
            </div>
        </section>
    );
}
