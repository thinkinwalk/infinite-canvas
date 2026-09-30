import { useState, type ReactNode } from "react";
import { App, Button, Input, Select, Spin, theme } from "antd";
import { ArrowRight, Download, Stamp } from "lucide-react";
import { saveAs } from "file-saver";

import { fetchImageBlob } from "@/services/image-storage";

type Values = Record<string, string | string[]>;
export type PrintExtractResult = { source: string; url: string };

const modes = [
    { value: "基础", title: "基础模式", description: "适合边缘清楚、遮挡较少的单独印花" },
    { value: "高阶", title: "高阶模式", description: "加强褶皱还原与缺失边缘补全，适合复杂商品图" },
];

export default function PrintExtractWorkspace({ values, onChange, upload, footer, result, busy }: {
    values: Values;
    onChange: (changes: Values) => void;
    upload: ReactNode;
    footer: ReactNode;
    result: PrintExtractResult | null;
    busy: boolean;
}) {
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const [downloading, setDownloading] = useState(false);
    const source = result?.source || (typeof values.imageUrl === "string" ? values.imageUrl : "");
    const demo = !source;
    const download = async () => {
        if (!result) return;
        setDownloading(true);
        try {
            saveAs(await fetchImageBlob(result.url), "印花提取.png");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            setDownloading(false);
        }
    };

    return <main className="h-full overflow-x-hidden overflow-y-auto lg:overflow-y-hidden" style={{ background: token.colorBgLayout, color: token.colorText }}>
        <div className="mx-auto grid min-h-full w-full max-w-[1440px] grid-rows-[auto_1fr] lg:h-full lg:min-h-0 lg:grid-rows-[auto_minmax(0,1fr)]">
            <div className="border-b px-4 py-4 sm:px-6" style={{ borderColor: token.colorBorderSecondary }}>
                <Button type="link" className="h-auto p-0 text-xs" href="/create?medium=image">创作工具</Button>
                <span className="mx-2 text-xs" style={{ color: token.colorTextTertiary }}>/</span>
                <span className="text-xs">印花提取</span>
            </div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] lg:min-h-0 lg:grid-cols-[340px_minmax(0,1fr)]">
                <section className="flex min-w-0 max-w-full flex-col gap-5 overflow-hidden border-b p-5 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-6" style={{ borderColor: token.colorBorderSecondary }} aria-label="印花提取参数">
                    <div className="flex items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-md" style={{ background: token.colorFillSecondary }}><Stamp className="size-5" /></div>
                        <div><h1 className="text-base font-semibold">印花提取</h1><p className="mt-1 text-xs leading-5" style={{ color: token.colorTextSecondary }}>从服装或商品图中提取独立印花素材</p></div>
                    </div>

                    <div><h2 className="mb-2 text-sm">上传图片 <span style={{ color: token.colorError }}>*</span></h2>{upload}</div>

                    <fieldset className="space-y-2">
                        <legend className="mb-2 text-sm">模式 <span style={{ color: token.colorError }}>*</span></legend>
                        {modes.map((item) => {
                            const active = values.mode === item.value;
                            return <button key={item.value} type="button" aria-pressed={active} disabled={busy} onClick={() => onChange({ mode: item.value })} className="w-full rounded-md border p-3 text-left transition disabled:opacity-60" style={{ borderColor: active ? token.colorPrimary : token.colorBorderSecondary, background: active ? token.colorFillSecondary : token.colorBgContainer }}>
                                <span className="block text-sm font-medium">{item.title}</span>
                                <span className="mt-1 block text-xs leading-5" style={{ color: token.colorTextSecondary }}>{item.description}</span>
                            </button>;
                        })}
                    </fieldset>

                    <div className="space-y-2"><label className="text-sm" htmlFor="print-category">品类 <span style={{ color: token.colorError }}>*</span></label><Select id="print-category" className="w-full" value={String(values.category || "通用")} disabled={busy} options={["通用", "服装", "家纺", "箱包", "包装"].map((value) => ({ value, label: value }))} onChange={(category) => onChange({ category })} /></div>
                    <div className="space-y-2"><label className="text-sm" htmlFor="print-ratio">比例 <span style={{ color: token.colorError }}>*</span></label><Select id="print-ratio" className="w-full" value={String(values.aspectRatio || "自动")} disabled={busy} options={["自动", "1:1", "3:4", "4:3", "16:9", "9:16"].map((value) => ({ value, label: value }))} onChange={(aspectRatio) => onChange({ aspectRatio })} /></div>

                    <div className="space-y-2"><h2 className="text-sm">边缘补全</h2><div className="flex gap-2">{["不补全", "智能补全"].map((value) => <button key={value} type="button" disabled={busy} aria-pressed={values.edgeCompletion === value} onClick={() => onChange({ edgeCompletion: value })} className="rounded-md border px-3 py-2 text-sm transition disabled:opacity-60" style={{ borderColor: values.edgeCompletion === value ? token.colorPrimary : "transparent", background: values.edgeCompletion === value ? token.colorPrimary : token.colorFillSecondary, color: values.edgeCompletion === value ? token.colorTextLightSolid : token.colorText }}>{value}</button>)}</div></div>
                    <div className="space-y-2"><h2 className="text-sm">清晰度</h2><div className="flex gap-2">{["标准", "高清"].map((value) => <button key={value} type="button" disabled={busy} aria-pressed={values.quality === value} onClick={() => onChange({ quality: value })} className="rounded-md border px-3 py-2 text-sm transition disabled:opacity-60" style={{ borderColor: values.quality === value ? token.colorPrimary : "transparent", background: values.quality === value ? token.colorPrimary : token.colorFillSecondary, color: values.quality === value ? token.colorTextLightSolid : token.colorText }}>{value}</button>)}</div></div>
                    <div className="space-y-2"><label className="text-sm" htmlFor="print-background">输出背景</label><Select id="print-background" className="w-full" value={String(values.background || "透明")} disabled={busy} options={["透明", "白底"].map((value) => ({ value, label: value }))} onChange={(background) => onChange({ background })} /></div>
                    <div className="space-y-2"><label className="text-sm" htmlFor="print-prompt">补充要求</label><Input.TextArea id="print-prompt" rows={3} maxLength={300} showCount value={String(values.prompt || "")} disabled={busy} placeholder="例如：只保留胸前主图案，去除文字标签" onChange={(event) => onChange({ prompt: event.target.value })} /></div>
                    <div className="mt-auto border-t pt-4" style={{ borderColor: token.colorBorderSecondary }}>{footer}</div>
                </section>

                <section className="min-w-0 p-5 lg:overflow-y-auto lg:p-6" aria-label="处理结果">
                    <div className="flex min-h-9 items-center justify-between gap-3"><h2 className="text-sm font-semibold">处理结果</h2>{result ? <Button icon={<Download className="size-4" />} loading={downloading} disabled={busy} onClick={() => void download()}>下载 PNG</Button> : null}</div>
                    <Spin spinning={busy} tip="正在提取印花">
                        <div className="flex min-h-[560px] flex-col items-center justify-center py-8">
                            <h3 className="text-center text-lg font-semibold">成品图上的印花，一键提取成独立素材</h3>
                            <div className="mt-8 grid w-full max-w-[720px] items-center gap-5 sm:grid-cols-[1fr_auto_1fr]">
                                <PrintImage src={source || "/examples/print-extract/source.jpg"} label={demo ? "示例原图" : "原图"} />
                                <ArrowRight className="mx-auto size-6" style={{ color: token.colorTextTertiary }} />
                                {result || demo ? <PrintImage src={result?.url || "/examples/print-extract/result.png"} label={demo ? "示例效果" : "提取结果"} result transparent={!demo && values.background === "透明"} /> : <div className="flex aspect-square items-center justify-center rounded-md border border-dashed" style={{ borderColor: token.colorBorder, color: token.colorTextTertiary }}><div className="text-center"><Stamp className="mx-auto mb-2 size-8" /><p className="text-sm">生成后显示独立印花</p></div></div>}
                            </div>
                            {demo ? <p className="mt-5 text-center text-xs" style={{ color: token.colorTextTertiary }}>本站实测示例 · 原图：<a href="https://commons.wikimedia.org/wiki/File:Floral_pillow_(6226885571).jpg" target="_blank" rel="noreferrer" className="underline">in pastel / CC BY 2.0</a></p> : null}
                        </div>
                    </Spin>
                </section>
            </div>
        </div>
    </main>;
}

function PrintImage({ src, label, result = false, transparent = false }: { src: string; label: string; result?: boolean; transparent?: boolean }) {
    return <figure className="min-w-0 text-center"><div className="aspect-square overflow-hidden rounded-md border p-2" style={{ borderColor: result ? "var(--ant-color-primary)" : "var(--ant-color-border-secondary)", backgroundColor: "#fff", backgroundImage: transparent ? "conic-gradient(#e5e7eb 25%, transparent 0 50%, #e5e7eb 0 75%, transparent 0)" : undefined, backgroundSize: transparent ? "20px 20px" : undefined }}><img src={src} alt={label} className="size-full object-contain" /></div><figcaption className="mt-2 text-xs">{label}</figcaption></figure>;
}
