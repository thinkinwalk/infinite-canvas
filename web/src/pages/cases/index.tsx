import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { App, Button, Card, Empty, Input, InputNumber, Modal, Popover, Segmented, Select, Spin, Tag } from "antd";
import { ArrowLeft, ArrowRight, Brush, CircleHelp, ClipboardPaste, Copy, Download, Eraser, ExternalLink, ImagePlus, Layers3, Play, Printer, RefreshCw, Scissors, Shirt, ShieldCheck, Stamp, Store, Upload, Wand2, Wind, X } from "lucide-react";
import { saveAs } from "file-saver";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { useCopyText } from "@/hooks/use-copy-text";
import { officialCaseItems } from "@/constant/create-catalog";
import { fetchCase, fetchCases, fetchCaseRunPrice, fetchTryonLibrary, runCase, type CaseApp, type CaseRunPrice, type TryonLibrary } from "@/services/api/cases";
import { fetchImageBlob } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { createProductSetZip } from "./product-set-download";
import CutoutWorkspace, { type CutoutResult } from "./cutout-workspace";
import PrintExtractWorkspace, { type PrintExtractResult } from "./print-extract-workspace";
import PrintFileWorkspace, { type PrintFileResult } from "./print-file-workspace";

type CaseValue = string | string[];
type CaseField = { key: string; label?: string; type?: string; required?: boolean; placeholder?: string; options?: string[]; defaultValue?: string; help?: string; display?: "buttons" | "select" };

function readFields(item: CaseApp): CaseField[] {
    try {
        const schema = JSON.parse(item.publicSchema || "{}") as { fields?: CaseField[] };
        const fields = Array.isArray(schema.fields) ? schema.fields : [];
        if (item.id === "official-dewatermark" && !fields.some((field) => field.key === "watermarkType")) {
            return [...fields, { key: "watermarkType", label: "水印类型", type: "select", required: true, options: ["通用", "文字", "Logo"], defaultValue: "通用" }];
        }
        if (item.id === "official-dewrinkle" && !fields.some((field) => field.key === "preserveTexture")) {
            return [...fields, { key: "preserveTexture", label: "保留纹理", type: "select", required: true, options: ["是", "否"], defaultValue: "是", display: "buttons" }];
        }
        if (item.id === "official-garment-extract" && !fields.some((field) => field.key === "detail")) {
            const detail: CaseField = { key: "detail", label: "保留细节", type: "select", display: "buttons", required: true, options: ["标准", "精细"], defaultValue: "标准", help: "标准：保留整体款式、颜色和主要面料结构。精细：加强缝线、纽扣、刺绣、纹理和边缘轮廓的还原。" };
            const imageIndex = fields.findIndex((field) => field.key === "imageUrl");
            return imageIndex < 0 ? [detail, ...fields] : [...fields.slice(0, imageIndex + 1), detail, ...fields.slice(imageIndex + 1)];
        }
        return fields;
    } catch {
        return [];
    }
}

