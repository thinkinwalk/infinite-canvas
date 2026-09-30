import { useEffect, useRef, useState, type DragEvent } from "react";
import { App, Empty, Modal, Spin } from "antd";
import { ArrowLeft, ArrowRight, ClipboardPaste, Clock3, Download, LoaderCircle, Plus, RefreshCw, Upload, X } from "lucide-react";
import { saveAs } from "file-saver";

import { assistVariationPrompt, fetchCaseRuns, fetchCaseRunPrice, fetchVariationAssistPrice, streamImageVariations, type CaseRun } from "@/services/api/cases";
import { fetchImageBlob } from "@/services/image-storage";
import { createProductSetZip } from "./product-set-download";
import { useUserStore } from "@/stores/use-user-store";

const CASE_ID = "official-image-variations";
const modes = [
    ["print", "平面印花创意裂变"],
    ["background", "主体不变 · 只换背景"],
    ["surface", "主体不变 · 只换表面印花"],
    ["both", "主体 + 背景都改"],
    ["subject", "背景不变 · 只换主体"],
    ["custom", "自定义裂变要求"],
] as const;
const counts = [1, 2, 4, 8];
const demo = {
    before: "/examples/variations/original.webp",
    after: ["/examples/variations/background-1.webp", "/examples/variations/background-2.webp"],
};
type LocalImage = { url: string; name: string };
type VariationResult = { url: string; error?: string };

function readFile(file: File) {
    return new Promise<string>((resolve, reject) => {
        if (!file.type.startsWith("image/")) return reject(new Error("请选择图片文件"));
        if (file.size > 12 * 1024 * 1024) return reject(new Error("图片不能超过 12MB"));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });
}

function collectUrls(value: unknown, output: VariationResult[] = []) {
    if (Array.isArray(value)) value.forEach((item) => collectUrls(item, output));
    else if (typeof value === "string" && /^(data:image\/|https?:\/\/|blob:|\/api\/media\/)/i.test(value)) output.push({ url: value });
    else if (value && typeof value === "object") {
        const item = value as Record<string, unknown>;
        if (typeof item.url === "string") output.push({ url: item.url });
        else if (typeof item.b64_json === "string") output.push({ url: `data:image/png;base64,${item.b64_json}` });
        else Object.values(item).forEach((child) => collectUrls(child, output));
    }
    return output;
}

function historyPayload(run: CaseRun) {
    try {
        const parsed = JSON.parse(run.responseBody || "{}");
        return {
            sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : "",
            results: collectUrls(parsed.data).slice(0, 8),
            prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
            mode: typeof parsed.splitMode === "string" ? parsed.splitMode : "print",
            similarity: Number(parsed.similarity) || 80,
            count: Number(parsed.total) || 1,
        };
    } catch {
        return { sourceUrl: "", results: [], prompt: "", mode: "print", similarity: 80, count: 1 };
    }
}

