import { useEffect, useState, type ReactNode } from "react";
import { App, Button, Empty, Input, Modal, Segmented, Spin } from "antd";
import { ArrowLeft, ArrowRight, Check, Download, ImagePlus, RefreshCw, Save, Shirt, Trash2, X, ZoomIn } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { saveAs } from "file-saver";
import { fetchTryonLibrary, type TryonLibrary } from "@/services/api/cases";
import { fetchImageBlob } from "@/services/image-storage";
import { tryonDefaults, tryonSources, type TryonPose, type TryonResult, type TryonValues } from "./tryon-state";

type Props = {
    values: TryonValues;
    onChange: (changes: TryonValues) => void;
    renderUpload: (key: string, label: string) => ReactNode;
    footer: ReactNode;
    busy: boolean;
    generating: boolean;
    result: TryonResult | null;
    poses: TryonPose[];
    onPosesChange: (poses: TryonPose[]) => void;
};

export default function TryonWorkspace({ values, onChange, renderUpload, footer, busy, generating, result, poses, onPosesChange }: Props) {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const [library, setLibrary] = useState<TryonLibrary>({ models: [], scenes: [], poses: [] });
    const [libraryLoading, setLibraryLoading] = useState(false);
    const [libraryError, setLibraryError] = useState("");
    const [reload, setReload] = useState(0);
    const [picker, setPicker] = useState<"model" | "scene" | null>(null);
    const [filter, setFilter] = useState("全部");
    const [gender, setGender] = useState("全部");
    const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [posePicker, setPosePicker] = useState(false);
    const [poseName, setPoseName] = useState<string | null>(null);
    const [view, setView] = useState("examples");
    useEffect(() => {
        if (generating || result) setView("result");
    }, [generating, result]);
    useEffect(() => {
        let active = true;
        setLibraryLoading(true);
        setLibraryError("");
        void fetchTryonLibrary().then((data) => { if (active) setLibrary({ ...data, poses: data.poses || [] }); })
            .catch(() => { if (active) setLibraryError("素材库加载失败"); })
            .finally(() => { if (active) setLibraryLoading(false); });
        return () => { active = false; };
    }, [reload]);

    const model = library.models.find((item) => item.url === values.modelImageUrl);
    const scene = library.scenes.find((item) => item.url === values.sceneImageUrl);
    const preset = library.poses.find((item) => item.id === values.poseId && item.url === values.poseImageUrl);
    const currentSources = tryonSources(values);
    const displayedSources = view === "result" && result ? tryonSources(result.inputs) : currentSources;
    const resultInputs: TryonValues = { ...tryonDefaults, ...result?.inputs };
    const changed = result && Object.keys({ ...resultInputs, ...values }).some((key) => values[key] !== resultInputs[key]);
    const onePiece = values.garmentMode === "one-piece";
    const modelSource = String(values.modelSource || "library");
    const openPicker = (type: "model" | "scene") => { setFilter("全部"); setGender("全部"); setPicker(type); };
    const options = picker === "model"
        ? library.models.filter((item) => (filter === "全部" || item.group === filter) && (gender === "全部" || item.gender === gender))
        : library.scenes.filter((item) => filter === "全部" || item.env === filter);
    const savePose = () => {
        const image = String(values.poseImageUrl || "");
        if (busy || !poseName?.trim() || !image.startsWith("data:" + "image/")) return;
        onPosesChange([...poses, { id: crypto.randomUUID(), name: poseName.trim(), image }]);
        setPoseName(null);
        message.success("已保存到本机姿势库");
    };
    const download = async (url: string, index: number) => {
        setDownloading(true);
        try {
            const blob = await fetchImageBlob(url);
            const extension = blob.type.split(";")[0].split("/")[1]?.replace("jpeg", "jpg") || "png";
            saveAs(blob, `服装上身-${index + 1}.${extension}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            setDownloading(false);
        }
    };
    const libraryButton = (type: "model" | "scene") => {
        const item = type === "model" ? model : scene;
        const key = type === "model" ? "modelImageUrl" : "sceneImageUrl";
        const label = type === "model" ? "模特" : "场景";
        return <div className="relative">
            <button type="button" disabled={busy} onClick={() => openPicker(type)} className="flex min-h-20 w-full items-center gap-3 rounded-md border border-stone-200 p-2.5 pr-9 text-left transition hover:border-blue-500 disabled:opacity-60 dark:border-stone-700">
                <div className="grid h-16 w-12 shrink-0 place-items-center overflow-hidden rounded bg-stone-100 dark:bg-stone-900">
                    {item ? <img src={item.thumb || item.url} alt={item.name} className="size-full object-contain" /> : <ImagePlus className="size-5 text-stone-400" />}
                </div>
                <span className="min-w-0"><span className="block break-words text-sm font-medium">{item?.name || `选择${label}`}</span><span className="mt-1 block text-xs text-stone-500">{item ? "更换" : "从图库选择"}</span></span>
            </button>
            {item ? <button type="button" disabled={busy} title={`移除${label}`} aria-label={`移除${label}`} onClick={() => onChange({ [key]: "" })} className="absolute right-2 top-2 grid size-7 place-items-center rounded text-stone-500 hover:bg-black/5 dark:hover:bg-white/10"><X className="size-4" /></button> : null}
        </div>;
    };
    const imagePreview = (url: string, label: string, className: string) => <button type="button" onClick={() => setPreview({ url, label })} title={`放大${label}`} aria-label={`放大${label}`} className={`group relative block overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900 ${className}`}>
        <img src={url} alt={label} className="size-full object-contain" />
        <ZoomIn className="absolute bottom-2 right-2 size-5 rounded bg-black/60 p-0.5 text-white opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>;

    return <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
        <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
            <header className="mb-5 flex items-center gap-3 border-b border-stone-200 pb-4 dark:border-stone-800">
                <Button type="text" icon={<ArrowLeft className="size-4" />} title="返回图片创作" aria-label="返回图片创作" onClick={() => navigate("/create?medium=image")} />
                <Shirt className="size-6 shrink-0 text-pink-500" />
                <h1 className="text-xl font-semibold">服装上身</h1>
            </header>
            <div className="grid min-w-0 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
                <section className="flex min-w-0 flex-col gap-5 border-b border-stone-200 pb-6 lg:border-b-0 lg:border-r lg:pr-6 dark:border-stone-800" aria-label="服装上身参数">
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold">服装 <span className="text-red-500">*</span></h2>
                        <Segmented block disabled={busy} value={String(values.garmentMode || "separates")} options={[{ label: "上装 / 下装", value: "separates" }, { label: "连衣裙 / 连体装", value: "one-piece" }]} onChange={(value) => onChange({ garmentMode: String(value) })} />
                        {onePiece ? renderUpload("onePieceImageUrl", "连衣裙 / 连体装") : <div className="grid grid-cols-2 gap-3">
                            <div className="min-w-0"><h3 className="mb-2 text-xs text-stone-500">上装</h3>{renderUpload("topImageUrl", "上装")}</div>
                            <div className="min-w-0"><h3 className="mb-2 text-xs text-stone-500">下装</h3>{renderUpload("bottomImageUrl", "下装")}</div>
                        </div>}
                    </div>
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold">模特 <span className="text-red-500">*</span></h2>
                        <Segmented block disabled={busy} value={modelSource} options={[{ label: "图库选择", value: "library" }, { label: "上传照片", value: "upload" }]} onChange={(value) => onChange({ modelSource: String(value), modelImageUrl: "" })} />
                        {modelSource === "upload" ? renderUpload("modelImageUrl", "模特照片") : libraryButton("model")}
                    </div>
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold">模特姿势</h2>
                        <Segmented block size="small" disabled={busy} value={String(values.poseMode || "original")} options={[{ label: "保持模特姿势", value: "original" }, { label: "常用姿势", value: "library" }, { label: "自定义参考", value: "reference" }]} onChange={(value) => onChange({ poseMode: String(value) })} />
                        {values.poseMode === "library" ? libraryLoading ? <div className="grid min-h-24 place-items-center"><Spin /></div> : libraryError ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>{libraryError}</span><Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => setReload((value) => value + 1)}>重试</Button></div> : <>
                            {library.poses.length ? <div className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto p-1">
                                {library.poses.map((pose) => <figure key={pose.id} className="relative min-w-0">
                                    <button type="button" disabled={busy} aria-label={`选择常用姿势：${pose.name}`} aria-pressed={preset?.id === pose.id} onClick={() => onChange({ poseMode: "library", poseId: pose.id, poseImageUrl: pose.url })} className={`block w-full overflow-hidden rounded-md border text-left ${preset?.id === pose.id ? "border-blue-500 ring-1 ring-blue-500" : "border-border"}`}>
                                        <img loading="lazy" src={pose.url} alt={pose.name} className="aspect-[3/4] w-full bg-stone-50 object-contain dark:bg-stone-900" />
                                        <span className="block min-h-10 break-words px-2 py-2 pr-7 text-xs">{pose.name}</span>
                                    </button>
                                    {preset?.id === pose.id ? <Check aria-label="已选择" className="pointer-events-none absolute left-1 top-1 size-5 rounded bg-blue-600 p-0.5 text-white" /> : null}
                                    <Button type="text" size="small" className="!absolute bottom-1 right-1" title={`放大${pose.name}`} aria-label={`放大${pose.name}`} icon={<ZoomIn className="size-3.5" />} onClick={() => setPreview({ url: pose.url, label: pose.name })} />
                                </figure>)}
                            </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无常用姿势" />}
                            {preset ? <div className="flex items-center justify-between gap-2 text-xs text-stone-500"><a href={preset.source} target="_blank" rel="noreferrer" className="underline">照片来源：Pexels</a><Button disabled={busy} size="small" type="text" icon={<X className="size-3.5" />} onClick={() => onChange({ poseId: "", poseImageUrl: "" })}>移除姿势</Button></div> : null}
                        </> : null}
                        {values.poseMode === "reference" ? <>
                            {renderUpload("poseImageUrl", "姿势参考（仅动作）")}
                            <div className="flex flex-wrap gap-2">
                                <Button disabled={busy} icon={<ImagePlus className="size-4" />} onClick={() => setPosePicker(true)}>本机姿势库{poses.length ? ` (${poses.length})` : ""}</Button>
                                <Button disabled={busy || !String(values.poseImageUrl || "").startsWith("data:" + "image/")} icon={<Save className="size-4" />} onClick={() => setPoseName("")}>保存参考</Button>
                            </div>
                        </> : null}
                    </div>
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold">场景</h2>
                        <Segmented block disabled={busy} value={String(values.sceneMode || "original")} options={[{ label: "原背景", value: "original" }, { label: "白底影棚", value: "studio" }, { label: "场景库", value: "library" }]} onChange={(value) => onChange({ sceneMode: String(value) })} />
                        {values.sceneMode === "library" ? libraryButton("scene") : null}
                    </div>
                    <div className="space-y-3">
                        <h2 className="text-sm font-semibold">构图</h2>
                        <Segmented block disabled={busy} value={String(values.framing || "full")} options={[{ label: "全身", value: "full" }, { label: "半身", value: "half", disabled: onePiece || Boolean(values.bottomImageUrl) }]} onChange={(value) => onChange({ framing: String(value) })} />
                    </div>
                    <div className="space-y-3">
                        <label htmlFor="tryon-prompt" className="block text-sm text-stone-500">补充要求（可选）</label>
                        <Input.TextArea id="tryon-prompt" disabled={busy} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="例如：上衣下摆自然垂放，不塞进裤腰" value={String(values.prompt || "")} onChange={(event) => onChange({ prompt: event.target.value })} />
                    </div>
                    <div className="sticky bottom-0 z-10 mt-auto border-t border-stone-200 bg-background pb-3 pt-4 dark:border-stone-800">{footer}</div>
                </section>
                <section className="min-w-0" aria-label="试穿结果">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <Segmented value={view} options={[{ label: "效果案例", value: "examples" }, { label: "本次结果", value: "result" }]} onChange={(value) => setView(String(value))} />
                        {view === "result" && result ? <Button disabled={busy} icon={<RefreshCw className="size-4" />} onClick={() => onChange(result.inputs)}>使用这组参数</Button> : null}
                    </div>
                    {view === "result" ? <h2 className="mb-3 text-sm font-semibold">{result ? changed ? "上次试穿结果" : "试穿结果" : "本次素材"}</h2> : null}
                    {generating ? <div role="status" className="mb-4 flex items-center gap-3 text-sm text-stone-500"><Spin size="small" />正在生成试穿照片…</div> : null}
                    {view === "result" && changed ? <p className="mb-4 text-xs text-stone-500">参数已调整，下方仍为上次生成的照片和素材。</p> : null}
                    {displayedSources.length ? <div className="mb-5 flex flex-wrap gap-3">
                        {displayedSources.map(({ label, url }) => <figure key={label} className="w-20">
                            {imagePreview(url, `${view === "result" && result ? "生成时" : "本次"}${label}`, "aspect-[3/4] w-full")}
                            <figcaption className="mt-1 text-center text-xs text-stone-500">{label}</figcaption>
                        </figure>)}
                    </div> : null}
                    {view === "examples" ? <div className="space-y-4 border-t border-border pt-5">
                        <h2 className="text-sm font-semibold">参考项目示例</h2>
                        <div className="grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                            <figure className="min-w-0">{imagePreview("/examples/tryon/source.webp", "案例原图", "aspect-[3/4] w-full")}<figcaption className="mt-2 text-center text-xs text-stone-500">示例原图</figcaption></figure>
                            <ArrowRight aria-hidden="true" className="mx-auto size-5 rotate-90 text-stone-400 sm:rotate-0" />
                            <figure className="min-w-0">{imagePreview("/examples/tryon/result.webp", "案例效果", "aspect-[3/4] w-full")}<figcaption className="mt-2 text-center text-xs text-stone-500">示例效果</figcaption></figure>
                        </div>
                        <p className="text-xs text-stone-500">来源：<a href="https://github.com/usscottli-ctrl/novaryns" target="_blank" rel="noreferrer" className="underline">Novaryn 参考项目</a>。沿用旧版案例，非本站生成记录。</p>
                    </div> : result ? <>
                        <p className="mb-3 text-xs text-stone-500">
                            {({ original: "保持模特姿势", library: "常用姿势", reference: "自定义参考" } as Record<string, string>)[String(result.inputs.poseMode || "original")]}
                            {" · "}{({ original: "原背景", studio: "白底影棚", library: "场景库" } as Record<string, string>)[String(result.inputs.sceneMode || "original")]}
                            {result.inputs.framing === "full" || result.inputs.framing === "half" ? <>{" · "}{result.inputs.framing === "half" ? "半身" : "全身"}</> : null}
                        </p>
                        <div className={result.urls.length > 1 ? "grid gap-5 xl:grid-cols-2" : "mx-auto w-full max-w-[560px]"}>
                            {result.urls.map((url, index) => <figure key={`${index}-${url}`}>
                                {imagePreview(url, `试穿结果 ${index + 1}`, "aspect-[2/3] w-full")}
                                <figcaption className="mt-3 flex items-center justify-between gap-2">
                                    <span className="text-xs text-stone-500">试穿结果 {result.urls.length > 1 ? index + 1 : ""}</span>
                                    <Button icon={<Download className="size-4" />} loading={downloading} onClick={() => void download(url, index)}>下载图片</Button>
                                </figcaption>
                            </figure>)}
                        </div>
                    </> : <div className="flex min-h-72 items-center justify-center border-t border-dashed border-stone-200 dark:border-stone-800"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={generating ? "正在试穿" : currentSources.length ? "待生成" : "暂无试穿结果"} /></div>}
                </section>
            </div>
        </div>
        <Modal open={picker !== null} title={picker === "model" ? "选择模特" : "选择场景"} footer={null} onCancel={() => setPicker(null)} width={760} destroyOnHidden>
            {libraryLoading ? <div className="grid min-h-40 place-items-center"><Spin /></div> : libraryError ? <div className="flex min-h-40 items-center justify-center gap-3"><span className="text-sm text-red-500">{libraryError}</span><Button icon={<RefreshCw className="size-4" />} onClick={() => setReload((value) => value + 1)}>重试</Button></div> : <>
                <div className="mb-3"><Segmented block value={filter} options={picker === "scene" ? ["全部", "室内", "户外", "街景", "影棚", "度假"] : [{ label: "全部", value: "全部" }, { label: "中国", value: "cn" }, { label: "日本", value: "jp" }, { label: "韩国", value: "kr" }, { label: "其他", value: "intl" }]} onChange={(value) => setFilter(String(value))} /></div>
                {picker === "model" ? <div className="mb-4"><Segmented value={gender} options={[{ label: "全部", value: "全部" }, { label: "女模", value: "f" }, { label: "男模", value: "m" }]} onChange={(value) => setGender(String(value))} /></div> : null}
                {options.length ? <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-auto sm:grid-cols-4">
                    {options.map((item) => <button key={item.id} type="button" disabled={busy} aria-pressed={item.url === (picker === "model" ? values.modelImageUrl : values.sceneImageUrl)} className={`min-w-0 overflow-hidden rounded-md border text-left ${item.url === (picker === "model" ? values.modelImageUrl : values.sceneImageUrl) ? "border-blue-500" : "border-stone-200 dark:border-stone-700"}`} onClick={() => { onChange(picker === "model" ? { modelSource: "library", modelImageUrl: item.url } : { sceneMode: "library", sceneImageUrl: item.url }); setPicker(null); }}>
                        <img loading="lazy" src={item.thumb || item.url} alt={item.name} className={`${picker === "model" ? "aspect-[3/4] object-contain" : "aspect-[4/3] object-cover"} w-full bg-stone-50 dark:bg-stone-900`} />
                        <span className="block break-words px-2 py-2 text-xs">{item.name}</span>
                    </button>)}
                </div> : <Empty description="没有匹配素材" />}
            </>}
        </Modal>
        <Modal open={preview !== null} title={preview?.label} footer={null} onCancel={() => setPreview(null)} width={960} destroyOnHidden>
            {preview ? <img src={preview.url} alt={preview.label} className="max-h-[75vh] w-full object-contain" /> : null}
        </Modal>
        <Modal open={poseName !== null} title="保存姿势参考" okText="保存" cancelText="取消" okButtonProps={{ disabled: busy || !poseName?.trim() }} onOk={savePose} onCancel={() => setPoseName(null)} destroyOnHidden>
            <Input aria-label="姿势名称" placeholder="姿势名称" value={poseName || ""} onChange={(event) => setPoseName(event.target.value)} onPressEnter={savePose} />
        </Modal>
        <Modal open={posePicker} title="本机姿势库" footer={null} onCancel={() => setPosePicker(false)} width={760} destroyOnHidden>
            {poses.length ? <div className="grid max-h-[60vh] grid-cols-2 gap-3 overflow-auto sm:grid-cols-4">
                {poses.map((pose) => <figure key={pose.id} className="min-w-0">
                    <button type="button" disabled={busy} aria-label={`使用姿势：${pose.name}`} aria-pressed={values.poseImageUrl === pose.image} className={`block aspect-[2/3] w-full overflow-hidden rounded-md border ${values.poseImageUrl === pose.image ? "border-blue-500" : "border-border"}`} onClick={() => { onChange({ poseMode: "reference", poseImageUrl: pose.image }); setPosePicker(false); }}>
                        <img src={pose.image} alt={pose.name} className="size-full object-contain" />
                    </button>
                    <figcaption className="mt-1 flex items-center justify-between gap-1"><span className="min-w-0 break-words text-xs">{pose.name}</span>
                        <Button type="text" size="small" disabled={busy} title={`删除姿势：${pose.name}`} aria-label={`删除姿势：${pose.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => { void modal.confirm({ title: "删除这张姿势参考？", content: pose.name, okText: "删除", cancelText: "取消", onOk: () => onPosesChange(poses.filter((item) => item.id !== pose.id)) }); }} />
                    </figcaption>
                </figure>)}
            </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已保存的姿势参考" />}
        </Modal>
    </main>;
}
