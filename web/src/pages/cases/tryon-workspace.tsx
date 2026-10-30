import { useEffect, useState, type ReactNode } from "react";
import { App, Button, Empty, Input, Modal, Segmented, Spin } from "antd";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Download, Footprints, ImagePlus, PersonStanding, RefreshCw, RotateCcw, Save, Shirt, Trash2, UserRound, X, ZoomIn } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { saveAs } from "file-saver";
import { fetchTryonLibrary, type TryonLibrary } from "@/services/api/cases";
import { fetchImageBlob } from "@/services/image-storage";
import { tryonDefaults, tryonDisplayPoses, tryonPoseLabel, tryonSources, updateTryonValues, type TryonPose, type TryonResult, type TryonValues } from "./tryon-state";

type Props = {
    values: TryonValues;
    onChange: (changes: TryonValues) => void;
    renderUpload: (key: string, label: string, target?: { values: TryonValues; onChange: (changes: TryonValues) => void }) => ReactNode;
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
    const [picker, setPicker] = useState<"model" | "pose" | "scene" | null>(null);
    const [selectionValues, setSelectionValues] = useState<TryonValues | null>(null);
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
    const currentSources = tryonSources(values);
    const displayedSources = view === "result" && result ? tryonSources(result.inputs) : currentSources;
    const resultInputs: TryonValues = { ...tryonDefaults, ...result?.inputs };
    const changed = result && Object.keys({ ...resultInputs, ...values }).some((key) => values[key] !== resultInputs[key]);
    const onePiece = values.garmentMode === "one-piece";
    const selection = selectionValues || values;
    const updateSelection = (changes: TryonValues) => setSelectionValues((current) => updateTryonValues(current || values, changes));
    const closePicker = () => { setPicker(null); setSelectionValues(null); setPosePicker(false); setPoseName(null); };
    const openPicker = (type: "model" | "pose" | "scene") => {
        setSelectionValues(type === "scene" && (!values.sceneMode || values.sceneMode === "original") ? updateTryonValues(values, { sceneMode: "library" }) : { ...values });
        setFilter("全部");
        setGender("全部");
        setPicker(type);
    };
    const customPoseMissing = selection.poseMode === "reference" && !selection.poseImageUrl && !String(selection.posePrompt || "").trim();
    const selectionError = picker === "model"
        ? !selection.modelImageUrl ? "请选择或上传模特照片" : ""
        : picker === "pose"
            ? customPoseMissing ? "请描述自定义姿势或上传参考照片" : selection.poseMode === "preset" && !tryonDisplayPoses.some((pose) => pose.id === selection.poseId) ? "请选择展示姿势" : ""
            : selection.sceneMode === "library" && !selection.sceneImageUrl ? "请选择场景" : "";
    const confirmPicker = () => {
        if (busy || selectionError) return;
        const keys = picker === "model" ? ["modelSource", "modelImageUrl"] : picker === "pose" ? ["poseMode", "poseId", "poseImageUrl", "posePrompt"] : ["sceneMode", "sceneImageUrl"];
        onChange(Object.fromEntries(keys.map((key) => [key, selection[key] || ""])));
        closePicker();
    };
    const options = picker === "model"
        ? library.models.filter((item) => (filter === "全部" || item.group === filter) && (gender === "全部" || (gender === "child" ? item.child : !item.child && item.gender === gender)))
        : library.scenes.filter((item) => filter === "全部" || item.env === filter);
    const savePose = () => {
        const image = String(selection.poseImageUrl || "");
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
    const poseIcons = [PersonStanding, UserRound, RotateCcw, Footprints];
    const libraryButton = (type: "model" | "pose" | "scene") => {
        const item = type === "model" ? model : type === "scene" ? scene : undefined;
        const label = type === "model" ? "模特" : type === "pose" ? "展示姿势" : "场景";
        const url = type === "model" ? String(values.modelImageUrl || "") : type === "pose" ? String(values.poseImageUrl || "") : values.sceneMode === "library" ? String(values.sceneImageUrl || "") : "";
        const defaultPose = values.poseMode === "preset" && values.poseId === tryonDefaults.poseId;
        const posePrompt = values.poseMode === "reference" ? String(values.posePrompt || "").trim() : "";
        const title = type === "model"
            ? url ? item?.name || (values.modelSource === "upload" ? "已上传模特" : "已选模特") : "选择模特"
            : type === "pose"
                ? `${tryonPoseLabel(values)}${defaultPose ? "（默认）" : posePrompt ? ` · ${posePrompt}` : ""}`
                : values.sceneMode === "library" ? item?.name || "选择场景" : values.sceneMode === "studio" ? "白底影棚" : "默认保留原背景";
        const clearable = type === "pose" ? !defaultPose : type === "scene" && (values.sceneMode === "library" || values.sceneMode === "studio");
        const Icon = type === "pose" ? poseIcons[tryonDisplayPoses.findIndex((pose) => pose.id === values.poseId)] || PersonStanding : ImagePlus;
        return <div className="relative">
            <button type="button" disabled={busy} aria-label={`选择${label}`} onClick={() => openPicker(type)} className={`flex min-h-16 w-full items-center gap-3 rounded-md border border-border py-2 pl-2.5 text-left transition hover:border-blue-500 disabled:opacity-60 ${clearable ? "pr-12" : "pr-2.5"}`}>
                <div className="grid h-11 w-8 shrink-0 place-items-center overflow-hidden rounded">
                    {url ? <img src={type === "pose" ? url : item?.thumb || url} alt={type === "pose" ? "姿势参考" : title} className="size-full object-contain" /> : <Icon className="size-5 text-muted-foreground" />}
                </div>
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}{type === "model" ? <span className="ml-1 text-red-500">*</span> : <span className="text-xs font-normal text-muted-foreground">（可选）</span>}</span><span title={title} className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{title}</span></span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </button>
            {clearable ? <button type="button" disabled={busy} aria-label={type === "pose" ? "恢复默认姿势" : "清除场景"} title={type === "pose" ? "恢复默认姿势（正面站立）" : "清除场景，保留原背景"} onClick={() => onChange(type === "pose" ? { poseMode: tryonDefaults.poseMode, poseId: tryonDefaults.poseId } : { sceneMode: "original", sceneImageUrl: "" })} className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-muted disabled:opacity-60">{type === "pose" ? <RotateCcw aria-hidden="true" className="size-4" /> : <X aria-hidden="true" className="size-4" />}</button> : null}
        </div>;
    };
    const selectionUpload = (key: string, label: string) => renderUpload(key, label, { values: selection, onChange: updateSelection });
    const catalog = libraryLoading ? <div className="grid min-h-40 place-items-center"><Spin /></div> : libraryError ? <div role="alert" className="flex min-h-40 flex-wrap items-center justify-center gap-3"><span className="text-sm text-red-500">{libraryError}</span><Button icon={<RefreshCw className="size-4" />} onClick={() => setReload((value) => value + 1)}>重试</Button></div> : <>
        <div className="mb-3 overflow-x-auto"><Segmented className="min-w-max" value={filter} options={picker === "scene" ? ["全部", "室内", "户外", "街景", "影棚", "度假"] : [{ label: "全部", value: "全部" }, { label: "中国", value: "cn" }, { label: "日本", value: "jp" }, { label: "韩国", value: "kr" }, { label: "其他", value: "intl" }]} onChange={(value) => setFilter(String(value))} /></div>
        {picker === "model" ? <div className="mb-4"><Segmented value={gender} options={[{ label: "全部", value: "全部" }, { label: "女模", value: "f" }, { label: "男模", value: "m" }, { label: "儿童", value: "child" }]} onChange={(value) => setGender(String(value))} /></div> : null}
        {options.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {options.map((item) => {
                const selected = item.url === (picker === "model" ? selection.modelImageUrl : selection.sceneImageUrl);
                return <button key={item.id} type="button" disabled={busy} aria-pressed={selected} aria-label={`选择${picker === "model" ? "模特" : "场景"}：${item.name}`} className={`relative min-w-0 overflow-hidden rounded-md border text-left ${selected ? "border-blue-500 ring-1 ring-blue-500" : "border-border"}`} onClick={() => updateSelection(picker === "model" ? { modelSource: "library", modelImageUrl: item.url } : { sceneMode: "library", sceneImageUrl: item.url })}>
                    <img loading="lazy" src={item.thumb || item.url} alt={item.name} className="aspect-[3/4] w-full bg-muted object-contain" />
                    <span className="block break-words px-2 py-2 text-xs">{item.name}</span>
                    {selected ? <Check aria-label="已选择" className="absolute right-1 top-1 size-5 rounded bg-blue-600 p-0.5 text-white" /> : null}
                </button>;
            })}
        </div> : <Empty description="没有匹配素材" />}
    </>;
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
                    <div className="flex flex-col gap-3">
                        {libraryButton("model")}
                        {libraryButton("pose")}
                        {libraryButton("scene")}
                    </div>
                    <div className="space-y-3">
                        <label htmlFor="tryon-prompt" className="block text-sm text-stone-500">补充要求（可选）</label>
                        <Input.TextArea id="tryon-prompt" disabled={busy} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="例如：半身构图，突出上衣细节，下摆自然垂放，不塞进裤腰" value={String(values.prompt || "")} onChange={(event) => onChange({ prompt: event.target.value })} />
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
                    </div> : result ? <>
                        <p className="mb-3 text-xs text-stone-500">
                            {tryonPoseLabel(result.inputs)}
                            {" · "}{({ original: "原背景", studio: "白底影棚", library: "场景库" } as Record<string, string>)[String(result.inputs.sceneMode || "original")]}
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
        <Modal open={picker !== null} title={picker === "model" ? "选择模特" : picker === "pose" ? "选择展示姿势" : "选择场景"} onCancel={closePicker} onOk={confirmPicker} okText="确认" cancelText="取消" okButtonProps={{ disabled: busy || Boolean(selectionError) }} cancelButtonProps={{ disabled: busy }} width={760} destroyOnHidden styles={{ body: { maxHeight: "65vh", overflowY: "auto" } }}>
            {picker === "model" ? <div className="space-y-4 pt-3">
                <Segmented block disabled={busy} value={String(selection.modelSource || "library")} options={[{ label: "图库选择", value: "library" }, { label: "上传照片", value: "upload" }]} onChange={(value) => updateSelection({ modelSource: String(value), modelImageUrl: "" })} />
                {selection.modelSource === "upload" ? selectionUpload("modelImageUrl", "模特照片") : catalog}
            </div> : picker === "pose" ? <div className="space-y-4 pt-3">
                    <div className="grid grid-cols-2 gap-3 p-1">
                        {tryonDisplayPoses.map((pose, index) => {
                            const selected = selection.poseMode === "preset" && selection.poseId === pose.id;
                            const Icon = poseIcons[index];
                            return <button type="button" key={pose.id} disabled={busy} aria-label={`展示姿势：${pose.name}`} aria-pressed={selected} onClick={() => updateSelection({ poseMode: "preset", poseId: pose.id })} className={`relative flex min-h-32 min-w-0 flex-col items-center justify-center gap-2 rounded-md border p-3 text-center ${selected ? "border-blue-500 ring-1 ring-blue-500" : "border-border hover:border-blue-400"}`}>
                                <Icon aria-hidden="true" className="size-7 text-muted-foreground" />
                                <span className="break-words text-sm font-medium">{pose.name}</span>
                                <span className="break-words text-xs text-muted-foreground">{pose.purpose}</span>
                                {selected ? <Check aria-label="已选择" className="absolute right-1 top-1 size-5 rounded bg-blue-600 p-0.5 text-white" /> : null}
                            </button>;
                        })}
                    </div>
                    {selection.poseMode === "preset" && selection.poseId === "back" ? <p className="text-xs text-muted-foreground">背面展示适合有背面服装参考图时使用。</p> : null}
                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                        <Button type={selection.poseMode === "reference" ? "primary" : "text"} disabled={busy} icon={<ImagePlus className="size-4" />} onClick={() => updateSelection({ poseMode: "reference" })}>自定义姿势</Button>
                        <Button type="text" disabled={busy} aria-pressed={selection.poseMode === "original"} icon={<UserRound className="size-4" />} onClick={() => updateSelection({ poseMode: "original" })}>沿用照片姿势{selection.poseMode === "original" ? <Check className="size-4" /> : null}</Button>
                    </div>
                    {selection.poseMode === "reference" ? <div className="space-y-3">
                        <Input.TextArea aria-label="自定义姿势描述" disabled={busy} autoSize={{ minRows: 2, maxRows: 5 }} placeholder="例如：身体微侧，单手轻扶腰部，另一只手自然下垂" value={String(selection.posePrompt || "")} onChange={(event) => updateSelection({ posePrompt: event.target.value })} />
                        {selectionUpload("poseImageUrl", "姿势参考（可选，仅动作）")}
                        <div className="flex flex-wrap gap-2">
                            <Button disabled={busy} icon={<ImagePlus className="size-4" />} onClick={() => setPosePicker(true)}>本机姿势库{poses.length ? ` (${poses.length})` : ""}</Button>
                            <Button disabled={busy || !String(selection.poseImageUrl || "").startsWith("data:" + "image/")} icon={<Save className="size-4" />} onClick={() => setPoseName("")}>保存参考</Button>
                        </div>
                    </div> : null}
            </div> : picker === "scene" ? <div className="space-y-4 pt-3">
                <Segmented block disabled={busy} value={String(selection.sceneMode || "library")} options={[{ label: "场景库", value: "library" }, { label: "白底影棚", value: "studio" }]} onChange={(value) => updateSelection({ sceneMode: String(value) })} />
                {selection.sceneMode === "library" ? catalog : <div className="flex min-h-32 items-center justify-center gap-3 text-sm text-muted-foreground">
                    <ImagePlus aria-hidden="true" className="size-6" />
                    <span>纯白背景，自然接地阴影</span>
                </div>}
            </div> : null}
            <div aria-live="polite" className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                {picker === "model" ? library.models.find((item) => item.url === selection.modelImageUrl)?.name || (selection.modelImageUrl ? "已上传模特" : "未选择模特") : picker === "pose" ? tryonPoseLabel(selection) : selection.sceneMode === "library" ? library.scenes.find((item) => item.url === selection.sceneImageUrl)?.name || "未选择场景" : "白底影棚"}
                {selectionError ? <span className="mt-1 block">{selectionError}</span> : null}
            </div>
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
                    <button type="button" disabled={busy} aria-label={`使用姿势：${pose.name}`} aria-pressed={selection.poseImageUrl === pose.image} className={`block aspect-[2/3] w-full overflow-hidden rounded-md border ${selection.poseImageUrl === pose.image ? "border-blue-500" : "border-border"}`} onClick={() => { updateSelection({ poseMode: "reference", poseImageUrl: pose.image }); setPosePicker(false); }}>
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
