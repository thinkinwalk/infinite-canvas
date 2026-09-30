import { useEffect, useState, type ReactNode } from "react";
import { App, Breadcrumb, Button, Image, Segmented, Spin, theme } from "antd";
import { ChevronsLeftRight, Download, Scissors } from "lucide-react";
import { Link } from "react-router-dom";
import { saveAs } from "file-saver";

import { fetchImageBlob } from "@/services/image-storage";

type Values = Record<string, string | string[]>;
export type CutoutResult = { source: string; url: string; feather: string; background: string };

export default function CutoutWorkspace({ values, onChange, upload, footer, result, busy }: {
    values: Values;
    onChange: (changes: Values) => void;
    upload: ReactNode;
    footer: ReactNode;
    result: CutoutResult | null;
    busy: boolean;
}) {
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const [split, setSplit] = useState(50);
    const [dimensions, setDimensions] = useState({ width: 960, height: 1280 });
    const [failed, setFailed] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const source = result?.source || "/examples/cutout/source.jpg";
    const output = result?.url || "/examples/cutout/result.png";
    useEffect(() => { setSplit(50); setFailed(false); }, [source, output]);
    const download = async () => {
        setDownloading(true);
        try {
            saveAs(await fetchImageBlob(output), "AI抠图.png");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败，请重试");
        } finally {
            setDownloading(false);
        }
    };

    return <main className="h-full overflow-auto" style={{ background: token.colorBgLayout, color: token.colorText }}>
        <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
            <Breadcrumb items={[{ title: <Link to="/create?medium=image">创作工具</Link> }, { title: "AI 抠图" }]} />
            <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
                <section className="flex min-w-0 flex-col gap-5 border-b pb-6 lg:min-h-[620px] lg:border-b-0 lg:border-r lg:pr-5" style={{ borderColor: token.colorBorderSecondary }} aria-label="抠图参数">
                    <div className="flex items-start gap-3">
                        <Scissors className="mt-1 size-6 shrink-0" style={{ color: token.colorPrimary }} />
                        <div><h1 className="text-base font-semibold">AI 抠图</h1><p className="mt-1 text-xs leading-5" style={{ color: token.colorTextSecondary }}>自动识别主体去背景，保留原图细节</p></div>
                    </div>
                    <div><h2 className="mb-2 text-sm">上传图片</h2>{upload}</div>
                    <div className="space-y-2">
                        <h2 className="text-sm">边缘羽化</h2>
                        <Segmented aria-label="边缘羽化" options={["关", "弱", "强"]} value={String(values.feather || "关")} disabled={busy} onChange={(value) => onChange({ feather: String(value) })} />
                    </div>
                    <div className="space-y-2">
                        <h2 className="text-sm">输出背景</h2>
                        <Segmented aria-label="输出背景" options={["透明", "白底", "纯色"]} value={String(values.background || "透明")} disabled={busy} onChange={(value) => onChange({ background: String(value) })} />
                        {values.background === "纯色" ? <div className="flex items-center gap-3 pt-1">
                            <input type="color" title="背景颜色" aria-label="背景颜色" className="h-8 w-10 cursor-pointer border-0 bg-transparent p-0" value={String(values.backgroundColor || "#3b82f6")} disabled={busy} onChange={(event) => onChange({ backgroundColor: event.target.value })} />
                            <span className="text-xs" style={{ color: token.colorTextSecondary }}>{String(values.backgroundColor || "#3b82f6").toUpperCase()}</span>
                        </div> : null}
                    </div>
                    <div className="mt-auto pt-3">{footer}</div>
                </section>
                <section className="min-w-0" aria-label="处理结果">
                    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold">处理结果</h2>
                        {result ? <div className="flex items-center gap-2"><span className="text-xs" style={{ color: token.colorTextSecondary }}>已完成 · {result.background} · 羽化{result.feather}</span><Button icon={<Download className="size-4" />} loading={downloading} disabled={busy} onClick={() => void download()}>下载 PNG</Button></div> : null}
                    </div>
                    <Spin spinning={busy} tip="正在抠图">
                        <div className="flex min-h-[500px] flex-col items-center justify-center gap-5 py-8">
                            {!result ? <h3 className="text-center text-lg font-semibold" style={{ color: token.colorPrimary }}>一键抠出主体，透明底保留原图细节</h3> : null}
                            {failed ? <p role="alert" className="text-sm" style={{ color: token.colorError }}>图片加载失败，请刷新重试</p> : <>
                                <div className="w-full max-w-[560px]">
                                    <div className="relative mx-auto overflow-hidden rounded-md border focus-within:outline focus-within:outline-2 focus-within:outline-blue-500" style={{ width: `min(100%, ${480 * dimensions.width / dimensions.height}px)`, aspectRatio: `${dimensions.width}/${dimensions.height}`, borderColor: token.colorBorderSecondary, backgroundColor: "#fff", backgroundImage: "conic-gradient(#e5e7eb 25%, transparent 0 50%, #e5e7eb 0 75%, transparent 0)", backgroundSize: "20px 20px" }}>
                                        <img src={output} alt={result ? "抠图结果" : "抠图示例结果"} className="absolute inset-0 size-full object-contain" onError={() => setFailed(true)} />
                                        <img src={source} alt={result ? "上传原图" : "抠图示例原图"} className="absolute inset-0 size-full object-contain" style={{ clipPath: `inset(0 0 0 ${split}%)` }} onLoad={(event) => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
                                        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${split}%` }} />
                                        <div className="pointer-events-none absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-black shadow" style={{ left: `${split}%` }}><ChevronsLeftRight className="size-4" /></div>
                                        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white">{result ? "处理后" : "示例 · 处理后"}</span>
                                        <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white">原图</span>
                                        <input type="range" min={0} max={100} step={1} value={split} aria-label="原图与抠图结果对比" className="absolute inset-0 size-full cursor-ew-resize opacity-0" onChange={(event) => setSplit(Number(event.target.value))} />
                                    </div>
                                </div>
                                {result ? <Image.PreviewGroup><div className="flex flex-wrap justify-center gap-5">{[{ url: source, title: "原图" }, { url: output, title: "处理结果" }].map((item) => <div key={item.title} className="text-center"><Image src={item.url} alt={item.title} width={72} height={72} style={{ objectFit: "contain", background: token.colorFillSecondary }} /><p className="mt-1 text-xs" style={{ color: token.colorTextSecondary }}>{item.title}</p></div>)}</div></Image.PreviewGroup> : null}
                            </>}
                        </div>
                    </Spin>
                </section>
            </div>
        </div>
    </main>;
}
