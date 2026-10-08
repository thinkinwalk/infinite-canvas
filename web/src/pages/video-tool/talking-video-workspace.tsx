import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Card, Collapse, Empty, Input, Select, Space, Spin, Upload, theme } from "antd";
import { ArrowLeft, Download, FolderPlus, Grid2X2, UploadCloud, X } from "lucide-react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { imageToDataUrl } from "@/services/image-storage";
import { uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { getReplicateModels, publicServiceText, type ReplicateQuote } from "@/services/api/replicate";
import { workbenchMediaBlob } from "@/services/api/video-worker";
import { useUserStore } from "@/stores/use-user-store";
import { digitalSystemSpeakers } from "./digital-human-request";
import { restoreWorkbenchFile, stageLabels, useVideoWorkbench } from "./use-video-workbench";

export default function TalkingVideoWorkspace({ tool }: { tool: "photo-talk" | "lipsync" }) {
    const wb = useVideoWorkbench(tool);
    const { draft: d, busy } = wb;
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const session = useUserStore((s) => s.token);
    const [uploading, setUploading] = useState(false);
    const [assetOpen, setAssetOpen] = useState(false);
    const [viewed, setViewed] = useState<UploadedFile | null>(null);
    const [quote, setQuote] = useState<ReplicateQuote | null>(null);
    const [quoting, setQuoting] = useState(false);
    const [quoteError, setQuoteError] = useState("");
    const [models, setModels] = useState<ReplicateQuote[]>([]);
    const [previewError, setPreviewError] = useState(false);
    const uploadLock = useRef(false);
    const quoteRequest = useRef<AbortController | null>(null);
    const photo = tool === "photo-talk";
    const title = photo ? "照片说话" : "视频对口型";
    const kind = photo ? "image" : "video";
    const accept = photo ? "image/*" : "video/*";
    const avatar = d.media.find((m) => m.role === "avatar" && m.kind === kind);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask));
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const model = models.find((m) => m.operation === (photo ? "digital-human" : "lipsync"));
    const locked = busy || uploading;
    const blocked = pending ? "已有任务，请先恢复查询核对结果" : !avatar ? `请上传人物${photo ? "照片" : "视频"}` : !d.speech ? "请上传或生成音频" : !session ? "请先登录" : model && !model.available ? publicServiceText(model.reason || "服务暂不可用") : "";
    const speechBlocked = !d.narration.trim() ? "请填写要朗读的文字" : d.voiceMode === "clone" && !d.media.some((m) => m.role === "voice") ? "请上传声音样本" : !session ? "请先登录" : pending ? "请先恢复已有任务" : "";
    const result = viewed || d.video;
    const muted = { color: token.colorTextSecondary };
    const quoteKey = JSON.stringify([session, d.digitalRevision, avatar?.storageKey, d.speech?.storageKey, d.digitalMotion]);

    useEffect(() => {
        quoteRequest.current?.abort();
        setQuote(null);
        setQuoteError("");
        setQuoting(false);
        return () => quoteRequest.current?.abort();
    }, [quoteKey]);
    useEffect(() => setPreviewError(false), [result?.url]);
    useEffect(() => {
        const request = new AbortController();
        const refresh = () => {
            if (session) void getReplicateModels(request.signal).then((value) => { if (!request.signal.aborted) setModels(value); }).catch(() => { if (!request.signal.aborted) setModels([]); });
            else setModels([]);
        };
        refresh();
        window.addEventListener("focus", refresh);
        return () => { request.abort(); window.removeEventListener("focus", refresh); };
    }, [session]);

    const upload = async (file: File, role: "avatar" | "voice" | "speech") => {
        if (locked || uploadLock.current) return;
        uploadLock.current = true;
        setUploading(true);
        try {
            if (role === "speech") {
                if (!file.type.startsWith("audio/")) throw new Error("请选择音频文件");
                wb.edit({ speech: await uploadMediaFile(file, "video-speech") }, "video");
            } else {
                const added = await wb.addFiles([file], role, role === "avatar" ? accept : "audio/*");
                if (typeof added === "string") return;
            }
            setViewed(null);
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "上传失败，已保留原素材"));
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text" || payload.kind !== kind) return void message.error(`请选择人物${photo ? "照片" : "视频"}`);
        try {
            const blob = payload.kind === "image"
                ? await (await fetch(await imageToDataUrl({ dataUrl: payload.dataUrl, storageKey: payload.storageKey }))).blob()
                : await workbenchMediaBlob({ url: payload.url, storageKey: payload.storageKey || "", bytes: 0, mimeType: "video/mp4", kind: "video" });
            await upload(new File([blob], payload.title, { type: blob.type }), "avatar");
            setAssetOpen(false);
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "读取素材失败"));
        }
    };
    const material = (role: "avatar" | "voice", label: string) => (
        <div className="space-y-2">
            {d.media.filter((m) => m.role === role).map((m) => (
                <div className="space-y-2" key={m.id}>
                    {m.kind === "image" ? <img src={m.url} alt={label} className="max-h-48 w-full rounded object-contain" /> : m.kind === "video" ? <video src={m.url} controls className="max-h-48 w-full rounded" /> : <audio src={m.url} controls className="w-full" />}
                    <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">{m.name}</span>
                        <Button type="text" size="small" aria-label={`移除${label}`} disabled={locked} icon={<X size={14} />} onClick={() => { wb.removeMedia(m.id); setViewed(null); }} />
                    </div>
                </div>
            ))}
            <Upload.Dragger accept={role === "avatar" ? accept : "audio/*"} disabled={locked} showUploadList={false} beforeUpload={(file) => { void upload(file, role); return Upload.LIST_IGNORE; }}>
                <div className="flex items-center justify-center gap-2"><UploadCloud size={17} />上传{label}</div>
            </Upload.Dragger>
        </div>
    );
    const viewQuote = async () => {
        quoteRequest.current?.abort();
        const request = new AbortController();
        quoteRequest.current = request;
        setQuoting(true);
        setQuote(null);
        setQuoteError("");
        try {
            const value = await wb.quoteDigitalHuman(request.signal);
            if (!request.signal.aborted) setQuote(value);
        } catch (error) {
            if (!request.signal.aborted) setQuoteError(publicServiceText(error instanceof Error ? error.message : "报价失败"));
        } finally {
            if (!request.signal.aborted) setQuoting(false);
        }
    };
    const showResult = async (file: UploadedFile) => {
        try { setViewed(await restoreWorkbenchFile(file)); }
        catch { message.error("结果读取失败，请恢复查询或重新上传素材"); }
    };

    if (!wb.hydrated) return <div className="p-12 text-center"><Spin tip="加载视频工具" /></div>;
    return (
        <main className="flex h-full min-h-0 flex-col" style={{ color: token.colorText }}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
                <div className="flex items-center gap-3"><Link to="/video" className="inline-flex items-center gap-1 text-sm" style={muted}><ArrowLeft size={15} />视频制作</Link><h1 className="text-lg font-semibold">{title}</h1></div>
                <Link to="/digital-human" className="text-sm" style={muted}>从文案开始制作完整口播 →</Link>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:px-6">
                <div className="mx-auto grid max-w-[1400px] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <div className="space-y-3">
                        <p className="text-sm" style={muted}>{photo ? "人物照片 + 音频 → 说话视频" : "人物视频 + 新音频 → 匹配口型的视频，保留原有画面与动作"}</p>
                        <Card size="small" title={`01 · 人物${photo ? "照片" : "视频"}`}>
                            {material("avatar", photo ? "人物照片" : "人物视频")}
                            <Button type="text" size="small" disabled={locked} onClick={() => setAssetOpen(true)}>从我的素材选择</Button>
                            {photo && <Input.TextArea className="mt-2" aria-label="人物动作要求" rows={2} disabled={locked} value={d.digitalMotion} placeholder="可选：自然看向镜头、轻微表情" onChange={(e) => wb.edit({ digitalMotion: e.target.value }, "video")} />}
                        </Card>
                        <Card size="small" title="02 · 上传音频">
                            <Upload.Dragger accept="audio/*" disabled={locked} showUploadList={false} beforeUpload={(file) => { void upload(file, "speech"); return Upload.LIST_IGNORE; }}><div className="flex items-center justify-center gap-2"><UploadCloud size={17} />上传{photo ? "口播" : "新口播"}音频</div></Upload.Dragger>
                            {d.speech && <div className="mt-3 space-y-1"><audio src={d.speech.url} controls className="w-full" /><p className="text-xs" style={muted}>{d.speech.durationMs ? `${(d.speech.durationMs / 1000).toFixed(2)} 秒` : "音频已导入"}</p><Button type="text" size="small" disabled={locked} onClick={() => wb.edit({ speech: null }, "video")}>移除音频</Button></div>}
                            <Collapse className="mt-3" items={[{ key: "tts", label: "没有音频？输入文字生成配音（可选）", children: (
                                <div className="space-y-3">
                                    <Input.TextArea aria-label="配音正文" disabled={locked} rows={4} value={d.narration} placeholder="直接粘贴需要朗读的正文" onChange={(e) => wb.edit({ narration: e.target.value, script: e.target.value }, "script")} />
                                    <div className="flex flex-wrap gap-2">
                                        <Select aria-label="配音方式" disabled={locked} value={d.voiceMode} onChange={(voiceMode) => wb.edit({ voiceMode }, "speech")} options={[{ value: "api", label: "系统音色" }, { value: "clone", label: "声音样本克隆" }]} />
                                        <Select aria-label="朗读语言" disabled={locked} value={d.language === "中文" ? "Chinese" : d.language} onChange={(language) => wb.edit({ language }, "speech")} options={["Chinese", "English", "Japanese", "Korean", "French", "German", "auto"].map((value) => ({ value, label: value === "Chinese" ? "中文" : value === "auto" ? "自动识别" : value }))} />
                                        {d.voiceMode === "api" && <Select aria-label="系统音色" disabled={locked} value={d.replicateSpeaker} onChange={(replicateSpeaker) => wb.edit({ replicateSpeaker }, "speech")} options={digitalSystemSpeakers.map((value) => ({ value, label: value }))} />}
                                    </div>
                                    {d.voiceMode === "clone" && <>{material("voice", "声音样本")}<Input.TextArea aria-label="声音样本原文" disabled={locked} rows={2} value={d.promptTranscript} placeholder="声音样本实际说出的文字（可选）" onChange={(e) => wb.edit({ promptTranscript: e.target.value }, "speech")} /></>}
                                    <Button disabled={locked || Boolean(speechBlocked)} onClick={() => void wb.run("speech")}>生成配音</Button>
                                    <p className="text-xs" style={muted}>{speechBlocked || "配音单独计费，提交前确认费用。"}</p>
                                </div>
                            ) }]} />
                        </Card>
                        <Card size="small" title="03 · 生成与费用">
                            <Space wrap><Button disabled={locked || Boolean(blocked)} loading={quoting} onClick={() => void viewQuote()}>查看本次费用</Button><Button type="primary" disabled={locked || Boolean(blocked)} loading={busy} onClick={() => { setViewed(null); void wb.run("video"); }}>生成{title}视频</Button>{busy && <Button onClick={wb.stop}>停止等待</Button>}</Space>
                            <p className="mt-2 text-xs" style={muted}>{blocked || "按音频时长核算费用，正式提交前再次报价确认。"}</p>
                            {quote && <div className="mt-2 text-sm"><strong style={{ color: token.colorPrimary }}>{quote.credits.toLocaleString()} 算力点</strong><p className="text-xs">{publicServiceText(quote.calculation || quote.billingDescription || "")}</p>{quote.submissionBlocked && <p className="text-xs" style={{ color: token.colorWarning }}>{publicServiceText(quote.submissionBlocked)}</p>}</div>}
                            {quoteError && <p className="mt-2 text-xs" style={{ color: token.colorError }}>{quoteError}</p>}
                            {active?.step && busy && <p className="mt-2 text-xs">{publicServiceText(active.step)}</p>}
                        </Card>
                    </div>
                    <div className="space-y-3 lg:sticky lg:top-0">
                        {wb.storageError && <Alert type="error" showIcon title="本地保存异常" description={wb.storageError} />}
                        {!busy && active?.error && <Alert type={active.status === "interrupted" ? "warning" : "error"} showIcon title={publicServiceText(active.error)} />}
                        <Card size="small" title={viewed ? "历史结果" : "生成结果"}>
                            {result ? <div className="space-y-3">
                                {result.mimeType.startsWith("audio/") ? <audio src={result.url} controls className="w-full" /> : <video src={result.url} controls playsInline className="max-h-[55dvh] w-full rounded" onError={() => setPreviewError(true)} />}
                                {previewError && <Alert type="warning" title="当前浏览器无法播放，可下载结果使用本地播放器查看" />}
                                <Space wrap><Button icon={<Download size={14} />} onClick={() => void wb.download(result)}>下载</Button>{!result.mimeType.startsWith("audio/") && <><Button icon={<FolderPlus size={14} />} onClick={() => void wb.saveAsset(result)}>保存素材</Button><Button icon={<Grid2X2 size={14} />} onClick={() => void wb.toCanvas(result)}>加入画布</Button></>}{viewed && <Button onClick={() => setViewed(null)}>查看当前结果</Button>}</Space>
                            </div> : <Empty description="准备人物素材与音频后生成视频" />}
                        </Card>
                        <Card size="small" title="本浏览器任务记录">
                            {!wb.records.length && <Empty description="还没有任务" />}
                            <div className="max-h-80 space-y-3 overflow-y-auto">
                                {wb.records.map((r) => <div className="space-y-1 border-b pb-3" style={{ borderColor: token.colorBorderSecondary }} key={r.id}>
                                    <div className="text-sm">{stageLabels[r.stage] || r.stage} · {{ running: "处理中", completed: "已完成", failed: "失败", interrupted: "等待恢复" }[r.status]}</div>
                                    {r.error && <p className="text-xs" style={muted}>{publicServiceText(r.error)}</p>}
                                    <Space wrap>{r.result && <Button size="small" onClick={() => void showResult(r.result!)}>查看结果</Button>}{["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask) && <Button size="small" disabled={locked} onClick={() => { setViewed(null); void wb.resume(r); }}>恢复查询</Button>}</Space>
                                </div>)}
                            </div>
                            <p className="mt-3 text-xs" style={muted}>草稿和记录独立保存在当前浏览器，恢复查询继续原任务。</p>
                        </Card>
                    </div>
                </div>
            </div>
            <AssetPickerModal open={assetOpen} onClose={() => setAssetOpen(false)} onInsert={(payload) => void insertAsset(payload)} />
        </main>
    );
}
