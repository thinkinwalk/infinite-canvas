import { useEffect, useRef, useState } from "react";
import { App, Button, Spin } from "antd";
import { ArrowDown, ArrowUp, Download, ImagePlus, Layers, Plus, Trash2 } from "lucide-react";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useUserStore } from "@/stores/use-user-store";
import { fetchProductSetImagePrice, fetchProductSetPlanPrice, planProductSet, streamProductSet, type ProductSetInput } from "@/services/api/cases";
import { fetchImageBlob } from "@/services/image-storage";
import { findImageURL } from "../product-set-download";
import { createModules, detailMarkets, detailProfiles, moduleImage, newDraft, outputLabels, profileFor, type DetailDraft, type DetailModule } from "./model";
import { exportDetailPackage, exportLongImage, renderModule } from "./render";

const detailStorage = localforage.createInstance({ name: "infinite-canvas", storeName: "detail_pages" });
const CASE_ID = "official-detail-page";
const control = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
const panel = "rounded-xl border border-border bg-card p-5";
type SavedPage = { id: string; date: string; draft: DetailDraft };
function dataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("图片读取失败")); reader.readAsDataURL(blob);
    });
}
function ModulePreview({ module, draft }: { module: DetailModule; draft: DetailDraft }) {
    const host = useRef<HTMLDivElement>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const url = moduleImage(module, draft);
    useEffect(() => {
        let active = true;
        host.current?.replaceChildren(); setError("");
        if (!url) { setLoading(false); return; }
        setLoading(true);
        void renderModule(module, draft).then(canvas => {
            if (!active) return;
            canvas.style.width = "100%"; canvas.style.height = "auto"; canvas.style.display = "block";
            canvas.setAttribute("aria-label", module.role);
            host.current?.replaceChildren(canvas);
        }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [url, module.title, module.body, module.layout, module.role, draft.platform, draft.amazonTemplate, draft.background, draft.foreground, draft.language]);
    return <div>
        <div ref={host} />
        {loading && <div className="p-8 text-center"><Spin /></div>}
        {(!url || error) && <div className="flex min-h-40 flex-col items-center justify-center border border-dashed border-border bg-background p-6 text-center text-sm text-muted-foreground"><Layers className="mb-2 size-5" /><span>{module.role}</span><span className="mt-2">{error || module.error || "选择实拍或生成无字底图后，这里显示实际排版"}</span></div>}
    </div>;
}

export default function DetailPageWorkspace() {
    const { message, modal } = App.useApp();
    const token = useUserStore(s => s.token);
    const userId = useUserStore(s => s.user?.id);
    const [draft, setDraft] = useState<DetailDraft>(newDraft);
    const [history, setHistory] = useState<SavedPage[]>([]);
    const [loadedKey, setLoadedKey] = useState("");
    const [busy, setBusy] = useState("");
    const [tab, setTab] = useState<"edit" | "preview">("edit");
    const [saveError, setSaveError] = useState("");
    const [saved, setSaved] = useState(false);
    const saveQueue = useRef(Promise.resolve());
    const storageKey = `detail-page-v2:${userId || "guest"}`;
    const profile = profileFor(draft);
    const enabled = draft.modules.filter(m => m.enabled);
    const ready = enabled.filter(m => moduleImage(m, draft)).length;
    const locked = Boolean(busy) || loadedKey !== storageKey;

    useEffect(() => {
        let active = true;
        setLoadedKey("");
        void Promise.all([detailStorage.getItem<DetailDraft>(storageKey), detailStorage.getItem<SavedPage[]>(`${storageKey}:history`)]).then(([savedDraft, pages]) => {
            if (!active) return;
            setDraft(savedDraft || newDraft()); setHistory(pages || []); setLoadedKey(storageKey);
        }).catch(() => { if (active) setSaveError("本地草稿读取失败，请刷新重试，避免覆盖原草稿"); });
        return () => { active = false; };
    }, [storageKey]);
    useEffect(() => {
        if (loadedKey !== storageKey) return;
        let active = true;
        setSaved(false);
        saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
            await detailStorage.setItem(storageKey, draft);
            if (active) { setSaveError(""); setSaved(true); }
        }).catch(() => { if (active) setSaveError("本地空间不足或写入失败，草稿尚未保存，请先导出图片"); });
        return () => { active = false; };
    }, [draft, loadedKey, storageKey]);

    const update = (patch: Partial<DetailDraft>, invalidate = false) => setDraft(current => ({ ...current, ...patch, ...(invalidate ? { confirmed: false, modules: current.modules.map(m => m.source === "ai" ? { ...m, image: undefined, error: undefined } : m) } : {}) }));
    const edit = (id: string, patch: Partial<DetailModule>) => setDraft(current => ({ ...current, confirmed: patch.title !== undefined || patch.body !== undefined ? false : current.confirmed, modules: current.modules.map(m => m.id === id ? { ...m, ...patch, ...(patch.visual !== undefined ? { image: undefined, error: undefined } : {}) } : m) }));
    const switchPlatform = (platform: string) => {
        const next = profileFor({ platform, amazonTemplate: draft.amazonTemplate });
        update({ platform, sliceHeight: next.height, confirmed: false, modules: createModules(next).map((m, i) => ({ ...m, photoId: draft.photos[i]?.id || "" })) });
    };
    const move = (index: number, delta: number) => {
        const modules = [...draft.modules];
        [modules[index], modules[index + delta]] = [modules[index + delta], modules[index]];
        update({ modules });
    };
    const upload = async (files: File[]) => {
        if (!files.length) return;
        setBusy("读取图片");
        try {
            const photos: DetailDraft["photos"] = [];
            for (const file of files) {
                if (!file.type.startsWith("image/")) throw new Error(`${file.name} 不是图片`);
                const bitmap = await createImageBitmap(file); bitmap.close();
                photos.push({ id: crypto.randomUUID(), name: file.name, url: await dataURL(file) });
            }
            setDraft(current => {
                const all = [...current.photos, ...photos];
                return { ...current, photos: all, modules: current.modules.map((m, i) => ({ ...m, photoId: m.photoId || all[i]?.id || "" })) };
            });
        } catch (e) { message.error(e instanceof Error ? e.message : "图片读取失败"); }
        finally { setBusy(""); }
    };
    const inputFor = (modules: DetailModule[]): ProductSetInput => ({
        images: draft.photos.slice(0, 6).map(p => p.url), platform: profile.label, market: draft.market, language: draft.language,
        productBrief: draft.brief, styleMode: "custom", styleText: `${draft.style}；背景色 ${draft.background}；${profile.note}`,
        layoutMode: "custom", customLayout: outputLabels[profile.output], targetImageCount: modules.length,
        cardIds: modules.map(m => m.id),
        planCards: modules.map(m => ({ id: m.id, category: m.role, title: m.title || m.role, body: m.body, description: m.visual, aspectRatio: profile.output === "aplus" ? "3:1" : profile.width === profile.height ? "1:1" : "2:3" })),
    });
    const aiAction = async (kind: "plan" | "image", selected?: DetailModule[]) => {
        const modules = selected || enabled.filter(m => m.source === "ai" && !m.image);
        if (!token) { message.warning("请先登录后使用 AI 制作"); return; }
        if (!draft.photos.length || !draft.brief.trim()) { message.warning("请上传商品照片并填写已确认的商品事实"); return; }
        if (kind === "image" && (!draft.confirmed || profile.photoOnly)) { message.warning("请先核对商品事实与文案；实拍平台无需 AI 出图"); return; }
        if (!modules.length) { message.warning("没有需要处理的模块"); return; }
        const input = inputFor(modules);
        setBusy("获取报价");
        try {
            const points = kind === "plan" ? (await fetchProductSetPlanPrice(token, CASE_ID)).points : (await fetchProductSetImagePrice(token, CASE_ID)).pointsPerImage * modules.length;
            modal.confirm({
                title: kind === "plan" ? "AI 规划图文内容" : `生成 ${modules.length} 张无字底图`,
                content: `预计 ${points} 算力点。${kind === "plan" ? "将更新启用模块的标题、正文和画面说明，请在生成图片前核对事实。" : "文字由页面独立排版，后续改字无需再次出图。"}`,
                okText: "确认制作", cancelText: "取消", onCancel: () => setBusy(""),
                onOk: async () => {
                    setBusy(kind === "plan" ? "规划图文内容" : "生成底图");
                    try {
                        if (kind === "plan") {
                            const result = await planProductSet(token, CASE_ID, input);
                            setDraft(current => ({ ...current, confirmed: false, modules: current.modules.map(m => {
                                const card = result.cards.find(c => c.id === m.id);
                                return card ? { ...m, title: card.title, body: card.body || "", visual: card.description, image: undefined, error: undefined } : m;
                            }) }));
                        } else {
                            const result = await streamProductSet(token, CASE_ID, input, (item, done, total) => {
                                setBusy(`生成底图 ${done}/${total}`);
                                const image = item.error ? undefined : findImageURL(item.data) || undefined;
                                edit(item.cardId, { image, error: item.error || (!image ? "接口未返回图片" : undefined) });
                            });
                            // Store completed images with the draft, so temporary model URLs do not break history.
                            for (const item of result.items) {
                                const url = !item.error && findImageURL(item.data);
                                if (url) {
                                    try { edit(item.cardId, { image: await dataURL(await fetchImageBlob(url)) }); }
                                    catch { message.warning(`${item.title} 的原图暂未缓存，请及时下载`); }
                                }
                            }
                            if (result.failed) message.warning(`${result.failed} 个模块失败，可单独重试`);
                        }
                    } catch (e) { message.error(e instanceof Error ? e.message : "制作失败"); }
                    finally { setBusy(""); void useUserStore.getState().hydrateUser(); }
                },
            });
        } catch (e) { setBusy(""); message.error(e instanceof Error ? e.message : "报价失败"); }
    };
    const exportPage = async (long: boolean) => {
        setBusy(long ? "合成完整长图" : "制作上传包");
        try {
            const blob = long ? await exportLongImage(draft) : await exportDetailPackage(draft);
            saveAs(blob, `${profile.id}-详情页.${long ? "jpg" : "zip"}`);
            message.success(long ? "长图已导出" : "已导出图片、文案和尺寸清单");
        } catch (e) { message.error(e instanceof Error ? e.message : "导出失败"); }
        finally { setBusy(""); }
    };
    const openView = (nextTab: "edit" | "preview") => {
        setTab(nextTab);
        window.setTimeout(() => {
            document.getElementById(nextTab === "edit" ? "detail-module-editor" : "detail-page-preview")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 0);
    };
    const saveVersion = async () => {
        setBusy("保存版本");
        try {
            const next = [{ id: crypto.randomUUID(), date: new Date().toLocaleString(), draft }, ...history];
            await detailStorage.setItem(`${storageKey}:history`, next); setHistory(next); message.success("已保存到本机版本记录");
        } catch { message.error("保存失败，请检查本地存储空间"); }
        finally { setBusy(""); }
    };

    return <div className="h-full overflow-auto bg-background text-foreground">
        <div className="mx-auto max-w-[1600px] space-y-5 p-5 lg:p-8">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div><h1 className="text-2xl font-semibold">详情页</h1><p className="mt-1 text-sm text-muted-foreground">平台策略 → 图文模块 → 连续排版 → 上传包</p></div>
                <div className="flex items-center gap-3 text-sm"><span className="text-muted-foreground">{busy || (saved ? "草稿已保存在本机" : "保存草稿中…")}</span><Button disabled={locked} onClick={() => void saveVersion()}>保存版本</Button></div>
            </header>
            {saveError && <p role="alert" className="text-red-500">{saveError}</p>}
            <div className="grid items-start gap-5 lg:grid-cols-[330px_minmax(0,1fr)]">
                <aside className="flex flex-col gap-4">
                    <fieldset disabled={locked} className={`${panel} flex min-w-0 flex-col gap-4`} style={{ padding: 20 }}>
                        <h2 className="font-semibold">1 · 平台与输出</h2>
                        <label className="block text-sm">目标平台<select aria-label="目标平台" className={`${control} mt-2`} value={draft.platform} onChange={e => switchPlatform(e.target.value)}>{detailProfiles.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
                        <div className="rounded-lg bg-primary/5 p-3 text-sm"><strong>{outputLabels[profile.output]} · {profile.width}px</strong><p className="mt-2 leading-6 text-muted-foreground">{profile.note}</p><p className="mt-2 text-xs text-muted-foreground">尺寸为制作预设，具体上传要求以平台后台为准。切换平台会重新规划模块，可先保存版本。</p></div>
                        {profile.id === "amazon" && <label className="block text-sm">A+ 模板<select aria-label="A+ 模板" className={`${control} mt-2`} value={draft.amazonTemplate} onChange={e => update({ amazonTemplate: e.target.value as DetailDraft["amazonTemplate"] })}><option value="basic">Basic 横幅 · 970 × 300</option><option value="premium">Premium 横幅 · 1464 × 600</option></select></label>}
                        <div className="grid grid-cols-2 gap-3"><label className="text-sm">目标市场<select aria-label="目标市场" className={`${control} mt-2`} value={draft.market} onChange={e => update({ market: e.target.value })}>{detailMarkets.map(market => <option key={market.value} value={market.value}>{market.label}</option>)}</select></label><label className="text-sm">文案语言<select className={`${control} mt-2`} value={draft.language} onChange={e => update({ language: e.target.value })}>{["简体中文", "English", "日本語", "Deutsch", "Français", "Español", "无文字"].map(v => <option key={v}>{v}</option>)}</select></label></div>
                        {profile.output === "slices" && <div className="space-y-2"><label className="text-sm">切片方式<select aria-label="切片方式" className={`${control} mt-2`} value={draft.sliceMode} onChange={e => update({ sliceMode: e.target.value as DetailDraft["sliceMode"] })}><option value="module">按模块切片（保留完整图文）</option><option value="fixed">按指定高度连续切片</option></select></label>{draft.sliceMode === "fixed" && <label className="block text-sm">每片高度（px）<input aria-label="切片高度" type="number" className={`${control} mt-2`} value={draft.sliceHeight} onChange={e => update({ sliceHeight: Number(e.target.value) })} /><span className="mt-1 block text-xs text-muted-foreground">末片保留实际高度；固定切点可能穿过文字或商品。</span></label>}</div>}
                    </fieldset>
                    <fieldset disabled={locked} className={`${panel} flex min-w-0 flex-col gap-4`} style={{ padding: 20 }}>
                        <h2 className="font-semibold">2 · 商品素材与事实</h2>
                        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border p-5 text-sm"><ImagePlus className="size-4" />上传实拍照片<input aria-label="上传实拍照片" type="file" accept="image/*" multiple className="sr-only" onChange={e => { void upload(Array.from(e.target.files || [])); e.target.value = ""; }} /></label>
                        <div className="grid grid-cols-3 gap-2">{draft.photos.map((photo, i) => <div key={photo.id} className="relative"><img src={photo.url} alt={photo.name} className="aspect-square w-full rounded-lg object-contain" /><button title="移除照片" className="absolute right-0 top-0 rounded bg-background p-1" onClick={() => update({ photos: draft.photos.filter(p => p.id !== photo.id) })}><Trash2 className="size-3" /></button><p className="truncate text-xs text-muted-foreground">{i + 1}. {photo.name}</p></div>)}</div>
                        {!profile.photoOnly && <p className="text-xs text-muted-foreground">AI 使用前 6 张照片锁定商品；所有照片均可分配给实拍模块。</p>}
                        <label className="block text-sm">已确认的商品事实<textarea className={`${control} mt-2`} rows={4} placeholder="商品名称、真实材质、尺寸、配件、用途。缺失信息留空，不推测。" value={draft.brief} onChange={e => update({ brief: e.target.value }, true)} /></label>
                        {!profile.photoOnly && <><label className="block text-sm">整页视觉风格<textarea className={`${control} mt-2`} rows={2} value={draft.style} onChange={e => update({ style: e.target.value }, true)} /></label><div className="flex gap-5 text-sm"><label className="flex items-center gap-2">底色<input type="color" value={draft.background} onChange={e => update({ background: e.target.value })} /></label><label className="flex items-center gap-2">文字<input type="color" value={draft.foreground} onChange={e => update({ foreground: e.target.value })} /></label></div></>}
                        <Button block disabled={locked || !enabled.length} onClick={() => void aiAction("plan", enabled)}>AI 规划{profile.photoOnly ? "拍摄内容" : "图文内容"}</Button>
                        {!profile.photoOnly && <label className="flex gap-2 text-sm leading-6"><input type="checkbox" checked={draft.confirmed} onChange={e => update({ confirmed: e.target.checked })} />已核对商品事实与启用模块的文案，不包含未确认的参数或承诺</label>}
                    </fieldset>
                    {history.length > 0 && <section className={`${panel} space-y-3`}><h2 className="font-semibold">本机版本记录</h2>{history.map(item => <div key={item.id} className="flex items-center justify-between gap-2 text-xs"><span>{profileFor(item.draft).label}<br />{item.date}</span><Button size="small" disabled={locked} onClick={() => { setDraft(item.draft); setTab("edit"); }}>恢复</Button><Button size="small" disabled={locked} onClick={async () => { try { const next = history.filter(h => h.id !== item.id); await detailStorage.setItem(`${storageKey}:history`, next); setHistory(next); } catch { message.error("删除失败"); } }}>删除</Button></div>)}</section>}
                </aside>
                <main className="space-y-4">
                    <section className={`${panel} flex flex-wrap items-center justify-between gap-3`}>
                        <div><h2 className="font-semibold">3 · 图文编排</h2><p className="mt-1 text-sm text-muted-foreground">{enabled.length} 个启用模块 · {ready} 个已有图片 · {profile.photoOnly ? "按原图比例输出" : `${profile.width} × ${profile.height}px / 模块`}</p></div>
                        <div className="flex flex-wrap gap-2"><Button type={tab === "edit" ? "primary" : "default"} aria-pressed={tab === "edit"} onClick={() => openView("edit")}>编辑模块</Button><Button type={tab === "preview" ? "primary" : "default"} aria-pressed={tab === "preview"} onClick={() => openView("preview")}>整页预览</Button>{!profile.photoOnly && <Button disabled={locked || !draft.confirmed} onClick={() => void aiAction("image")}>生成缺少的底图</Button>}</div>
                    </section>
                    {profile.photoOnly && <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">当前为实拍图库。请为每个模块选择对应照片；标题和正文只进入文案文件，不叠加在上传图片上。无需调用图片模型。</div>}
                    {tab === "edit" ? <div id="detail-module-editor" className="scroll-mt-6 space-y-4">{draft.modules.map((module, i) => <section key={module.id} className={`${panel} ${module.enabled ? "" : "opacity-60"}`}>
                        <div className="mb-4 flex items-center justify-between gap-2"><label className="flex items-center gap-2 font-medium"><input type="checkbox" disabled={locked} checked={module.enabled} onChange={e => edit(module.id, { enabled: e.target.checked })} />{String(i + 1).padStart(2, "0")} · {module.role}</label><div className="flex gap-1"><Button aria-label="上移模块" size="small" disabled={locked || i === 0} onClick={() => move(i, -1)} icon={<ArrowUp className="size-3" />} /><Button aria-label="下移模块" size="small" disabled={locked || i === draft.modules.length - 1} onClick={() => move(i, 1)} icon={<ArrowDown className="size-3" />} /><Button aria-label="删除模块" size="small" disabled={locked} onClick={() => update({ modules: draft.modules.filter(m => m.id !== module.id) })} icon={<Trash2 className="size-3" />} /></div></div>
                        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_240px]">
                            <fieldset disabled={locked} className="space-y-3">
                                <div className="grid grid-cols-2 gap-3"><label className="text-xs text-muted-foreground">模块名称<input className={`${control} mt-1`} value={module.role} onChange={e => edit(module.id, { role: e.target.value })} /></label><label className="text-xs text-muted-foreground">图片来源<select className={`${control} mt-1`} value={profile.photoOnly ? "photo" : module.source} onChange={e => edit(module.id, { source: e.target.value as DetailModule["source"] })}>{!profile.photoOnly && <option value="ai">AI 无字底图</option>}<option value="photo">上传的实拍照片</option></select></label></div>
                                {(profile.photoOnly || module.source === "photo") ? <label className="block text-xs text-muted-foreground">对应实拍<select aria-label={`${module.role}对应实拍`} className={`${control} mt-1`} value={module.photoId} onChange={e => edit(module.id, { photoId: e.target.value })}><option value="">请选择照片</option>{draft.photos.map((p, n) => <option key={p.id} value={p.id}>{n + 1}. {p.name}</option>)}</select></label> : <label className="block text-xs text-muted-foreground">画面说明（修改后需要重新生成底图）<textarea className={`${control} mt-1`} rows={2} value={module.visual} onChange={e => edit(module.id, { visual: e.target.value })} /></label>}
                                {(profile.photoOnly || module.source === "photo") && <label className="block text-xs text-muted-foreground">拍摄说明<textarea className={`${control} mt-1`} rows={2} value={module.visual} onChange={e => edit(module.id, { visual: e.target.value })} /></label>}
                                <label className="block text-xs text-muted-foreground">{profile.photoOnly ? "照片标题（仅导出文案）" : "标题（独立排字）"}<input className={`${control} mt-1`} value={module.title} placeholder="可留空；只写已确认信息" onChange={e => edit(module.id, { title: e.target.value })} /></label>
                                <label className="block text-xs text-muted-foreground">正文<textarea className={`${control} mt-1`} rows={2} value={module.body} placeholder="无需把文字交给图片模型绘制" onChange={e => edit(module.id, { body: e.target.value })} /></label>
                                {!profile.photoOnly && <div className="flex flex-wrap items-center gap-3"><select aria-label="模块版式" className={control} value={module.layout} onChange={e => edit(module.id, { layout: e.target.value as DetailModule["layout"] })}><option value="top">上文下图</option><option value="left">左文右图</option><option value="none">纯图</option></select>{module.source === "ai" && <><Button disabled={locked || !draft.confirmed || !module.enabled} onClick={() => void aiAction("image", [module])}>{module.image ? "重做底图" : module.error ? "重试底图" : "生成底图"}</Button>{!draft.confirmed && <span className="text-xs text-amber-500">请先勾选左侧“已核对商品事实与文案”</span>}{draft.confirmed && !module.enabled && <span className="text-xs text-muted-foreground">请先启用此模块</span>}</>}</div>}
                                {module.error && <p role="alert" className="text-xs text-red-500">{module.error}</p>}
                            </fieldset>
                            <div className="overflow-hidden rounded-lg border border-border"><ModulePreview module={module} draft={draft} /></div>
                        </div>
                    </section>)}<Button block disabled={locked} icon={<Plus className="size-4" />} onClick={() => update({ modules: [...draft.modules, { ...createModules(profile)[0], id: crypto.randomUUID(), role: "自定义模块", visual: "展示已确认的商品细节" }] })}>添加模块</Button></div> : <section id="detail-page-preview" className={`${panel} scroll-mt-6`}><p className="mb-5 text-sm text-muted-foreground">{profile.output === "slices" || profile.output === "sections" ? "按当前顺序连续拼接，预览与导出使用同一排版。" : "以下是独立上传的图片，长图仅用于检查顺序。"} 修改文字后即时重排。</p><div className={`mx-auto max-w-[500px] ${profile.output === "gallery" || profile.output === "aplus" ? "space-y-4" : ""}`}>{enabled.map(m => <ModulePreview key={m.id} module={m} draft={draft} />)}</div></section>}
                    <section className={`${panel} flex flex-wrap items-center justify-between gap-4`}><div><h2 className="font-semibold">4 · 导出交付</h2><p className="mt-1 text-sm text-muted-foreground">{outputLabels[profile.output]} · 有序图片 + 文案 + 尺寸清单</p></div><div className="flex flex-wrap gap-2">{!profile.photoOnly && <Button disabled={locked || ready !== enabled.length || !ready} onClick={() => void exportPage(true)}>导出完整长图 JPG</Button>}<Button type="primary" disabled={locked || ready !== enabled.length || !ready} icon={<Download className="size-4" />} onClick={() => void exportPage(false)}>导出{profile.output === "slices" ? "切片" : profile.output === "aplus" ? "A+" : "图片"}上传包 ZIP</Button></div></section>
                </main>
            </div>
        </div>
    </div>;
}