export default function ImageVariationsWorkspacePage() {
    const { message, modal } = App.useApp();
    const token = useUserStore((state) => state.token);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const fileRef = useRef<HTMLInputElement>(null);
    const [source, setSource] = useState<LocalImage | null>(null);
    const [mode, setMode] = useState("background");
    const [similarity, setSimilarity] = useState(80);
    const [prompt, setPrompt] = useState("");
    const [count, setCount] = useState(1);
    const [results, setResults] = useState<VariationResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [price, setPrice] = useState<number | null>(null);
    const [priceModel, setPriceModel] = useState("");
    const [history, setHistory] = useState<CaseRun[]>([]);
    const [showHistory, setShowHistory] = useState(false);
    const [assisting, setAssisting] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState({ completed: 0, total: 0 });
    const [historyRevision, setHistoryRevision] = useState(0);
    const [restoredSource, setRestoredSource] = useState("");
    const [previewUrl, setPreviewUrl] = useState("");

    useEffect(() => {
        if (!token) {
            setPrice(null);
            return;
        }
        let active = true;
        void fetchCaseRunPrice(token, CASE_ID, count)
            .then((quote) => {
                if (active) {
                    setPrice(quote.points);
                    setPriceModel(quote.modelPoints ? "模型" : "");
                }
            })
            .catch(() => {
                if (active) setPrice(null);
            });
        return () => {
            active = false;
        };
    }, [token, count]);

    useEffect(() => {
        if (!token) return;
        void fetchCaseRuns(token, { caseId: CASE_ID, page: 1, pageSize: 40 })
            .then((data) => setHistory(data.items.filter((item) => item.caseId === CASE_ID && historyPayload(item).results.length > 0)))
            .catch(() => undefined);
    }, [token, historyRevision, showHistory]);

    const addFile = async (file?: File) => {
        if (!file) return;
        try {
            setSource({ url: await readFile(file), name: file.name });
            setResults([]);
            setRestoredSource("");
            message.success("参考图已上传");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片读取失败");
        }
    };

    const addFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) throw new Error("剪切板里没有可读取的图片");
            await addFile(new File([blobs[0]], "clipboard-image.png", { type: blobs[0].type || "image/png" }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "剪切板读取失败");
        }
    };

    const sourceDataUrl = async () => {
        if (!source) throw new Error("请先上传参考图");
        if (source.url.startsWith("data:image/")) return source.url;
        const blob = await fetchImageBlob(source.url);
        return readFile(new File([blob], source.name || "reference.png", { type: blob.type }));
    };

    const assist = async (action: "write" | "optimize") => {
        if (!token) return message.warning("请先登录后使用 AI 帮写");
        if (!source) return message.warning("请先上传参考图");
        if (action === "optimize" && !prompt.trim()) return message.warning("请先输入需要优化的描述");
        setAssisting(true);
        try {
            const quote = await fetchVariationAssistPrice(token);
            const confirmed = await new Promise<boolean>((resolve) => {
                modal.confirm({ title: action === "write" ? "AI 帮写" : "智能优化", content: `将调用文本模型，预计消耗 ${quote.points} 算力点。`, okText: "确认生成", cancelText: "取消", onOk: () => resolve(true), onCancel: () => resolve(false) });
            });
            if (!confirmed) return;
            const data = await assistVariationPrompt(token, { imageUrl: await sourceDataUrl(), mode, prompt, action });
            setPrompt(data.prompt);
            void hydrateUser();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "AI 帮写失败");
        } finally {
            setAssisting(false);
        }
    };

    const generate = async () => {
        if (!token) {
            message.warning("请先登录后使用图裂变");
            return;
        }
        if (!source) {
            message.warning("请先上传参考图");
            return;
        }
        if (mode === "custom" && !prompt.trim()) {
            message.warning("自定义模式请填写裂变要求");
            return;
        }
        try {
            const quote = await fetchCaseRunPrice(token, CASE_ID, count);
            setPrice(quote.points);
            const confirmed = await new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: "确认开始图裂变",
                    content: `本次生成 ${count} 张，预计消耗 ${quote.points} 算力点。失败的模型调用自动返还算力点。`,
                    okText: "确认生成",
                    cancelText: "取消",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            });
            if (!confirmed) return;
            setLoading(true);
            setResults([]);
            setRestoredSource("");
            setProgress({ completed: 0, total: count });
            const summary = await streamImageVariations(token, { imageUrl: await sourceDataUrl(), splitMode: mode, similarity: String(similarity), prompt: prompt.trim(), count: String(count) }, (item, completed, total) => {
                const images = collectUrls(item);
                if (images.length) setResults((current) => [...current, ...images]);
                setProgress({ completed, total });
            });
            if (summary.failed === summary.total) message.error("本次图片全部生成失败，请检查模型配置后重试");
            else if (summary.failed) message.warning(`已完成 ${summary.total - summary.failed}/${summary.total} 张，失败的模型调用已返还算力点`);
            else message.success(`已生成 ${summary.total} 张裂变图片`);
            setHistoryRevision((value) => value + 1);
            void hydrateUser();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图裂变失败，请重试");
        } finally {
            setLoading(false);
            setProgress({ completed: 0, total: 0 });
        }
    };

    const restore = (run: CaseRun) => {
        const data = historyPayload(run);
        setSource(data.sourceUrl ? { url: data.sourceUrl, name: "历史参考图" } : null);
        setResults(data.results);
        setPrompt(data.prompt);
        setMode(data.mode);
        setSimilarity(data.similarity);
        setCount(data.count);
        setRestoredSource(data.sourceUrl);
        setShowHistory(false);
    };
    const download = async (url: string, index: number) => {
        try {
            const blob = await fetchImageBlob(url);
            const ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
            saveAs(blob, `图裂变-${index + 1}.${ext}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片下载失败");
        }
    };
    const downloadAll = async () => {
        if (downloading || !results.length) return;
        setDownloading(true);
        try {
            const zip = await createProductSetZip(
                results.map((item, index) => ({ url: item.url, index: index + 1, title: "图裂变" })),
                fetchImageBlob,
            );
            saveAs(zip, `图裂变-${results.length}张.zip`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "打包下载失败");
        } finally {
            setDownloading(false);
        }
    };
    const varyAgain = (url: string) => {
        setSource({ url, name: "裂变结果.png" });
        setResults([]);
        setRestoredSource("");
    };
    const canGenerate = !!source && !loading;

    return (
        <div className="h-full overflow-y-auto bg-background text-stone-950 dark:text-stone-100">
            <main className="mx-auto grid w-full max-w-[1360px] gap-5 p-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:p-6">
                <aside className="flex flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                    <div className="mb-5">
                        <h1 className="text-base font-semibold">图裂变</h1>
                        <p className="mt-1 text-xs leading-5 text-stone-500">基于单张图片生成多维度创意变体，快速产出系列化视觉素材</p>
                    </div>
                    <div className="space-y-5">
                        <section>
                            <label className="mb-2 block text-sm font-medium">
                                <span className="text-red-500">* </span>参考图
                            </label>
                            {source ? (
                                <div className="group relative aspect-square w-24 overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700">
                                    <img src={source.url} alt="参考图" className="size-full object-cover" />
                                    <button type="button" onClick={() => setSource(null)} className="absolute right-1 top-1 hidden rounded-full bg-black/60 p-1 text-white group-hover:block">
                                        <X className="size-3" />
                                    </button>
                                </div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => fileRef.current?.click()}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        setDragging(true);
                                    }}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDragLeave={() => setDragging(false)}
                                    onDrop={(event: DragEvent<HTMLButtonElement>) => {
                                        event.preventDefault();
                                        setDragging(false);
                                        void addFile(event.dataTransfer.files[0]);
                                    }}
                                    className={`flex h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs transition ${dragging ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-stone-300 bg-stone-50 text-stone-500 hover:border-indigo-400 dark:border-stone-700 dark:bg-stone-950"}`}
                                >
                                    <Upload className="size-5" />
                                    <span>拖拽或点击上传图片</span>
                                    <span className="text-[11px]">PNG、JPG、WebP，单张不超过 12MB</span>
                                </button>
                            )}
                            {!source ? (
                                <button type="button" className="mx-auto mt-2 inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:underline" onClick={() => void addFromClipboard()}>
                                    <ClipboardPaste className="size-3.5" />
                                    从剪切板上传
                                </button>
                            ) : null}
                            <input
                                ref={fileRef}
                                hidden
                                type="file"
                                accept="image/png,image/jpeg,image/webp"
                                onChange={(event) => {
                                    void addFile(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                        </section>
                        <section>
                            <label className="mb-2 block text-sm font-medium">
                                <span className="text-red-500">* </span>裂变设置
                            </label>
                            <select
                                value={mode}
                                onChange={(event) => setMode(event.target.value)}
                                className="h-10 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm outline-none focus:border-indigo-500 dark:border-stone-700 dark:bg-stone-950"
                            >
                                {modes.map(([value, label]) => (
                                    <option key={value} value={value}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </section>
                        <section>
                            <div className="mb-2 flex items-center justify-between">
                                <label className="text-sm font-medium">
                                    补充描述 <span className="text-xs font-normal text-stone-400">(可留空)</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    {prompt.trim() ? (
                                        <button type="button" disabled={assisting} onClick={() => void assist("optimize")} className="text-xs font-medium text-indigo-600 hover:underline disabled:opacity-50">
                                            智能优化
                                        </button>
                                    ) : null}
                                    <button type="button" disabled={assisting} onClick={() => void assist("write")} className="text-xs font-medium text-indigo-600 hover:underline disabled:opacity-50">
                                        {assisting ? "正在生成…" : "AI 帮写"}
                                    </button>
                                </div>
                            </div>
                            <textarea
                                value={prompt}
                                onChange={(event) => setPrompt(event.target.value)}
                                rows={3}
                                placeholder="例如：保留产品标签文字，整体偏清新色调。"
                                className="w-full resize-none rounded-lg border border-stone-300 bg-white p-3 text-sm outline-none focus:border-indigo-500 dark:border-stone-700 dark:bg-stone-950"
                            />
                        </section>
                        <section>
                            <div className="mb-2 flex items-center justify-between text-sm font-medium">
                                <span>相似度</span>
                                <span className="text-indigo-600">{similarity}%</span>
                            </div>
                            <input type="range" min={50} max={100} step={5} value={similarity} onChange={(event) => setSimilarity(Number(event.target.value))} className="w-full accent-indigo-500" />
                            <p className="mt-1 text-xs text-stone-400">越高越接近原图，越低变化越大胆</p>
                        </section>
                        <section>
                            <label className="mb-2 block text-sm font-medium">生成数量</label>
                            <div className="grid grid-cols-4 gap-2">
                                {counts.map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        onClick={() => setCount(value)}
                                        className={`rounded-lg border py-2 text-sm ${count === value ? "border-indigo-500 bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40" : "border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300"}`}
                                    >
                                        {value}
                                    </button>
                                ))}
                            </div>
                        </section>
                    </div>
                    <div className="mt-6 border-t border-stone-200 pt-4 dark:border-stone-800">
                        <p className="mb-3 text-xs text-stone-500">{token ? (price === null ? "正在读取算力点报价…" : `预计消耗 ${price} 算力点${priceModel ? " · 按实际模型调用计费" : ""}`) : "登录后查看算力点报价"}</p>
                        <button
                            type="button"
                            disabled={!canGenerate}
                            onClick={() => void generate()}
                            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
                            {loading ? "生成中…" : `开始裂变${price !== null ? ` · ${price} 算力点` : ""}`}
                        </button>
                    </div>
                </aside>
                <section className="min-h-[620px] rounded-xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                    <div className="mb-4 flex justify-end">
                        <button
                            type="button"
                            aria-pressed={showHistory}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                            onClick={() => setShowHistory((value) => !value)}
                        >
                            {showHistory ? <ArrowLeft className="size-4" /> : <Clock3 className="size-4" />}
                            <span>{showHistory ? "返回当前" : "历史"}</span>
                        </button>
                    </div>
                    {showHistory ? (
                        <div>
                            <h2 className="mb-5 text-base font-semibold">图裂变历史</h2>
                            {history.length ? (
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                    {history.map((run) => {
                                        const item = historyPayload(run);
                                        const thumb = item.results[0]?.url || item.sourceUrl;
                                        return (
                                            <button key={run.id} type="button" onClick={() => restore(run)} className="overflow-hidden rounded-lg border border-stone-200 text-left hover:border-indigo-500 dark:border-stone-700">
                                                {thumb ? <img src={thumb} alt="历史结果" className="aspect-square w-full object-cover" /> : <div className="aspect-square bg-stone-100 dark:bg-stone-800" />}
                                                <span className="block truncate p-2 text-xs text-stone-500">{new Date(run.createdAt).toLocaleString("zh-CN")}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <Empty description="还没有图裂变记录" />
                            )}
                        </div>
                    ) : loading && !results.length ? (
                        <div className="flex min-h-[560px] items-center justify-center">
                            <Spin tip={`正在生成裂变图片 ${progress.completed}/${progress.total}`}>
                                <div className="h-20 w-40" />
                            </Spin>
                        </div>
                    ) : results.length ? (
                        <div>
                            <div className="mb-5 flex items-center justify-between">
                                <h2 className="text-base font-semibold">
                                    裂变结果 <span className="text-sm font-normal text-stone-500">{loading ? `已完成 ${progress.completed}/${progress.total} 张` : `${results.length} 张`}</span>
                                </h2>
                                <button type="button" onClick={() => void downloadAll()} disabled={downloading || loading} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700">
                                    <Download className="size-4" />
                                    {downloading ? "正在打包…" : "一键下载"}
                                </button>
                            </div>
                            {loading ? <p className="mb-3 text-xs text-stone-500">正在继续生成剩余图片，已完成结果会保存在历史中。</p> : null}
                            {restoredSource && results[0] ? (
                                <div className="mb-5 grid max-w-[520px] grid-cols-[1fr_auto_1fr] items-center gap-3">
                                    <div>
                                        <img src={restoredSource} alt="历史原图" className="aspect-square w-full rounded-lg border border-stone-200 object-contain dark:border-stone-700" />
                                        <p className="mt-1 text-center text-xs text-stone-500">原图</p>
                                    </div>
                                    <RefreshCw className="size-5 text-indigo-600" />
                                    <div>
                                        <img src={results[0].url} alt="历史效果" className="aspect-square w-full rounded-lg border border-stone-200 object-contain dark:border-stone-700" />
                                        <p className="mt-1 text-center text-xs text-indigo-600">效果</p>
                                    </div>
                                </div>
                            ) : null}
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                {results.map((item, index) => (
                                    <div key={`${item.url}-${index}`} className="group relative overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700">
                                        <button type="button" onClick={() => setPreviewUrl(item.url)} className="block w-full" title="查看大图">
                                            <img src={item.url} alt={`裂变结果 ${index + 1}`} className="aspect-square w-full object-contain" />
                                        </button>
                                        <button type="button" onClick={() => varyAgain(item.url)} className="absolute bottom-2 left-2 z-10 inline-flex items-center gap-1 rounded-md border border-stone-900/10 px-2 py-1.5 text-sm font-medium shadow-md" style={{ backgroundColor: "#fff", color: "#1c1917", WebkitTextFillColor: "#1c1917" }}>
                                            <RefreshCw className="size-3.5" />
                                            以此图再裂变
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void download(item.url, index)}
                                            title="下载图片"
                                            aria-label="下载图片"
                                            className="absolute bottom-2 right-2 z-10 hidden rounded-md border border-stone-900/10 p-2 shadow-md group-hover:block"
                                            style={{ backgroundColor: "#fff", color: "#1c1917", WebkitTextFillColor: "#1c1917" }}
                                        >
                                            <Download className="size-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div>
                            <h2 className="mb-5 text-base font-semibold">裂变结果</h2>
                            <div className="grid min-h-[510px] place-items-center rounded-lg border border-dashed border-stone-200 bg-stone-50/70 p-6 dark:border-stone-800 dark:bg-stone-950/40">
                                <div className="w-full max-w-[760px]">
                                    <p className="mb-2 text-center text-xl font-semibold text-indigo-600">一张原图，生成两张场景变体</p>
                                    <p className="mb-6 text-center text-xs text-stone-500">主体不变 · 只换背景</p>
                                    <div className="grid grid-cols-1 items-center gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,2fr)]">
                                        <figure>
                                            <img src={demo.before} alt="原图：白底手链" className="aspect-square w-full rounded-lg object-cover shadow-sm" />
                                            <figcaption className="mt-2 text-center text-xs text-stone-500">原图</figcaption>
                                        </figure>
                                        <ArrowRight className="mx-auto size-7 rotate-90 text-indigo-600 sm:rotate-0" aria-hidden="true" />
                                        <div className="grid grid-cols-2 gap-3">
                                            {demo.after.map((url, index) => (
                                                <figure key={url}>
                                                    <img src={url} alt={`裂变效果 ${index + 1}：不同背景中的同款手链`} className="aspect-square w-full rounded-lg object-cover shadow-sm" />
                                                    <figcaption className="mt-2 text-center text-xs text-indigo-600">效果 {index + 1}</figcaption>
                                                </figure>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </section>
            </main>
            <Modal open={!!previewUrl} onCancel={() => setPreviewUrl("")} footer={null} width="min(90vw, 900px)" centered destroyOnHidden>
                <img src={previewUrl} alt="裂变大图" className="max-h-[78vh] w-full object-contain" />
            </Modal>
        </div>
    );
}
