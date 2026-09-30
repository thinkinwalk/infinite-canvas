import { useState, type ReactNode } from "react";
import { App, Button, Input, Select, Spin } from "antd";
import { ArrowRight, Download, ImagePlus, LockKeyhole, Printer } from "lucide-react";
import { saveAs } from "file-saver";

import { fetchImageBlob } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";

type Values = Record<string, string | string[]>;
export type PrintFileResult = { source: string; url: string };

const sizeOptions = [
    { value: "custom", label: "自定义" },
    { value: "A4-portrait", label: "A4 纵 (210×297)", width: 210, height: 297 },
    { value: "A4-landscape", label: "A4 横 (297×210)", width: 297, height: 210 },
    { value: "A3", label: "A3 (297×420)", width: 297, height: 420 },
    { value: "A5", label: "A5 (148×210)", width: 148, height: 210 },
    { value: "business-card", label: "名片 (90×54)", width: 90, height: 54 },
    { value: "square", label: "方形 (200×200)", width: 200, height: 200 },
    { value: "poster", label: "海报 (600×900)", width: 600, height: 900 },
    { value: "roll-up", label: "易拉宝 (800×2000)", width: 800, height: 2000 },
];

export default function PrintFileWorkspace({
    values,
    onChange,
    upload,
    footer,
    result,
    busy,
    onBack,
}: {
    values: Values;
    onChange: (changes: Values) => void;
    upload: ReactNode;
    footer: ReactNode;
    result: PrintFileResult | null;
    busy: boolean;
    onBack: () => void;
}) {
    const { message } = App.useApp();
    useThemeStore((state) => state.theme);
    const [downloading, setDownloading] = useState(false);
    const [locked, setLocked] = useState(true);
    const width = Number(values.widthMm || 210);
    const height = Number(values.heightMm || 297);
    const dpi = Number(values.dpi || 300);
    const source = result?.source || (typeof values.imageUrl === "string" ? values.imageUrl : "");
    const demoSource = "/examples/workbench/product.jpg";
    const showingDemo = !source;
    const pixels = `${Math.round((width * dpi) / 25.4)}×${Math.round((height * dpi) / 25.4)}px`;
    const selectedSize = sizeOptions.find((item) => item.width === width && item.height === height)?.value || "custom";
    const download = async () => {
        if (!result) return;
        setDownloading(true);
        try {
            saveAs(await fetchImageBlob(result.url), `印刷图-${width}x${height}mm-${dpi}dpi.png`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            setDownloading(false);
        }
    };
    const setSize = (value: string) => {
        const option = sizeOptions.find((item) => item.value === value);
        if (option?.width && option.height) onChange({ widthMm: String(option.width), heightMm: String(option.height) });
    };
    const toggle = (key: string, value: string) => onChange({ [key]: value });
    const changeDimension = (key: "widthMm" | "heightMm", raw: string) => {
        if (!locked || !raw) {
            onChange({ [key]: raw });
            return;
        }
        const next = Number(raw);
        if (!Number.isFinite(next) || next <= 0) {
            onChange({ [key]: raw });
            return;
        }
        if (key === "widthMm") onChange({ widthMm: raw, heightMm: String(Math.round(((next * height) / width) * 100) / 100) });
        else onChange({ heightMm: raw, widthMm: String(Math.round(((next * width) / height) * 100) / 100) });
    };

    return (
        <main className="h-full overflow-auto bg-[#f4f6f8] text-[#101828] dark:bg-[#0b0b0b] dark:text-stone-100">
            <div className="mx-auto min-h-full max-w-[1440px]">
                <div className="border-b border-[#e5e7eb] px-6 py-4 text-xs text-[#98a2b3] dark:border-stone-800 sm:px-8">
                    <button type="button" onClick={onBack} className="hover:text-[#344054] dark:hover:text-white">
                        创作工具
                    </button>
                    <span className="mx-2">›</span>
                    <span className="font-semibold text-[#101828] dark:text-stone-100">印刷图</span>
                </div>
                <div className="grid min-w-0 gap-5 p-4 sm:p-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <section className="flex min-w-0 flex-col gap-5 rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,.03)] dark:border-stone-800 dark:bg-stone-950" aria-label="印刷图参数">
                        <div className="flex items-start gap-3">
                            <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#e8f0ff] text-[#2f80ed] dark:bg-blue-950/40 dark:text-blue-300">
                                <Printer className="size-5" />
                            </div>
                            <div>
                                <h1 className="text-base font-semibold">印刷图</h1>
                                <p className="mt-1 text-xs leading-5 text-[#667085] dark:text-stone-400">按 DPI + 成品尺寸生成符合印刷标准的高清文件</p>
                            </div>
                        </div>
                        <div>
                            <h2 className="mb-2 text-sm font-medium text-[#344054] dark:text-stone-200">
                                上传图片 <span className="text-[#98a2b3]">0/12</span>
                            </h2>
                            {upload}
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-sm font-medium text-[#344054] dark:text-stone-200">成品尺寸</h2>
                            <Select className="w-full" value={selectedSize} disabled={busy} options={sizeOptions.map(({ value, label }) => ({ value, label }))} onChange={setSize} />
                        </div>
                        <div className="flex items-center gap-2">
                            <label className="sr-only" htmlFor="print-width">
                                宽
                            </label>
                            <Input id="print-width" type="number" min={1} value={String(values.widthMm || 210)} disabled={busy} onChange={(event) => changeDimension("widthMm", event.target.value)} addonBefore="宽" />
                            <button
                                type="button"
                                title={locked ? "解除比例锁定" : "锁定比例"}
                                aria-label={locked ? "解除比例锁定" : "锁定比例"}
                                className={`grid size-9 shrink-0 place-items-center rounded-lg border ${locked ? "border-[#4f46e5] text-[#4f46e5]" : "border-[#d0d5dd] text-[#98a2b3]"}`}
                                disabled={busy}
                                onClick={() => setLocked((current) => !current)}
                            >
                                <LockKeyhole className="size-4" />
                            </button>
                            <label className="sr-only" htmlFor="print-height">
                                高
                            </label>
                            <Input id="print-height" type="number" min={1} value={String(values.heightMm || 297)} disabled={busy} onChange={(event) => changeDimension("heightMm", event.target.value)} addonBefore="高" />
                            <span className="text-xs text-[#98a2b3]">mm</span>
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-sm font-medium text-[#344054] dark:text-stone-200">
                                DPI <span className="text-xs font-normal text-[#98a2b3]">· 印刷标准</span>
                            </h2>
                            <div className="flex items-center gap-3">
                                <input type="range" min={150} max={600} step={150} value={dpi} disabled={busy} onChange={(event) => onChange({ dpi: event.target.value })} className="min-w-0 flex-1 accent-[#3478f6]" />
                                <Input className="w-20" type="number" min={150} max={600} step={150} value={String(values.dpi || 300)} disabled={busy} onChange={(event) => onChange({ dpi: event.target.value })} />
                            </div>
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-sm font-medium text-[#344054] dark:text-stone-200">裁切方式</h2>
                            <div className="grid grid-cols-2 gap-2">
                                {["完整·留白", "填满·裁切"].map((label, index) => {
                                    const value = index === 0 ? "完整留白" : "填满裁切";
                                    const active = values.fit === value || (!values.fit && index === 0);
                                    return (
                                        <button
                                            key={value}
                                            type="button"
                                            disabled={busy}
                                            aria-pressed={active}
                                            onClick={() => toggle("fit", value)}
                                            className={`h-9 rounded-lg border text-sm transition ${active ? "border-[#4f46e5] text-[#4f46e5]" : "border-[#e4e7ec] text-[#667085] hover:border-[#98a2b3] dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-500"}`}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        <div className="rounded-lg bg-[#f2f4f7] px-3 py-2 text-center text-xs text-[#667085] dark:bg-stone-900 dark:text-stone-400">
                            输出像素 · <strong className="text-[#344054] dark:text-stone-200">{pixels}</strong>
                        </div>
                        <p className="text-xs leading-5 text-[#98a2b3] dark:text-stone-500">提示:本工具依据成品尺寸+DPI 排版重采样不增加画面细节。原图偏小或更清晰,先用「AI 变清晰」放大再生成。</p>
                        <div className="mt-auto border-t border-[#eaecf0] pt-4 dark:border-stone-800">{footer}</div>
                    </section>
                    <section className="min-w-0 rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,.03)] dark:border-stone-800 dark:bg-stone-950 sm:p-6" aria-label="印刷图预览">
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-base font-semibold">印刷图队列</h2>
                            {result ? (
                                <Button icon={<Download className="size-4" />} loading={downloading} onClick={() => void download()}>
                                    下载 PNG
                                </Button>
                            ) : null}
                        </div>
                        <Spin spinning={busy} tip="正在生成印刷图">
                            <div className="flex min-h-[610px] flex-col items-center justify-center px-2 py-8">
                                <h3 className="mb-7 text-center text-xl font-semibold text-[#5b4bff]">上传图,一键生成印刷级文件</h3>
                                {showingDemo ? (
                                    <div className="grid w-full max-w-[700px] items-center gap-6 sm:grid-cols-[1fr_auto_1fr]">
                                        <PrintPreview src={demoSource} label="原图" />
                                        <ArrowRight className="mx-auto size-8 text-[#5b4bff]" />
                                        <PrintPreview src={demoSource} label="效果" result demo />
                                    </div>
                                ) : source ? (
                                    <div className="grid w-full max-w-[700px] items-center gap-6 sm:grid-cols-[1fr_auto_1fr]">
                                        <PrintPreview src={source} label="原图" />
                                        <ArrowRight className="mx-auto size-8 text-[#5b4bff]" />
                                        {result ? <PrintPreview src={result.url} label="效果" result /> : <PreviewEmpty />}
                                    </div>
                                ) : (
                                    <PreviewEmpty wide />
                                )}
                            </div>
                        </Spin>
                    </section>
                </div>
            </div>
        </main>
    );
}

function PrintPreview({ src, label, result = false, demo = false }: { src: string; label: string; result?: boolean; demo?: boolean }) {
    return (
        <figure className="min-w-0 text-center">
            <div className={`aspect-square overflow-hidden rounded-2xl border bg-white p-1 dark:bg-stone-900 ${result ? "border-[#4f46e5] ring-2 ring-[#e0e7ff]" : "border-[#e5e7eb] dark:border-stone-700"}`}>
                <img src={src} alt={label} className="size-full rounded-xl object-contain" style={demo && result ? { filter: "saturate(1.12) contrast(1.06)" } : undefined} />
            </div>
            <figcaption className={`mt-2 text-xs ${result ? "text-[#4f46e5]" : "text-[#98a2b3]"}`}>{label}</figcaption>
        </figure>
    );
}

function PreviewEmpty({ wide = false }: { wide?: boolean }) {
    return (
        <div
            className={`${wide ? "aspect-[16/9] w-full max-w-[700px]" : "aspect-square w-full"} flex items-center justify-center rounded-2xl border border-dashed border-[#d0d5dd] bg-[#fafafa] text-center text-[#98a2b3] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-500`}
        >
            <div>
                <ImagePlus className="mx-auto mb-3 size-9" />
                <p className="text-sm">处理后将在这里对照原图和结果</p>
            </div>
        </div>
    );
}