function DewatermarkWorkspace({ values, onChange, upload, footer, busy, result }: { values: Record<string, CaseValue>; onChange: (changes: Record<string, CaseValue>) => void; upload: ReactNode; footer: ReactNode; busy: boolean; result: { source: string; url: string } | null }) {
    const demoImage = "/examples/workbench/product.jpg";
    const sourceImage = result?.source || demoImage;
    const outputImage = result?.url || demoImage;
    return <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="mb-6 flex items-center gap-3 border-b border-stone-200 pb-5 dark:border-stone-800"><Eraser className="size-6 text-blue-600" /><div><h1 className="text-xl font-semibold">去水印</h1><p className="mt-1 text-sm text-stone-500 dark:text-stone-400">移除图片中的文字、Logo 和覆盖元素，自然补全背景</p></div></div>
            <div className="grid min-w-0 gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
                <section className="flex min-w-0 flex-col gap-5 border-b border-stone-200 pb-6 lg:min-h-[560px] lg:border-b-0 lg:border-r lg:pr-6 dark:border-stone-800" aria-label="去水印参数">
                    <div><h2 className="mb-2 text-sm font-medium">上传图片</h2>{upload}</div>
                    <div className="space-y-2"><h2 className="text-sm font-medium">水印类型</h2><Segmented block options={["通用", "文字", "Logo"]} value={String(values.watermarkType || "通用")} disabled={busy} onChange={(value) => onChange({ watermarkType: String(value) })} /></div>
                    <div className="mt-auto">{footer}</div>
                </section>
                <section className="min-w-0" aria-label="处理结果">
                    <h2 className="mb-4 text-sm font-semibold">处理结果</h2>
                    <div className="flex min-h-[500px] flex-col justify-center gap-5">
                        <h3 className="text-center text-lg font-semibold text-blue-600">一键移除水印，保留原图细节</h3>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <figure className="overflow-hidden rounded-md border border-stone-200 dark:border-stone-700"><div className="relative aspect-square overflow-hidden bg-stone-100 dark:bg-stone-900"><img src={sourceImage} alt={result ? "上传原图" : "去水印演示原图"} className="size-full object-cover" />{!result ? <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rotate-[-18deg] rounded bg-black/65 px-4 py-2 text-xl font-semibold text-white/80">示例水印</span> : null}</div><figcaption className="p-2 text-center text-xs text-stone-500">{result ? "原图" : "演示原图"}</figcaption></figure>
                            <figure className="overflow-hidden rounded-md border border-blue-500 ring-2 ring-blue-100 dark:ring-blue-950/60"><div className="aspect-square overflow-hidden bg-stone-100 dark:bg-stone-900"><img src={outputImage} alt={result ? "去水印处理结果" : "去水印演示结果"} className="size-full object-cover" /></div><figcaption className="p-2 text-center text-xs text-blue-600">{result ? "处理结果" : "演示效果"}</figcaption></figure>
                        </div>
                        <p className="text-center text-xs text-stone-400">{result ? "已展示本次上传图片的处理结果。" : "演示案例仅用于展示处理流程；上传图片后生成结果会替换此处。"}</p>
                    </div>
                </section>
            </div>
        </div>
    </main>;
}

function DewrinkleWorkspace({ values, onChange, upload, footer, busy, result }: { values: Record<string, CaseValue>; onChange: (changes: Record<string, CaseValue>) => void; upload: ReactNode; footer: ReactNode; busy: boolean; result: { source: string; url: string } | null }) {
    const { message } = App.useApp();
    const [downloading, setDownloading] = useState(false);
    const sourceImage = result?.source || "/examples/dewrinkle/source.jpg";
    const strength = String(values.strength || "轻");
    const preserveTexture = String(values.preserveTexture || "是");
    const download = async () => {
        if (!result?.url) return;
        setDownloading(true);
        try {
            const blob = await fetchImageBlob(result.url);
            const extension = blob.type.split(";")[0].split("/")[1]?.replace("jpeg", "jpg") || "png";
            saveAs(blob, `服装去皱处理结果.${extension}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            setDownloading(false);
        }
    };
    return <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="mb-6 flex items-center gap-3 border-b border-stone-200 pb-5 dark:border-stone-800"><Wind className="size-6 text-violet-600" /><div><h1 className="text-xl font-semibold">服装去皱</h1><p className="mt-1 text-sm text-stone-500 dark:text-stone-400">去除衣物褶皱和拍摄瑕疵，保持面料纹理自然</p></div></div>
            <div className="grid min-w-0 gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
                <section className="flex min-w-0 flex-col gap-5 border-b border-stone-200 pb-6 lg:min-h-[560px] lg:border-b-0 lg:border-r lg:pr-6 dark:border-stone-800" aria-label="服装去皱参数">
                    <div><h2 className="mb-2 text-sm font-medium">上传图片 <span className="text-red-500">*</span></h2>{upload}</div>
                    <div className="space-y-2"><h2 className="text-sm font-medium">去皱强度</h2><div className="flex flex-wrap gap-2" role="group" aria-label="去皱强度">{["轻", "中", "强"].map((option) => <button key={option} type="button" disabled={busy} aria-pressed={strength === option} onClick={() => onChange({ strength: option })} className={`min-w-16 rounded-md px-4 py-2 text-sm transition ${strength === option ? "bg-violet-600 text-white shadow-sm" : "bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"}`}>{option}</button>)}</div></div>
                    <div className="space-y-2"><h2 className="text-sm font-medium">保留纹理</h2><div className="flex flex-wrap gap-2" role="group" aria-label="保留纹理">{["是", "否"].map((option) => <button key={option} type="button" disabled={busy} aria-pressed={preserveTexture === option} onClick={() => onChange({ preserveTexture: option })} className={`min-w-16 rounded-md px-4 py-2 text-sm transition ${preserveTexture === option ? "bg-violet-600 text-white shadow-sm" : "bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"}`}>{option}</button>)}</div></div>
                    <div><h2 className="mb-2 text-sm font-medium">处理要求</h2><Input.TextArea disabled={busy} autoSize={{ minRows: 3, maxRows: 5 }} placeholder="例如：轻度去皱，保留真实面料纹理" value={typeof values.prompt === "string" ? values.prompt : ""} onChange={(event) => onChange({ prompt: event.target.value })} /></div>
                    <div className="mt-auto">{footer}</div>
                </section>
                <section className="min-w-0" aria-label="处理结果">
                    <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">处理结果</h2>{result ? <Button size="small" icon={<Download className="size-4" />} loading={downloading} onClick={() => void download()}>下载图片</Button> : null}</div>
                    <div className="flex min-h-[500px] flex-col justify-center gap-5">
                        <h3 className="text-center text-lg font-semibold text-violet-600">衬衫去皱前后对比</h3>
                        <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                            <figure className="overflow-hidden rounded-lg border border-stone-200 dark:border-stone-700"><div className="aspect-[3/4] overflow-hidden bg-stone-100 dark:bg-stone-900"><img src={sourceImage} alt={result ? "上传原图" : "用户提供的褶皱衬衫示例图"} className="size-full object-contain" /></div><figcaption className="p-2 text-center text-xs text-stone-500">{result ? "原图" : "示例原图"}</figcaption></figure>
                            <ArrowRight className="mx-auto size-8 text-violet-600" />
                            <figure className="overflow-hidden rounded-lg border-2 border-violet-500 ring-2 ring-violet-100 dark:ring-violet-950/60"><div className="aspect-[3/4] overflow-hidden bg-stone-100 dark:bg-stone-900"><img src={result?.url || "/examples/dewrinkle/result.png"} alt={result ? "服装去皱处理结果" : "用户提供的平整衬衫示例图"} className="size-full object-contain" /></div><figcaption className="p-2 text-center text-xs text-violet-600">{result ? "处理结果" : "示例效果"}</figcaption></figure>
                        </div>
                        <p className="text-center text-xs text-stone-400">{result ? "已展示本次上传图片的处理结果。" : "图片由用户提供，用于演示前后对比；本站实际生成效果待验收。"}</p>
                    </div>
                </section>
            </div>
        </div>
    </main>;
}

function IpCheckWorkspace({ values, onChange, upload, footer, busy, result, onBack }: { values: Record<string, CaseValue>; onChange: (changes: Record<string, CaseValue>) => void; upload: ReactNode; footer: ReactNode; busy: boolean; result: unknown; onBack: () => void }) {
    const copyText = useCopyText();
    const resultText = extractText(result) || (result && typeof result === "object" ? JSON.stringify(result) || "" : "");
    const source = typeof values.imageUrl === "string" ? values.imageUrl : "";
    return <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="mb-5 flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400"><button type="button" className="hover:text-stone-950 dark:hover:text-white" onClick={onBack}>创作工具</button><span aria-hidden="true">›</span><span className="font-medium text-stone-900 dark:text-stone-100">侵权检测</span></div>
            <div className="grid min-w-0 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
                <section className="flex min-w-0 flex-col gap-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-950" aria-label="侵权检测参数">
                    <div className="flex items-start gap-3"><div className="grid size-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300"><ShieldCheck className="size-5" /></div><div><h1 className="text-lg font-semibold">侵权检测</h1><p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">快速筛查图片版权风险，规避商用侵权纠纷</p></div></div>
                    <div><h2 className="mb-2 text-sm font-medium">上传图片 <span className="text-red-500">*</span></h2>{upload}</div>
                    <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">AI 辅助筛查图片中的商标、品牌、名人肖像、知名 IP 等版权风险，再用于商用前先进行人工复核。</p>
                    <div className="mt-auto">{footer}</div>
                </section>
                <section className="min-w-0 rounded-xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-950 sm:p-7" aria-label="检测结果">
                    <h2 className="text-base font-semibold">检测结果</h2>
                    {resultText ? (
                        <div className="mt-5 space-y-5">
                            {source ? <div><h3 className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">本次检测图片</h3><img src={source} alt="本次检测原图" className="max-h-52 max-w-full rounded-md border border-stone-200 bg-stone-50 object-contain dark:border-stone-700 dark:bg-stone-900" /></div> : null}
                            <CaseTextResult title="侵权检测" text={resultText} copyText={copyText} />
                        </div>
                    ) : busy ? (
                        <div className="flex min-h-[460px] items-center justify-center"><Spin tip="正在识别风险"><div className="h-20 w-40" /></Spin></div>
                    ) : source ? (
                        <div className="mt-5 flex min-h-[460px] flex-col items-center justify-center gap-4 text-center">
                            <img src={source} alt="待检测原图" className="max-h-64 max-w-full rounded-md border border-stone-200 bg-stone-50 object-contain dark:border-stone-700 dark:bg-stone-900" />
                            <div><p className="text-sm font-medium">图片已就绪</p><p className="mt-1 text-sm text-stone-500 dark:text-stone-400">开始检测后，这里将显示风险等级、疑似对象和复核建议</p></div>
                        </div>
                    ) : <IpCheckGuide />}
                </section>
            </div>
        </div>
    </main>;
}

function TryonWorkspace({ values, onChange, footer, busy, result }: { values: Record<string, CaseValue>; onChange: (changes: Record<string, CaseValue>) => void; footer: ReactNode; busy: boolean; result: unknown }) {
    const [library, setLibrary] = useState<TryonLibrary>({ models: [], scenes: [] });
    const [picker, setPicker] = useState<"model" | "scene" | null>(null);
    const [libraryError, setLibraryError] = useState("");
    const [filter, setFilter] = useState("全部");
    const [genderFilter, setGenderFilter] = useState("全部");
    useEffect(() => { void fetchTryonLibrary().then(setLibrary).catch(() => setLibraryError("素材库加载失败，请刷新页面重试")); }, []);
    const top = typeof values.topImageUrl === "string" ? values.topImageUrl : "";
    const bottom = typeof values.bottomImageUrl === "string" ? values.bottomImageUrl : "";
    const model = library.models.find((item) => item.url === values.modelImageUrl);
    const scene = library.scenes.find((item) => item.url === values.sceneImageUrl);
    const sourceImages = [top, bottom, model?.url || "", scene?.url || ""].filter(Boolean);
    const upload = (key: "topImageUrl" | "bottomImageUrl", label: string) => {
        const isTop = key === "topImageUrl";
        const filled = Boolean(values[key]);
        return <div className={`rounded-lg border-2 p-2 transition-colors ${isTop ? "border-pink-400/80 bg-pink-50/50 dark:border-pink-500/70 dark:bg-pink-950/15" : "border-sky-400/80 bg-sky-50/50 dark:border-sky-500/70 dark:bg-sky-950/15"}`}>
            <div className="mb-2 flex items-center justify-between gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-semibold ${isTop ? "bg-pink-500 text-white" : "bg-sky-500 text-white"}`}>{label}</span>
                <span className={`text-[11px] ${filled ? (isTop ? "text-pink-600 dark:text-pink-300" : "text-sky-600 dark:text-sky-300") : "text-stone-500 dark:text-stone-400"}`}>{filled ? "已上传" : "待上传"}</span>
            </div>
            <CaseImageInput compact field={{ key, label, type: "image" }} value={values[key]} disabled={busy} onChange={(value) => onChange({ [key]: value })} />
        </div>;
    };
    const options = picker === "model" ? library.models.filter((item) => (filter === "全部" || item.group === filter) && (genderFilter === "全部" || item.gender === genderFilter)) : library.scenes.filter((item) => filter === "全部" || item.env === filter);
    const openPicker = (type: "model" | "scene") => { setFilter("全部"); setGenderFilter("全部"); setPicker(type); };
    return <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="mb-6 flex items-center gap-3 border-b border-stone-200 pb-5 dark:border-stone-800"><Shirt className="size-6 text-pink-600" /><div><h1 className="text-xl font-semibold">服装上身</h1><p className="mt-1 text-sm text-stone-500 dark:text-stone-400">上传服装，选择模特和场景，一键生成真实上身电商图</p></div></div>
            <div className="grid min-w-0 gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
                <section className="flex min-w-0 flex-col gap-5 border-b border-stone-200 pb-6 lg:border-b-0 lg:border-r lg:pr-6 dark:border-stone-800" aria-label="服装上身参数">
                    <div><h2 className="mb-2 text-sm font-medium">服装图 <span className="text-xs font-normal text-stone-500">（上装/下装可只传一个）</span></h2><div className="grid grid-cols-2 gap-3"><div>{upload("topImageUrl", "上装")}</div><div>{upload("bottomImageUrl", "下装")}</div></div></div>
                    <div className="relative"><button type="button" disabled={busy} onClick={() => openPicker("scene")} className="flex w-full items-center gap-3 rounded-md border border-stone-200 p-2.5 text-left transition hover:border-blue-500 dark:border-stone-700"><div className="size-14 shrink-0 overflow-hidden rounded bg-stone-100 dark:bg-stone-800">{scene ? <img src={scene.thumb || scene.url} alt={scene.name} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-stone-400"><ImagePlus className="size-5" /></div>}</div><span><span className="block text-sm font-medium">场景</span><span className="block text-xs text-stone-500">{scene?.name || "从库中选择"}</span></span></button>{scene ? <button type="button" title="清除场景" aria-label="清除场景" disabled={busy} onClick={() => onChange({ sceneImageUrl: "" })} className="absolute right-2 top-2 grid size-6 place-items-center rounded bg-black/50 text-white"><X className="size-3.5" /></button> : null}</div>
                    <div className="relative"><button type="button" disabled={busy} onClick={() => openPicker("model")} className="flex w-full items-center gap-3 rounded-md border border-stone-200 p-2.5 text-left transition hover:border-blue-500 dark:border-stone-700"><div className="size-14 shrink-0 overflow-hidden rounded bg-stone-100 dark:bg-stone-800">{model ? <img src={model.thumb || model.url} alt={model.name} className="size-full object-cover" /> : <div className="grid size-full place-items-center text-stone-400"><ImagePlus className="size-5" /></div>}</div><span><span className="block text-sm font-medium">模特</span><span className="block text-xs text-stone-500">{model?.name || "从库中选择"}</span></span></button>{model ? <button type="button" title="清除模特" aria-label="清除模特" disabled={busy} onClick={() => onChange({ modelImageUrl: "" })} className="absolute right-2 top-2 grid size-6 place-items-center rounded bg-black/50 text-white"><X className="size-3.5" /></button> : null}</div>
                    <div><h2 className="mb-2 text-sm font-medium">描述 <span className="text-xs font-normal text-stone-500">（可留空）</span></h2><Input.TextArea disabled={busy} autoSize={{ minRows: 3, maxRows: 5 }} placeholder="例如：自然站姿，完整展示服装细节" value={typeof values.prompt === "string" ? values.prompt : ""} onChange={(event) => onChange({ prompt: event.target.value })} /></div>
                    <div className="mt-auto">{footer}</div>
                </section>
                <section className="min-w-0" aria-label="试穿结果"><h2 className="mb-4 text-sm font-semibold">试穿效果</h2>{result !== null ? <CaseResult value={result} title="服装上身" sources={sourceImages} /> : <div className="flex min-h-[500px] flex-col items-center justify-center gap-5"><h3 className="text-center text-lg font-semibold text-blue-600">模特 + 服装，一键虚拟试穿上身</h3><div className="grid w-full max-w-2xl items-center gap-4 sm:grid-cols-[minmax(150px,220px)_auto_minmax(150px,220px)]"><figure className="overflow-hidden rounded-md border border-stone-200 dark:border-stone-700"><div className="aspect-[3/4] bg-stone-100 dark:bg-stone-900"><img src="/examples/tryon/source.webp" alt="服装上身示例原图" className="size-full object-contain" /></div><figcaption className="p-2 text-center text-xs text-stone-500">原图</figcaption></figure><ArrowRight className="mx-auto size-8 text-blue-600" /><figure className="overflow-hidden rounded-md border-2 border-blue-500"><div className="aspect-[3/4] bg-stone-100 dark:bg-stone-900"><img src="/examples/tryon/result.webp" alt="服装上身示例效果" className="size-full object-cover" /></div><figcaption className="p-2 text-center text-xs text-blue-600">效果</figcaption></figure></div><p className="text-center text-xs text-stone-400">示例来自同一次服装上身处理；上传服装并生成后，这里会替换为本次结果</p></div>}</section>
            </div>
        </div>
        <Modal open={picker !== null} title={picker === "model" ? "选择模特" : "选择场景"} footer={null} onCancel={() => setPicker(null)} width={760} destroyOnClose>
            {libraryError ? <p className="mb-3 text-sm text-red-600">{libraryError}</p> : null}
            <div className="mb-4 flex flex-wrap gap-2">{(picker === "scene" ? ["全部", "室内", "户外", "街景", "影棚", "度假"] : ["全部", "cn", "jp", "kr", "intl"]).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded px-3 py-1.5 text-xs ${filter === value ? "bg-blue-600 text-white" : "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200"}`}>{({ cn: "中国", jp: "日本", kr: "韩国", intl: "其他" } as Record<string, string>)[value] || value}</button>)}</div>
            {picker === "model" ? <div className="mb-4 flex gap-2">{[["全部", "全部"], ["f", "女模"], ["m", "男模"]].map(([value, label]) => <button key={value} type="button" aria-pressed={genderFilter === value} onClick={() => setGenderFilter(value)} className={`rounded px-3 py-1.5 text-xs ${genderFilter === value ? "bg-blue-600 text-white" : "bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200"}`}>{label}</button>)}</div> : null}
            <div className="grid max-h-[55vh] grid-cols-3 gap-3 overflow-auto sm:grid-cols-5">{options.map((item) => { const active = item.url === (picker === "model" ? values.modelImageUrl : values.sceneImageUrl); return <button key={item.id} type="button" className={`overflow-hidden rounded-md border text-left ${active ? "border-blue-500 ring-2 ring-blue-100" : "border-stone-200 dark:border-stone-700"}`} onClick={() => { onChange(picker === "model" ? { modelImageUrl: item.url } : { sceneImageUrl: item.url }); setPicker(null); }}><img src={item.thumb || item.url} alt={item.name} className="aspect-square w-full object-cover" /><span className="block truncate px-2 py-1.5 text-xs">{item.name}</span></button>; })}</div>
        </Modal>
    </main>;
}

function IpCheckGuide() {
    const examples = [
        { label: "高风险", icon: ShieldCheck, color: "bg-pink-100 text-pink-600 dark:bg-pink-950/30 dark:text-pink-300", badge: "bg-rose-500" },
        { label: "中风险", icon: CircleHelp, color: "bg-violet-100 text-violet-600 dark:bg-violet-950/30 dark:text-violet-300", badge: "bg-orange-500" },
        { label: "低风险", icon: ImagePlus, color: "bg-lime-100 text-lime-700 dark:bg-lime-950/30 dark:text-lime-300", badge: "bg-lime-600" },
    ];
    return <div className="flex min-h-[500px] flex-col items-center justify-center gap-6 text-center"><h3 className="text-xl font-semibold text-indigo-600 dark:text-indigo-300">看图识版权 / IP 侵权风险</h3><div className="grid w-full max-w-[570px] grid-cols-3 gap-3">{examples.map(({ label, icon: Icon, color, badge }) => <div key={label} className={`relative aspect-square overflow-hidden rounded-xl border border-stone-200 ${color} dark:border-stone-700`}><div className="grid size-full place-items-center"><Icon className="size-16 opacity-70" /></div><span className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-medium text-white ${badge}`}>{label}</span></div>)}</div><p className="text-xs text-stone-400">上传图片后，这里将展示本次检测的原图和风险结果</p></div>;
}

function readDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        if (!file.type.startsWith("image/")) return reject(new Error("请选择图片文件"));
        if (file.size > 10 * 1024 * 1024) return reject(new Error("单张图片不能超过 10MB"));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });
}

