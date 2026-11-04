import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, Empty, Input, InputNumber, Slider, Spin, Upload, theme } from "antd";
import { AudioWaveform, FolderOpen, Play, Scissors, Upload as UploadIcon, X } from "lucide-react";
import { Link } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { formatDuration } from "@/lib/image-utils";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { extractVoiceReference, workbenchMediaBlob } from "@/services/api/video-worker";
import { useAssetStore } from "@/stores/use-asset-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { saveVoiceAsset } from "./save-voice-asset";

type VideoSource = UploadedFile & { name: string };
type Range = [number, number];

function seconds(value: number) {
    return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

export default function VideoVoiceExtractPage() {
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const worker = useVideoWorkbenchStore((state) => state.worker);
    const hydrated = useVideoWorkbenchStore((state) => state.hydrated);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const [savedAssetId, setSavedAssetId] = useState("");
    const savedAsset = useAssetStore((state) => state.assets.find((asset) => asset.id === savedAssetId));
    const [source, setSource] = useState<VideoSource | null>(null);
    const [range, setRange] = useState<Range>([0, 0]);
    const [sample, setSample] = useState<UploadedFile | null>(null);
    const [sampleName, setSampleName] = useState("");
    const [referenceText, setReferenceText] = useState("");
    const [assetOpen, setAssetOpen] = useState(false);
    const [busy, setBusy] = useState<"upload" | "extract" | "save" | "">("");
    const [step, setStep] = useState("");
    const [error, setError] = useState("");
    const controller = useRef<AbortController | null>(null);
    const duration = (source?.durationMs || 0) / 1000;
    const validRange = Boolean(source && duration > 0 && range[0] >= 0 && range[1] > range[0] && range[1] <= duration);
    const locked = Boolean(busy) || !hydrated;
    const saved = savedAsset?.kind === "audio" && savedAsset.data.storageKey === sample?.storageKey
        && savedAsset.title === sampleName.trim() && savedAsset.note === referenceText.trim();

    useEffect(() => () => controller.current?.abort(), []);

    const applySource = (next: VideoSource) => {
        const nextDuration = (next.durationMs || 0) / 1000;
        const end = Math.min(nextDuration, 15);
        setSource(next);
        setRange([0, end]);
        setSample(null);
        setSavedAssetId("");
        setError("");
        setSampleName(`${next.name.replace(/\.[^.]+$/, "")} 音色`);
        setReferenceText("");
    };

    const readSource = async (file: File) => {
        setBusy("upload");
        setError("");
        try {
            if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) throw new Error("请选择可播放的视频文件");
            const stored = await uploadMediaFile(file, "voice-source");
            if (!stored.durationMs) throw new Error("无法读取视频时长，请更换可播放的视频");
            applySource({ ...stored, name: file.name });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "视频读取失败");
        } finally {
            setBusy("");
        }
    };

    const insertAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind !== "video") return;
        setAssetOpen(false);
        setBusy("upload");
        setError("");
        try {
            const blob = await workbenchMediaBlob({ url: payload.url, storageKey: payload.storageKey || "", mimeType: "video/mp4", bytes: 0 });
            const stored = await uploadMediaFile(blob, "voice-source");
            if (!stored.durationMs) throw new Error("无法读取视频时长，请更换可播放的视频");
            applySource({ ...stored, name: payload.title });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "读取视频资产失败");
        } finally {
            setBusy("");
        }
    };

    const extract = async () => {
        if (!source || !validRange || controller.current) return;
        const abort = new AbortController();
        controller.current = abort;
        setBusy("extract");
        setStep("准备视频");
        setError("");
        try {
            const result = await extractVoiceReference(worker, source, range[0], range[1], abort.signal, setStep);
            abort.signal.throwIfAborted();
            setSample(result.media);
            setSavedAssetId("");
            setReferenceText(result.transcript);
            if (result.transcriptSource === "subtitle-track" || result.transcriptSource === "burned-in-subtitle") {
                message.success("已优先提取视频字幕，请试听并核对原文");
            } else if (result.transcriptSource === "speech") {
                message.success("未发现可用字幕，已识别语音原文，请试听并核对");
            } else {
                message.warning("参考音频已生成，未能提取字幕或识别语音；可试听后手动填写原文");
            }
        } catch (cause) {
            if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "音色提取失败");
        } finally {
            controller.current = null;
            setBusy("");
            setStep("");
        }
    };

    const save = async () => {
        if (!sample || !sampleName.trim() || saved || controller.current) return;
        const abort = new AbortController();
        controller.current = abort;
        setBusy("save");
        setError("");
        try {
            setSavedAssetId(await saveVoiceAsset(sample, sampleName, referenceText));
            message.success("人物音色已保存到本浏览器素材库");
        } catch (cause) {
            if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "保存音色失败");
        } finally {
            controller.current = null;
            setBusy("");
        }
    };

    return (
        <main className="flex h-full min-h-0 flex-col" style={{ color: token.colorText }}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <Link to="/video" className="text-sm" style={{ color: token.colorTextSecondary }}>视频制作</Link>
                    <h1 className="flex items-center gap-2 text-lg font-semibold"><AudioWaveform size={19} />音色提取</h1>
                </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6">
                <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <section className="min-w-0 space-y-4 rounded-xl border p-4" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h2 className="m-0 text-base font-medium">选择视频片段</h2>
                                <p className="m-0 text-xs" style={{ color: token.colorTextSecondary }}>优先选择目标人物单独、清晰讲话且背景音乐较弱的区间。</p>
                            </div>
                            <div className="flex gap-1">
                                <Upload
                                    accept="video/*"
                                    showUploadList={false}
                                    disabled={locked}
                                    beforeUpload={(file) => {
                                        void readSource(file);
                                        return Upload.LIST_IGNORE;
                                    }}
                                >
                                    <Button size="small" icon={<UploadIcon size={14} />} disabled={locked}>上传视频</Button>
                                </Upload>
                                <Button size="small" icon={<FolderOpen size={14} />} disabled={locked} onClick={() => setAssetOpen(true)}>选择资产</Button>
                            </div>
                        </div>
                        {source ? (
                            <div className="space-y-3">
                                <video
                                    src={source.url}
                                    controls
                                    className="max-h-[55dvh] w-full rounded-lg bg-black"
                                    onTimeUpdate={(event) => {
                                        const video = event.currentTarget;
                                        if (video.currentTime >= range[1] && video.currentTime > range[0]) video.pause();
                                    }}
                                    onPlay={(event) => {
                                        const video = event.currentTarget;
                                        if (video.currentTime < range[0] || video.currentTime >= range[1]) video.currentTime = range[0];
                                    }}
                                />
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span className="min-w-0 truncate" title={source.name}>{source.name}</span>
                                    <span className="shrink-0" style={{ color: token.colorTextSecondary }}>{formatDuration(source.durationMs || 0)}</span>
                                </div>
                                <Slider
                                    range
                                    min={0}
                                    max={duration}
                                    step={0.1}
                                    value={range}
                                    disabled={locked}
                                    onChange={(value) => setRange(value as Range)}
                                />
                                <div className="flex flex-wrap items-center gap-2 text-sm">
                                    <span>开始</span>
                                    <InputNumber min={0} max={duration} step={0.1} value={range[0]} disabled={locked} onChange={(value) => setRange([value || 0, range[1]])} />
                                    <span>结束</span>
                                    <InputNumber min={0} max={duration} step={0.1} value={range[1]} disabled={locked} onChange={(value) => setRange([range[0], value || 0])} />
                                    <span style={{ color: token.colorTextSecondary }}>选中 {seconds(Math.max(0, range[1] - range[0]))} 秒</span>
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="text-xs" style={{ color: token.colorTextSecondary }}>建议使用 3–15 秒的清晰人声；背景音乐越明显，识别和音色效果越容易受影响。</span>
                                    <Button type="primary" icon={<Scissors size={15} />} loading={busy === "extract"} disabled={locked || !validRange} onClick={() => void extract()}>提取参考音频</Button>
                                </div>
                                {busy === "extract" && <div className="flex items-center gap-2 text-xs" role="status"><Spin size="small" />{step || "处理中…"}</div>}
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="上传视频或从我的资产选择视频" className="py-20" />
                        )}
                    </section>
                    <section className="min-w-0 space-y-4 rounded-xl border p-4" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
                        <div>
                            <h2 className="m-0 text-base font-medium">人物音色素材</h2>
                            <p className="m-0 text-xs" style={{ color: token.colorTextSecondary }}>优先使用视频字幕；没有可用字幕时再识别语音。请试听、核对后保存。</p>
                        </div>
                        {sample ? (
                            <>
                                <audio controls preload="metadata" src={sample.url} className="w-full" aria-label="参考音频试听" />
                                <Input value={sampleName} disabled={locked} placeholder="音色名称，例如：店主声音" onChange={(event) => setSampleName(event.target.value)} />
                                <Input.TextArea
                                    value={referenceText}
                                    disabled={locked}
                                    rows={5}
                                    placeholder="字幕或识别原文，可核对修改；留空也可保存音色"
                                    onChange={(event) => setReferenceText(event.target.value)}
                                />
                                <Button type="primary" block icon={<AudioWaveform size={15} />} loading={busy === "save"} disabled={locked || !assetsHydrated || !sampleName.trim() || saved} onClick={() => void save()}>{saved ? "已保存到素材库" : "保存到素材库"}</Button>
                                <p className="m-0 text-xs" style={{ color: token.colorTextSecondary }}>音频保存在当前浏览器的素材库。</p>
                            </>
                        ) : (
                            <div className="flex min-h-56 items-center justify-center rounded-lg border border-dashed" style={{ borderColor: token.colorBorderSecondary }}>
                                <div className="text-center text-sm" style={{ color: token.colorTextSecondary }}><Play className="mx-auto mb-2 size-5" />提取完成后在这里试听</div>
                            </div>
                        )}
                        {error && <Alert type="error" showIcon title={error} closable onClose={() => setError("")} />}
                        {busy && busy !== "extract" && <div className="text-xs" role="status" style={{ color: token.colorTextSecondary }}>{busy === "upload" ? "正在读取视频…" : "正在保存音色…"}</div>}
                        {busy === "extract" && <Button type="text" size="small" icon={<X size={14} />} onClick={() => controller.current?.abort()}>取消</Button>}
                    </section>
                </div>
            </div>
            <AssetPickerModal open={assetOpen} allowedKinds={["video"]} onClose={() => setAssetOpen(false)} onInsert={(payload) => void insertAsset(payload)} />
        </main>
    );
}