function extractMedia(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(extractMedia);
    if (typeof value === "string") return /^(data:image\/|https?:\/\/|blob:|\/api\/media\/references\/)/i.test(value) ? [value] : [];
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (typeof record.b64_json === "string" && record.b64_json) return [`data:image/png;base64,${record.b64_json}`];
    if (record.type === "image_generation_call" && typeof record.result === "string") return [`data:image/png;base64,${record.result}`];
    return ["url", "image_url", "result_url", "output", "data", "images"].flatMap((key) => extractMedia(record[key]));
}

function extractText(value: unknown): string {
    if (typeof value === "string") return /^(data:image\/|https?:\/\/|blob:|\/api\/media\/references\/)/i.test(value) ? "" : value;
    if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n\n");
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    for (const key of ["output_text", "text", "choices", "message", "content", "output", "data"]) {
        const text = extractText(record[key]);
        if (text) return text;
    }
    return "";
}

function parseJsonText(text: string): Record<string, unknown> | null {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
        const value = JSON.parse(cleaned) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function CaseTextResult({ title, text, copyText }: { title: string; text: string; copyText: (text: string) => void }) {
    const parsed = parseJsonText(text);
    if (title.includes("标题") && parsed && Array.isArray(parsed.titles)) {
        const titles = parsed.titles.filter((item): item is string => typeof item === "string");
        const points = Array.isArray(parsed.sellingPoints) ? parsed.sellingPoints.filter((item): item is string => typeof item === "string") : [];
        return <div className="space-y-4">
            <div className="space-y-2">{titles.map((item, index) => <div key={index} className="flex items-start gap-3 rounded-md border border-stone-200 p-3 dark:border-stone-700"><span className="font-mono text-xs text-stone-400">{index + 1}</span><span className="min-w-0 flex-1 break-words text-sm leading-6">{item}</span><Button type="text" size="small" icon={<Copy className="size-3.5" />} title="复制标题" aria-label="复制标题" onClick={() => copyText(item)} /></div>)}</div>
            {points.length ? <div><h3 className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">卖点短语</h3><div className="flex flex-wrap gap-2">{points.map((item, index) => <Button key={index} size="small" icon={<Copy className="size-3" />} onClick={() => copyText(item)}>{item}</Button>)}</div></div> : null}
        </div>;
    }
    if (title.includes("侵权") && parsed) {
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        return <div className="space-y-3">
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20"><p className="font-semibold">{String(parsed.riskLabel || parsed.risk || "风险筛查结果")}</p><p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-300">{String(parsed.summary || "")}</p></div>
            {items.length ? <div className="space-y-2"><h3 className="text-sm font-medium text-stone-500 dark:text-stone-400">风险点</h3>{items.map((item, index) => { const entry = item && typeof item === "object" ? item as Record<string, unknown> : null; return <div key={index} className="rounded-md border border-stone-200 p-3 text-sm dark:border-stone-700"><strong>{entry ? String(entry.name || "风险") : String(item)}</strong>{entry?.reason ? `：${String(entry.reason)}` : ""}</div>; })}</div> : null}
            {parsed.advice ? <div className="rounded-md bg-stone-100 p-3 text-sm leading-6 dark:bg-stone-800">商用建议：{String(parsed.advice)}</div> : null}
            <p className="text-xs text-stone-500">AI 辅助筛查，仅供人工复核，不构成法律意见。</p>
        </div>;
    }
    return <div className="whitespace-pre-wrap break-words text-sm leading-7">{text}</div>;
}

function TitleGenerationGuide() {
    const titles = [
        ["京东/淘宝", "阿玛番茄酱 经典原味番茄沙司 320g，酸甜浓郁，拌面蘸食都好吃"],
        ["Amazon", "Amara Classic Tomato Ketchup 320g | Rich Tomato Flavor for Dipping, Cooking and Everyday Meals"],
        ["TEMU", "经典番茄沙司 320g - 浓郁番茄风味，拌面蘸薯条，家常料理好搭档"],
    ];
    return <div className="flex min-h-80 flex-col items-center justify-center gap-4 py-8 text-center">
        <h3 className="text-lg font-semibold text-blue-600">看图识卖点，一键出爆款营销标题</h3>
        <div className="grid w-full max-w-2xl items-center gap-4 sm:grid-cols-[minmax(150px,220px)_auto_minmax(260px,1fr)]">
            <figure className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
                <img src="/examples/workbench/product.jpg" alt="标题生成示例商品图" className="aspect-square w-full object-cover" />
                <figcaption className="p-2 text-xs text-stone-500">原图</figcaption>
            </figure>
            <ArrowRight className="mx-auto size-7 text-blue-600" />
            <div className="rounded-lg border-2 border-blue-500 bg-white p-3 text-left shadow-sm dark:bg-stone-950">
                {titles.map(([platform, title]) => <div key={platform} className="border-b border-stone-200 py-2.5 last:border-b-0 dark:border-stone-700">
                    <div className="mb-1 text-xs font-semibold text-amber-700 dark:text-amber-300">{platform}</div>
                    <p className="text-xs leading-5 text-stone-700 dark:text-stone-200">{title}</p>
                </div>)}
            </div>
        </div>
        <p className="text-xs text-stone-400">上传商品图并填写卖点后，生成结果会显示在这里</p>
    </div>;
}

function CaseImageInput({ field, value, disabled, onChange, compact = false }: { field: CaseField; value: CaseValue | undefined; disabled: boolean; onChange: (value: CaseValue) => void; compact?: boolean }) {
    const { message } = App.useApp();
    const [dragging, setDragging] = useState(false);
    const [reading, setReading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const dragDepth = useRef(0);
    const multiple = field.type === "images";
    const urls = Array.isArray(value) ? value : value ? [value] : [];
    const addFiles = async (files: File[]) => {
        if (disabled || reading || !files.length) return;
        setReading(true);
        try {
            const next = await Promise.all(files.slice(0, multiple ? 4 : 1).map(readDataUrl));
            onChange(multiple ? [...urls, ...next].slice(0, 4) : next[0] || "");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片读取失败");
        } finally {
            setReading(false);
        }
    };
    const addClipboardFiles = async () => {
        if (disabled || reading) return;
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) throw new Error("剪切板里没有可读取的图片");
            await addFiles(blobs.map((blob, index) => new File([blob], `clipboard-${index + 1}.png`, { type: blob.type || "image/png" })));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "剪切板读取失败");
        }
    };
    return (
        <div className={compact ? "relative" : "space-y-3"}>
            <button
                type="button"
                disabled={disabled || reading}
                onClick={() => inputRef.current?.click()}
                onDragEnter={(event) => {
                    event.preventDefault();
                    dragDepth.current++;
                    if (!disabled) setDragging(true);
                }}
                onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
                }}
                onDragLeave={(event) => {
                    event.preventDefault();
                    if (--dragDepth.current <= 0) setDragging(false);
                }}
                onDrop={(event) => {
                    event.preventDefault();
                    dragDepth.current = 0;
                    setDragging(false);
                    void addFiles(Array.from(event.dataTransfer.files));
                }}
                title={compact ? "上传或替换图片" : undefined}
                aria-label={compact ? "上传或替换图片" : undefined}
                className={`relative flex ${compact ? "h-40 w-full overflow-hidden px-4" : "min-h-32 w-full px-4"} flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center text-sm transition disabled:cursor-wait ${dragging ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300" : "border-stone-300 bg-stone-50 text-stone-600 hover:border-blue-400 dark:border-stone-700 dark:bg-stone-900/50 dark:text-stone-300"}`}
            >
                {compact && urls[0] ? <>
                    <img src={urls[0]} alt={field.label || "待处理图片"} draggable={false} className="absolute inset-0 size-full object-contain p-3" />
                    <span className="absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{reading ? "读取中…" : dragging ? "松开替换" : "替换"}</span>
                </> : <><Upload className={compact ? "size-6" : "size-5"} /><span>{reading ? "读取中…" : dragging ? "松开即可上传" : multiple ? "拖拽或点击上传参考图（最多 4 张）" : "点击或拖拽上传图片"}</span><span className="text-xs text-stone-500 dark:text-stone-400">PNG、JPG、WebP，单张不超过 10MB</span></>}
            </button>
            <button
                type="button"
                disabled={disabled || reading}
                onClick={() => void addClipboardFiles()}
                className="mx-auto mt-2 inline-flex items-center gap-1.5 text-xs text-stone-500 transition hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
                <ClipboardPaste className="size-3.5" />
                从剪切板上传
            </button>
            <input
                ref={inputRef}
                className="hidden"
                type="file"
                accept="image/*"
                multiple={multiple}
                disabled={disabled || reading}
                onChange={(event) => {
                    void addFiles(Array.from(event.target.files || []));
                    event.target.value = "";
                }}
            />
            {compact && urls.length ? <button type="button" title="移除图片" aria-label="移除图片" className="absolute right-2 top-2 grid size-7 place-items-center rounded bg-black/70 text-white hover:bg-black/80 disabled:cursor-not-allowed" disabled={disabled || reading} onClick={() => onChange("")}><X className="size-4" /></button> : null}
            {!compact && urls.length ? (
                <div className="grid grid-cols-4 gap-2">
                    {urls.map((url, index) => (
                        <div key={index} className="relative aspect-square overflow-hidden rounded-md border border-stone-200 dark:border-stone-700">
                            <img src={url} alt={`${field.label || "参考图"} ${index + 1}`} className="size-full object-cover" />
                            <button
                                type="button"
                                title="移除图片"
                                aria-label="移除图片"
                                disabled={disabled}
                                className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                                onClick={() => onChange(multiple ? urls.filter((_, itemIndex) => itemIndex !== index) : "")}
                            >
                                <X className="size-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function CaseMaskInput({ source, value, disabled, onChange, large = false }: { source: string; value: CaseValue | undefined; disabled: boolean; onChange: (value: CaseValue) => void; large?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const maskRef = useRef<HTMLCanvasElement>(null);
    const drawing = useRef(false);
    const [brush, setBrush] = useState(36);
    useEffect(() => {
        const canvas = canvasRef.current;
        const mask = maskRef.current;
        if (!canvas || !mask || !source) return;
        const image = new Image();
        image.onload = () => {
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            mask.width = image.naturalWidth;
            mask.height = image.naturalHeight;
            const context = canvas.getContext("2d");
            const maskContext = mask.getContext("2d");
            if (context) {
                context.clearRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0);
            }
            if (maskContext) {
                maskContext.globalCompositeOperation = "source-over";
                maskContext.fillStyle = "white";
                maskContext.fillRect(0, 0, mask.width, mask.height);
            }
        };
        image.src = source;
    }, [source]);
    const point = (event: PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        // The canvas bitmap is rendered with object-contain, so account for the
        // letterboxed area before converting the pointer into bitmap pixels.
        const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
        const renderedWidth = canvas.width * scale;
        const renderedHeight = canvas.height * scale;
        const offsetX = (rect.width - renderedWidth) / 2;
        const offsetY = (rect.height - renderedHeight) / 2;
        const x = Math.max(0, Math.min(canvas.width, (event.clientX - rect.left - offsetX) / scale));
        const y = Math.max(0, Math.min(canvas.height, (event.clientY - rect.top - offsetY) / scale));
        return { x, y, r: brush / scale };
    };
    const paint = (event: PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        const mask = maskRef.current;
        const maskContext = mask?.getContext("2d");
        const next = point(event);
        if (!canvas || !context || !mask || !maskContext || !next) return;
        context.fillStyle = "rgba(255,255,255,0.75)";
        context.beginPath();
        context.arc(next.x, next.y, next.r, 0, Math.PI * 2);
        context.fill();
        maskContext.globalCompositeOperation = "destination-out";
        maskContext.beginPath();
        maskContext.arc(next.x, next.y, next.r, 0, Math.PI * 2);
        maskContext.fill();
        onChange(mask.toDataURL("image/png"));
    };
    return (
        <div className="space-y-2">
            <canvas ref={maskRef} className="hidden" />
            {source ? (
                <canvas
                    ref={canvasRef}
                    className={`${large ? "max-h-[min(68vh,680px)] min-h-[420px]" : "max-h-72"} w-full cursor-crosshair rounded-md border border-dashed border-stone-300 object-contain dark:border-stone-700`}
                    onPointerDown={(event) => {
                        if (disabled) return;
                        drawing.current = true;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        paint(event);
                    }}
                    onPointerMove={(event) => drawing.current && paint(event)}
                    onPointerUp={() => { drawing.current = false; }}
                    onPointerCancel={() => { drawing.current = false; }}
                />
            ) : <p className="rounded-md border border-dashed p-4 text-sm text-stone-500">请先上传原始图片</p>}
            <div className="flex items-center justify-between text-xs text-stone-500">
                <label>笔刷 {brush}px <input type="range" min="8" max="100" value={brush} disabled={disabled || !source} onChange={(event) => setBrush(Number(event.target.value))} /></label>
                <Button size="small" disabled={disabled || !source} onClick={() => {
                    const canvas = canvasRef.current;
                    if (!canvas || !source) return;
                    const image = new Image();
                    image.onload = () => {
                        const context = canvas.getContext("2d");
                        context?.clearRect(0, 0, canvas.width, canvas.height);
                        context?.drawImage(image, 0, 0);
                        const maskContext = maskRef.current?.getContext("2d");
                        if (maskContext) {
                            maskContext.globalCompositeOperation = "source-over";
                            maskContext.fillStyle = "white";
                            maskContext.fillRect(0, 0, canvas.width, canvas.height);
                        }
                        onChange("");
                    };
                    image.src = source;
                }}>清除蒙版</Button>
            </div>
            {value ? <p className="text-xs text-green-600 dark:text-green-400">已标记修改区域</p> : <p className="text-xs text-stone-500">在图片上涂抹需要修改的区域</p>}
        </div>
    );
}

function CaseResult({ value, title, sources, compare = false }: { value: unknown; title: string; sources: string[]; compare?: boolean }) {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [downloading, setDownloading] = useState(false);
    const media = extractMedia(value);
    const text = extractText(value);
    const batch = value && typeof value === "object" ? (value as { total?: number; failed?: number }) : {};
    const download = async () => {
        setDownloading(true);
        try {
            if (media.length === 1) {
                const blob = await fetchImageBlob(media[0]);
                const extension = blob.type.split(";")[0].split("/")[1]?.replace("jpeg", "jpg") || "png";
                saveAs(blob, `${title}.${extension}`);
            } else
                saveAs(
                    await createProductSetZip(
                        media.map((url, index) => ({ url, index: index + 1, title })),
                        fetchImageBlob,
                    ),
                    `${title}.zip`,
                );
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            setDownloading(false);
        }
    };
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{media.length ? `生成完成 · ${media.length}${batch.total ? `/${batch.total}` : ""} 张` : "生成结果"}</h2>
                <div className="flex gap-2">
                    {text ? (
                        <Button icon={<Copy className="size-4" />} onClick={() => copyText(text)}>
                            复制结果
                        </Button>
                    ) : null}
                    {media.length ? (
                        <Button icon={<Download className="size-4" />} loading={downloading} onClick={() => void download()}>
                            {media.length > 1 ? "一键下载" : "下载图片"}
                        </Button>
                    ) : null}
                </div>
            </div>
            {sources.length && !compare ? (
                <div>
                    <h3 className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">原图</h3>
                    <div className="flex flex-wrap gap-2">
                        {sources.map((url, index) => (
                            <img key={index} src={url} alt={`原图 ${index + 1}`} className="size-24 rounded-md border border-stone-200 bg-stone-50 object-contain dark:border-stone-700 dark:bg-stone-900" />
                        ))}
                    </div>
                </div>
            ) : null}
            {media.length ? (
                <div>
                    {!compare ? <h3 className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">处理结果</h3> : null}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {compare && sources[0] ? <figure className="min-w-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-700"><img src={sources[0]} alt="本次上传的模特服装原图" className="aspect-[4/5] w-full bg-stone-50 object-contain dark:bg-stone-900" /><figcaption className="p-2 text-center text-xs text-stone-500">原图</figcaption></figure> : null}
                        {media.map((url, index) => (
                            <a key={index} href={url} target="_blank" rel="noreferrer" title={`查看结果 ${index + 1}`} className="overflow-hidden rounded-md border border-stone-200 dark:border-stone-700">
                                <img src={url} alt={`处理结果 ${index + 1}`} className={`${compare ? "aspect-[4/5]" : "aspect-square"} w-full bg-stone-50 object-contain dark:bg-stone-900`} />
                                {compare ? <div className="p-2 text-center text-xs text-violet-600">效果</div> : null}
                            </a>
                        ))}
                    </div>
                </div>
            ) : null}
            {batch.failed ? <p className="text-sm text-red-600 dark:text-red-400">{batch.failed} 张生成失败，对应模型算力点已退回。</p> : null}
            {text ? <CaseTextResult title={title} text={text} copyText={copyText} /> : null}
            {!media.length && !text ? <Empty description="模型未返回可展示的图片或文本" /> : null}
        </div>
    );
}

function InpaintUsageGuide() {
    return (
        <div className="w-full max-w-3xl rounded-lg border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-950 sm:p-8">
            <div className="text-center">
                <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                    <Brush className="size-5" />
                </div>
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">使用介绍</h2>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">上传图片，涂抹衣服区域，再描述想要修改的颜色或款式</p>
            </div>
            <div className="mt-7 grid gap-5 sm:grid-cols-3">
                <InpaintGuideStep image="/examples/inpaint/source.png" title="1. 上传原图" />
                <InpaintGuideStep image="/examples/inpaint/mask.png" title="2. 涂抹红色衣服区域" />
                <InpaintGuideStep image="/examples/inpaint/result.png" title="3. 生成换色结果" result />
            </div>
        </div>
    );
}

function InpaintGuideStep({ image, title, result = false }: { image: string; title: string; result?: boolean }) {
    return (
        <div className="min-w-0 text-center">
            <div className={`relative mx-auto aspect-[4/5] w-full max-w-[150px] overflow-hidden rounded-lg border ${result ? "border-blue-500 ring-2 ring-blue-100 dark:ring-blue-950/60" : "border-stone-200 dark:border-stone-700"}`}>
                <img src={image} alt="局部改图示例" className="size-full object-cover" />
            </div>
            <p className="mt-2 text-sm font-medium text-stone-700 dark:text-stone-200">{title}</p>
        </div>
    );
}

function FusionUsageGuide() {
    return (
        <div className="w-full max-w-4xl rounded-lg border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-950 sm:p-8">
            <div className="text-center">
                <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                    <Layers3 className="size-5" />
                </div>
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">融图可以做什么</h2>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">保留主体商品，将参考图的场景、构图、色彩或质感融入新画面</p>
            </div>
            <div className="mt-7 grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
                <FusionGuideImage src="/examples/fusion/subject.jpg" label="1. 主体商品" />
                <ArrowRight className="mx-auto hidden size-5 text-stone-400 sm:block" />
                <FusionGuideImage src="/examples/fusion/reference.jpg" label="2. 场景或风格参考" />
                <ArrowRight className="mx-auto hidden size-5 text-stone-400 sm:block" />
                <FusionGuideImage src="/examples/fusion/result.png" label="3. 本站融合结果" result />
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-stone-500 dark:text-stone-400">
                <span>商品换场景</span><span>统一光影材质</span><span>参考视觉风格</span><span>生成多版构图</span>
            </div>
            <p className="mt-4 text-center text-sm text-stone-600 dark:text-stone-300">示例目标：保留番茄酱瓶身和标签，融合水彩画面的色彩、留白与笔触</p>
            <p className="mt-4 text-center text-xs text-stone-400">以上三张来自本站同一次真实融图运行，实际结果会随模型和上传素材变化</p>
        </div>
    );
}

function FusionGuideImage({ src, label, result = false }: { src: string; label: string; result?: boolean }) {
    return (
        <div className="min-w-0 text-center">
            <img src={src} alt={label} className={`aspect-square w-full rounded-md border bg-stone-50 object-cover dark:bg-stone-900 ${result ? "border-blue-500 ring-2 ring-blue-100 dark:ring-blue-950/60" : "border-stone-200 dark:border-stone-700"}`} />
            <p className="mt-2 text-sm font-medium text-stone-700 dark:text-stone-200">{label}</p>
        </div>
    );
}

function UpscaleUsageGuide() {
    const demoImage = "/examples/workbench/product.jpg";
    return (
        <div className="w-full max-w-4xl rounded-lg border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-950 sm:p-8">
            <div className="text-center">
                <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                    <Wand2 className="size-5" />
                </div>
                <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">使用案例演示</h2>
                <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">放大图片的同时补足细节，适合商品图、旧照片和印刷素材</p>
            </div>
            <div className="mt-7 grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
                <UpscaleGuideImage src={demoImage} label="1. 低清原图" muted />
                <ArrowRight className="mx-auto size-5 text-stone-400" />
                <UpscaleGuideImage src={demoImage} label="2. AI 变清晰 · 2x / 4x" result />
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-stone-500 dark:text-stone-400">
                <span>保留构图与颜色</span><span>增强边缘细节</span><span>支持人像与商品</span>
            </div>
            <p className="mt-4 text-center text-xs text-stone-400">上传图片后，右侧示例会替换为本次处理结果</p>
        </div>
    );
}

function UpscaleGuideImage({ src, label, muted = false, result = false }: { src: string; label: string; muted?: boolean; result?: boolean }) {
    return (
        <div className="min-w-0 text-center">
            <div className={`relative aspect-square w-full overflow-hidden rounded-md border bg-stone-50 dark:bg-stone-900 ${result ? "border-blue-500 ring-2 ring-blue-100 dark:ring-blue-950/60" : "border-stone-200 dark:border-stone-700"}`}>
                <img src={src} alt={label} className={`size-full object-cover ${muted ? "scale-[1.02] opacity-80 blur-[1.5px] saturate-[.78]" : ""}`} />
                {muted ? <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[11px] text-white">细节不足</span> : null}
            </div>
            <p className={`mt-2 text-sm font-medium ${result ? "text-blue-600" : "text-stone-700 dark:text-stone-200"}`}>{label}</p>
        </div>
    );
}

function GarmentExtractGuide({ source }: { source?: string }) {
    const sourceImage = source || "/examples/garment-extract/source.jpg";
    const demoImage = "/examples/garment-extract/result.png";
    return (
        <div className="w-full max-w-3xl">
            <h2 className="mb-5 text-base font-semibold">处理结果</h2>
            <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <figure className="min-w-0">
                    <div className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
                        <img src={sourceImage} alt="服装提取示例原图" className="size-full object-contain" />
                    </div>
                    <figcaption className="mt-2 text-center text-xs text-stone-500">原图</figcaption>
                </figure>
                <ArrowRight className="mx-auto size-6 text-violet-600" />
                <figure className="min-w-0">
                    <div className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-md border-2 border-violet-500 bg-stone-50 ring-2 ring-violet-100 dark:bg-stone-900 dark:ring-violet-950/60"><img src={demoImage} alt="服装提取示例效果" className="size-full object-contain" /></div>
                    <figcaption className="mt-2 text-center text-xs text-stone-500">效果</figcaption>
                </figure>
            </div>
            <p className="mt-5 text-center text-xs text-stone-400">本站真实运行示例；上传图片后会替换为本次原图和结果</p>
        </div>
    );
}

export default function CasesPage() {
    const { message, modal } = App.useApp();
    const token = useUserStore((state) => state.token);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const caseId = searchParams.get("case") || (location.pathname === "/ipcheck" ? "official-ip-check" : "");
    const activeCase = useRef(caseId);
    activeCase.current = caseId;
    const [items, setItems] = useState<CaseApp[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState("");
    const [selected, setSelected] = useState<CaseApp | null>(null);
    const [values, setValues] = useState<Record<string, CaseValue>>({});
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<unknown>(null);
    const [cutoutResult, setCutoutResult] = useState<CutoutResult | null>(null);
    const [printExtractResult, setPrintExtractResult] = useState<PrintExtractResult | null>(null);
    const [printFileResult, setPrintFileResult] = useState<PrintFileResult | null>(null);
    const [quote, setQuote] = useState<CaseRunPrice | null>(null);
    const [quoteError, setQuoteError] = useState("");
    const [quoting, setQuoting] = useState(false);
    const [checking, setChecking] = useState(false);

    const load = useCallback(async () => {
        const id = caseId;
        setLoading(true);
        setLoadError("");
        setSelected(null);
        setValues({});
        setResult(null);
        setCutoutResult(null);
        setPrintExtractResult(null);
        setPrintFileResult(null);
        setRunning(false);
        try {
            if (id === "official-product-grid") navigate("/cases/product-listing-set", { replace: true });
            else if (id === "official-image-variations") navigate("/cases/image-variations", { replace: true });
            else if (id === "official-ai-image") navigate("/image", { replace: true });
            else if (id) {
                const item = await fetchCase(id);
                if (activeCase.current === id) {
                    setSelected(item);
                    setValues(Object.fromEntries(readFields(item).filter((field) => field.defaultValue).map((field) => [field.key, field.defaultValue!])));
                }
            } else {
                const data = await fetchCases({ pageSize: 60 });
                if (!activeCase.current) setItems(data.items);
            }
        } catch (error) {
            if (activeCase.current === id) setLoadError(error instanceof Error ? error.message : "获取案例失败");
        } finally {
            if (activeCase.current === id) setLoading(false);
        }
    }, [caseId, navigate]);

    useEffect(() => {
        void load();
    }, [load]);
    useEffect(() => {
        let active = true;
        setQuote(null);
        setQuoteError("");
        if (!token || !selected) {
            setQuoting(false);
            return;
        }
        setQuoting(true);
        const count = selected.id === "official-fusion" ? Number(values.count || 1) : undefined;
        void fetchCaseRunPrice(token, selected.id, count)
            .then((price) => {
                if (active) setQuote(price);
            })
            .catch((error) => {
                if (active) setQuoteError(error instanceof Error ? error.message : "报价读取失败");
            })
            .finally(() => {
                if (active) setQuoting(false);
            });
        return () => {
            active = false;
        };
    }, [token, selected, values.count]);

    const fields = selected ? readFields(selected) : [];
    const displayFields = selected?.id === "official-title-gen"
        ? [...fields].sort((a, b) => {
            const order = ["imageUrl", "prompt", "platform", "language", "style"];
            return order.indexOf(a.key) - order.indexOf(b.key);
        })
        : fields;
    const sourceImages = [values.imageUrl, ...(Array.isArray(values.referenceImageUrls) ? values.referenceImageUrls : [])]
        .filter((value): value is string => typeof value === "string" && /^(data:image\/|https?:\/\/|blob:)/i.test(value));
    const submit = async () => {
        if (!selected || running || checking) return;
        if (!token) {
            message.warning("请先通过右上角登录后使用");
            return;
        }
        const missing = fields.find((field) => field.required && !(Array.isArray(values[field.key]) ? values[field.key].length : String(values[field.key] || "").trim()));
        if (missing) {
            message.warning(`请填写${missing.label || missing.key}`);
            return;
        }
        setChecking(true);
        const submittedValues = { ...values };
        try {
            const price = await fetchCaseRunPrice(token, selected.id, selected.id === "official-fusion" ? Number(submittedValues.count || 1) : undefined);
            if (activeCase.current !== selected.id) return;
            setQuote(price);
            const confirmed = await modal.confirm({
                title: `使用${selected.title}`,
                content: `本次预计消耗 ${price.points} 算力点${price.count > 1 ? `，共生成 ${price.count} 张图片` : ""}。`,
                okText: "确认生成",
                cancelText: "取消",
            });
            if (!confirmed || activeCase.current !== selected.id) return;
            setRunning(true);
            try {
                const output = await runCase(token, selected.id, submittedValues);
                if (activeCase.current === selected.id) {
                    setResult(output);
                    if (selected.id === "official-cutout" && extractMedia(output)[0]) setCutoutResult({ source: String(submittedValues.imageUrl), url: extractMedia(output)[0], feather: String(submittedValues.feather || "关"), background: String(submittedValues.background || "透明") });
                    if (selected.id === "official-print-extract" && extractMedia(output)[0]) setPrintExtractResult({ source: String(submittedValues.imageUrl), url: extractMedia(output)[0] });
                    if (selected.id === "official-print-file" && extractMedia(output)[0]) setPrintFileResult({ source: String(submittedValues.imageUrl), url: extractMedia(output)[0] });
                    if (extractMedia(output).length || extractText(output)) message.success("处理完成");
                    else message.error("模型未返回可展示的结果，请检查模型配置");
                }
            } finally {
                if (activeCase.current === selected.id) setRunning(false);
                void hydrateUser();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "报价读取失败");
        } finally {
            setChecking(false);
        }
    };

    if (selected?.id === "official-cutout" && !loading && !loadError) {
        const busy = running || checking;
        return <CutoutWorkspace values={values} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} result={cutoutResult} busy={busy}
            upload={<CaseImageInput compact field={{ key: "imageUrl", label: "上传图片", type: "image" }} value={values.imageUrl} disabled={busy} onChange={(value) => setValues((current) => ({ ...current, imageUrl: value }))} />}
            footer={<div className="space-y-3">
                <p className={`text-xs ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p>
                <Button block type="primary" size="large" icon={<Scissors className="size-4" />} loading={busy} disabled={quoting} onClick={() => void submit()}>{running ? "正在抠图" : `开始抠图${quote ? ` · ${quote.points} 算力点` : ""}`}</Button>
            </div>} />;
    }
    if (selected?.id === "official-dewatermark" && !loading && !loadError) {
        const busy = running || checking;
        const outputUrl = extractMedia(result)[0];
        return <DewatermarkWorkspace values={values} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} busy={busy}
            result={outputUrl && typeof values.imageUrl === "string" ? { source: values.imageUrl, url: outputUrl } : null}
            upload={<CaseImageInput compact field={{ key: "imageUrl", label: "上传图片", type: "image" }} value={values.imageUrl} disabled={busy} onChange={(value) => setValues((current) => ({ ...current, imageUrl: value }))} />}
            footer={<div className="space-y-3">
                <p className={`text-xs ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p>
                <Button block type="primary" size="large" icon={<Eraser className="size-4" />} loading={busy} disabled={quoting} onClick={() => void submit()}>{running ? "正在去水印" : `开始去水印${quote ? ` · ${quote.points} 算力点` : ""}`}</Button>
            </div>} />;
    }
    if (selected?.id === "official-dewrinkle" && !loading && !loadError) {
        const busy = running || checking;
        const outputUrl = extractMedia(result)[0];
        return <DewrinkleWorkspace values={values} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} busy={busy}
            result={outputUrl && typeof values.imageUrl === "string" ? { source: values.imageUrl, url: outputUrl } : null}
            upload={<CaseImageInput compact field={{ key: "imageUrl", label: "上传图片", type: "image" }} value={values.imageUrl} disabled={busy} onChange={(value) => { setValues((current) => ({ ...current, imageUrl: value })); setResult(null); }} />}
            footer={<div className="space-y-3">
                <p className={`text-xs ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p>
                <Button block type="primary" size="large" icon={<Wind className="size-4" />} loading={busy} disabled={quoting || !values.imageUrl} onClick={() => void submit()}>{running ? "正在去皱" : `开始去皱${quote ? ` · ${quote.points} 算力点` : ""}`}</Button>
            </div>} />;
    }
    if (selected?.id === "official-ip-check" && !loading && !loadError) {
        const busy = running || checking;
        const updateValues = (changes: Record<string, CaseValue>) => {
            setValues((current) => ({ ...current, ...changes }));
            setResult(null);
        };
        return <IpCheckWorkspace values={values} onChange={updateValues} result={result} busy={busy} onBack={() => navigate("/create?medium=image")}
            upload={<CaseImageInput compact field={{ key: "imageUrl", label: "上传图片", type: "image" }} value={values.imageUrl} disabled={busy} onChange={(value) => updateValues({ imageUrl: value })} />}
            footer={<div className="space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800">
                <p className={`text-sm ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p>
                <Button block type="primary" size="large" icon={<ShieldCheck className="size-4" />} loading={busy} disabled={quoting || !values.imageUrl} onClick={() => void submit()}>{running ? "正在检测" : `开始检测${quote ? ` · ${quote.points} 算力点` : ""}`}</Button>
                <p className="text-xs leading-5 text-stone-400">AI 仅提供视觉风险线索，结果不构成法律意见。</p>
            </div>} />;
    }
    if (selected?.id === "official-print-extract" && !loading && !loadError) {
        const busy = running || checking;
        return <PrintExtractWorkspace values={values} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} busy={busy} result={printExtractResult}
            upload={<CaseImageInput compact field={{ key: "imageUrl", label: "服装或商品图", type: "image" }} value={values.imageUrl} disabled={busy} onChange={(value) => { setValues((current) => ({ ...current, imageUrl: value })); setPrintExtractResult(null); }} />}
            footer={<div className="space-y-3">
                <p className={`text-xs ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p>
                <Button block type="primary" size="large" icon={<Stamp className="size-4" />} loading={busy} disabled={quoting} onClick={() => void submit()}>{running ? "正在提取" : `开始提取${quote ? ` · ${quote.points} 算力点` : ""}`}</Button>
            </div>} />;
    }
    if (selected?.id === "official-print-file" && !loading && !loadError) {
        const busy = running || checking;
        return <PrintFileWorkspace values={values} onChange={(changes) => setValues((current) => ({ ...current, ...changes }))} busy={busy} result={printFileResult} onBack={() => navigate("/create?medium=image")}
            upload={<CaseImageInput compact field={{ key: "imageUrl", label: "原始图片", type: "image" }} value={values.imageUrl} disabled={busy} onChange={(value) => { setValues((current) => ({ ...current, imageUrl: value })); setPrintFileResult(null); }} />}
            footer={<div className="space-y-3"><p className={`text-xs ${quoteError ? "text-red-400" : "text-stone-500"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p><Button block type="primary" size="large" icon={<Printer className="size-4" />} loading={busy} disabled={quoting} onClick={() => void submit()}>{running ? "正在生成" : `开始生成${quote ? ` · ${quote.points} 算力点` : ""}`}</Button></div>} />;
    }
    if (selected?.id === "official-tryon" && !loading && !loadError) {
        const busy = running || checking;
        const hasGarment = Boolean(values.topImageUrl || values.bottomImageUrl);
        return <TryonWorkspace values={values} onChange={(changes) => { setValues((current) => ({ ...current, ...changes })); setResult(null); }} busy={busy} result={result}
            footer={<div className="space-y-3"><p className={`text-xs ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>{quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点` : "登录后查看算力点报价")}</p><Button block type="primary" size="large" icon={<Play className="size-4" />} loading={busy} disabled={quoting || !hasGarment} onClick={() => void submit()}>{running ? "正在试穿" : `开始试穿${quote ? ` · ${quote.points} 算力点` : ""}`}</Button></div>} />;
    }

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
                <header className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-200 pb-5 dark:border-stone-800">
                    <div className="flex min-w-0 items-center gap-3">
                        {caseId ? <Button type="text" icon={<ArrowLeft className="size-4" />} title="返回图片创作" aria-label="返回图片创作" onClick={() => navigate("/create?medium=image")} /> : <Store className="size-6" />}
                        <div className="min-w-0">
                            <h1 className="break-words text-2xl font-semibold">{caseId ? selected?.title || "创作工具" : "案例市场"}</h1>
                            {selected ? <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{selected.description}</p> : null}
                        </div>
                    </div>
                    {!caseId ? (
                        <div className="flex items-center gap-2">
                            <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()} loading={loading}>
                                刷新
                            </Button>
                            {token ? (
                                <Button icon={<ExternalLink className="size-4" />} onClick={() => navigate("/assets/cases")}>
                                    我的案例
                                </Button>
                            ) : null}
                        </div>
                    ) : null}
                </header>
                {loading ? (
                    <div className="flex min-h-80 items-center justify-center">
                        <Spin />
                    </div>
                ) : loadError ? (
                    <div className="py-12 text-center">
                        <p className="mb-4 text-sm text-red-600 dark:text-red-400">{loadError}</p>
                        <Button onClick={() => void load()}>重新加载</Button>
                    </div>
                ) : selected ? (
                    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(300px,400px)_minmax(0,1fr)]">
                        <section className="min-w-0 space-y-5" aria-label="创作参数">
                            {fields.length ? (
                                displayFields.filter((field) => !(selected.id === "official-inpaint" && field.type === "mask")).map((field) => (
                                    <div key={field.key}>
                                        <label className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                                            <span>{field.label || field.key}{field.required ? " *" : ""}</span>
                                            {field.help ? (
                                                <Popover
                                                    trigger={["hover", "click"]}
                                                    placement="topLeft"
                                                    content={<div className="max-w-80 whitespace-pre-line text-sm leading-6">{field.help}</div>}
                                                >
                                                    <button type="button" className="grid size-5 place-items-center rounded-full text-stone-400 hover:text-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500" aria-label={`查看${field.label || field.key}说明`}>
                                                        <CircleHelp className="size-4" />
                                                    </button>
                                                </Popover>
                                            ) : null}
                                        </label>
                                        {field.type === "select" && (field.options || []).length > 0 && (field.display === "buttons" || (field.options || []).length <= 3 || selected.id === "official-fusion") ? (
                                            <div className="flex flex-wrap gap-2" role="group" aria-label={field.label || field.key}>
                                                {(field.options || []).map((option) => {
                                                    const active = values[field.key] === option;
                                                    return (
                                                        <button
                                                            key={option}
                                                            type="button"
                                                            disabled={running || (selected.id === "official-title-gen" && !values.imageUrl)}
                                                            aria-pressed={active}
                                                            onClick={() => setValues((current) => ({ ...current, [field.key]: option }))}
                                                            className={`min-w-16 rounded-md px-4 py-2 text-sm transition ${active ? "bg-blue-600 text-white shadow-sm" : "bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"}`}
                                                        >
                                                            {option}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ) : field.type === "select" ? (
                                            <Select
                                                className="w-full"
                                                disabled={running || (selected.id === "official-title-gen" && !values.imageUrl)}
                                                placeholder={field.placeholder || "请选择"}
                                                options={(field.options || []).map((value) => ({ label: value, value }))}
                                                value={typeof values[field.key] === "string" ? values[field.key] : undefined}
                                                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
                                            />
                                        ) : field.type === "mask" ? (
                                            <CaseMaskInput source={typeof values.imageUrl === "string" ? values.imageUrl : ""} value={values[field.key]} disabled={running} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
                                        ) : field.type === "number" ? (
                                            <InputNumber className="w-full" min={1} max={2000} disabled={running} value={typeof values[field.key] === "string" ? Number(values[field.key]) : undefined} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value == null ? "" : String(value) }))} />
                                        ) : field.type === "image" || field.type === "images" ? (
                                            <CaseImageInput field={field} value={values[field.key]} disabled={running} onChange={(value) => { setValues((current) => ({ ...current, [field.key]: value, ...(field.key === "imageUrl" ? { maskUrl: "" } : {}) })); if (selected.id === "official-garment-extract" && field.key === "imageUrl") setResult(null); }} />
                                        ) : field.type === "text" ? (
                                            <Input disabled={running} placeholder={field.placeholder || "请输入"} value={typeof values[field.key] === "string" ? values[field.key] : ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />
                                        ) : (
                                            <Input.TextArea
                                                disabled={running}
                                                autoSize={{ minRows: 3, maxRows: 7 }}
                                                placeholder={field.placeholder || "请输入"}
                                                value={typeof values[field.key] === "string" ? values[field.key] : ""}
                                                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                                            />
                                        )}
                                    </div>
                                ))
                            ) : (
                                <Input.TextArea
                                    disabled={running}
                                    autoSize={{ minRows: 3, maxRows: 7 }}
                                    placeholder="请输入创作要求"
                                    value={typeof values.prompt === "string" ? values.prompt : ""}
                                    onChange={(event) => setValues({ prompt: event.target.value })}
                                />
                            )}
                            <div className="space-y-3 border-t border-stone-200 pt-4 dark:border-stone-800">
                                <p className={`text-sm ${quoteError ? "text-red-600 dark:text-red-400" : "text-stone-500 dark:text-stone-400"}`}>
                                    {quoteError || (quoting ? "正在读取算力点报价…" : quote ? `预计消耗 ${quote.points} 算力点${quote.count > 1 ? ` · ${quote.count} 张图片` : ""}` : "登录后查看算力点报价")}
                                </p>
                                {quote?.servicePoints ? (
                                    <p className="text-xs text-stone-500 dark:text-stone-400">
                                        模型 {quote.modelPoints} 算力点 + 平台处理 {quote.servicePoints} 算力点
                                    </p>
                                ) : null}
                                <Button block type="primary" size="large" icon={<Play className="size-4" />} loading={running || checking} disabled={quoting} onClick={() => void submit()}>
                                    {running ? "生成中" : `开始生成${quote ? ` · ${quote.points} 算力点` : ""}`}
                                </Button>
                            </div>
                        </section>
                        <section className="min-w-0 border-t border-stone-200 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0 dark:border-stone-800" aria-label="生成结果">
                            {selected.id === "official-inpaint" && result === null && values.imageUrl ? (
                                <div className="space-y-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div>
                                            <h2 className="text-base font-semibold">涂抹修改区域</h2>
                                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">在图片上涂抹需要修改的区域，画布已放大显示</p>
                                        </div>
                                    </div>
                                    <CaseMaskInput source={String(values.imageUrl)} value={values.maskUrl} disabled={running} large onChange={(value) => setValues((current) => ({ ...current, maskUrl: value }))} />
                                </div>
                            ) : result !== null ? (
                                <CaseResult value={result} title={selected.title} sources={sourceImages} compare={selected.id === "official-garment-extract"} />
                            ) : (
                                <div className="flex min-h-80 items-center justify-center">
                                    {running ? (
                                        <Spin tip="正在生成">
                                            <div className="h-20 w-36" />
                                        </Spin>
                                    ) : selected.id === "official-inpaint" ? (
                                        <InpaintUsageGuide />
                                    ) : selected.id === "official-fusion" ? (
                                        <FusionUsageGuide />
                                    ) : selected.id === "official-upscale" ? (
                                        <UpscaleUsageGuide />
                                    ) : selected.id === "official-title-gen" ? (
                                        <TitleGenerationGuide />
                                    ) : selected.id === "official-garment-extract" ? (
                                        <GarmentExtractGuide source={typeof values.imageUrl === "string" ? values.imageUrl : undefined} />
                                    ) : (
                                        <Empty image={<ImagePlus className="mx-auto size-10 text-stone-400" />} description="处理后将在这里对照原图和结果" />
                                    )}
                                </div>
                            )}
                            {running && result !== null ? <p className="mt-4 text-sm text-stone-500">正在生成新的结果…</p> : null}
                        </section>
                    </div>
                ) : items.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {items.map((item) => (
                            <Card
                                key={item.id}
                                hoverable
                                className="overflow-hidden"
                                styles={{ body: { padding: 0 } }}
                                onClick={() => navigate(item.id === "official-product-grid" ? "/cases/product-listing-set" : item.id === "official-image-variations" ? "/cases/image-variations" : `/cases?case=${encodeURIComponent(item.id)}`)}
                            >
                                {!officialCaseItems.some((tool) => tool.id === item.id) ? (
                                    <div className="aspect-[16/9] bg-stone-100 dark:bg-stone-900">
                                        {item.coverUrl ? (
                                            <img src={item.coverUrl} alt={item.title} className="h-full w-full object-cover" />
                                        ) : (
                                            <div className="flex h-full items-center justify-center text-stone-400">
                                                <ImagePlus className="size-8" />
                                            </div>
                                        )}
                                    </div>
                                ) : null}
                                <div className="p-5">
                                    <div className="flex items-start justify-between gap-3">
                                        <h2 className="line-clamp-2 text-base font-semibold">{item.title}</h2>
                                        {item.isOfficial ? <Tag color="blue">官方</Tag> : <Tag>作者</Tag>}
                                    </div>
                                    <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-stone-500">{item.description}</p>
                                    <div className="mt-4 flex items-center justify-between text-xs text-stone-500">
                                        <span>{item.category || "通用"}</span>
                                        <span>{item.priceCredits ? `平台处理 ${item.priceCredits} 算力点/次${item.id === "official-cutout" || item.id === "official-upscale" ? "" : "，模型费另计"}` : "按模型算力点报价"}</span>
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                ) : (
                    <Empty description="暂时还没有已发布案例" />
                )}
            </div>
        </main>
    );
}
