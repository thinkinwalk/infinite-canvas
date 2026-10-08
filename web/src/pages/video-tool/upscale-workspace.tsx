import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Collapse, Empty, Input, InputNumber, Segmented, Select, Space, Spin, Tabs, Tag, Upload, theme } from "antd";
import { ArrowLeft, Download, FolderPlus, Grid2X2, RefreshCw, Sparkles, Video, X } from "lucide-react";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { getReplicateModels, publicServiceText, reconcileReplicateTask, type ReplicateQuote } from "@/services/api/replicate";
import { getWorkerCapabilities, workbenchMediaBlob } from "@/services/api/video-worker";
import type { UploadedFile } from "@/services/file-storage";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { UpscaleInput, VideoRecord, WorkerCapabilities } from "@/types/video-workbench";
import { restoreWorkbenchFile, useVideoWorkbench } from "./use-video-workbench";
import { upscaleError, upscaleInput, upscaleInputKey, upscaleSummary } from "./upscale-settings";

const statuses = { running: "处理中", completed: "已完成", interrupted: "等待暂停", failed: "失败" };

export default function UpscaleWorkspace() {
    const wb = useVideoWorkbench("upscale");
    const { draft: d, busy } = wb;
    const { token } = theme.useToken();
    const { message, modal } = App.useApp();
    const platformToken = useUserStore((s) => s.token);
    const administrator = useUserStore((s) => s.user?.role === "admin");
    const [tab, setTab] = useState("current");
    const [view, setView] = useState("source");
    const [assetOpen, setAssetOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const uploadLock = useRef(false);
    const [uploadError, setUploadError] = useState("");
    const [model, setModel] = useState<ReplicateQuote | null>(null);
    const [modelError, setModelError] = useState("");
    const [modelLoading, setModelLoading] = useState(false);
    const [revision, setRevision] = useState(0);
    const [capabilities, setCapabilities] = useState<WorkerCapabilities[]>([]);
    const [checking, setChecking] = useState(false);
    const [serviceError, setServiceError] = useState("");
    const [serviceRevision, setServiceRevision] = useState(0);
    const [quote, setQuote] = useState<{ key: string; value: ReplicateQuote } | null>(null);
    const [quoting, setQuoting] = useState(false);
    const [quoteError, setQuoteError] = useState("");
    const quoteController = useRef<AbortController | null>(null);
    const [previewError, setPreviewError] = useState(false);
    const [restoring, setRestoring] = useState(false);
    const [historyPreview, setHistoryPreview] = useState<{ record: VideoRecord; result: UploadedFile; source?: UploadedFile } | null>(null);
    const cloud = d.route === "replicate";
    const input = upscaleInput(d);
    const inputKey = upscaleInputKey(input);
    const keyRef = useRef(inputKey);
    keyRef.current = inputKey;
    const reference = input.media[0];
    const result = historyPreview?.result || d.final;
    const outputInput = historyPreview ? historyPreview.record.upscaleInput : d.upscaleOutputInput;
    const source = historyPreview ? historyPreview.source : result && outputInput ? outputInput.media[0] : reference;
    const preview = view === "result" && result ? result : source;
    const currentQuote = quote?.key === inputKey ? quote.value : null;
    const stale = !historyPreview && result && (outputInput ? upscaleInputKey(outputInput) !== inputKey : d.upscaleOutputStale);
    const active = wb.records.find((r) => r.id === d.activeRecord);
    const pending = wb.records.find((r) => ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob));
    const locked = busy || uploading || restoring;
    const muted = { color: token.colorTextSecondary };
    const surface = { background: token.colorBgContainer, borderColor: token.colorBorderSecondary };

    useEffect(() => {
        const controller = new AbortController();
        setModel(null);
        setModelError("");
        setModelLoading(Boolean(platformToken && cloud));
        if (platformToken && cloud)
            void getReplicateModels(controller.signal)
                .then((models) => {
                    if (!controller.signal.aborted) setModel(models.find((m) => m.operation === "upscale") || null);
                })
                .catch((error) => {
                    if (!controller.signal.aborted) setModelError(publicServiceText(error instanceof Error ? error.message : "读取高清服务失败"));
                })
                .finally(() => {
                    if (!controller.signal.aborted) setModelLoading(false);
                });
        return () => controller.abort();
    }, [platformToken, cloud, revision]);

    useEffect(() => {
        const refresh = () => {
            setQuote(null);
            setRevision((v) => v + 1);
            setServiceRevision((v) => v + 1);
        };
        const visible = () => {
            if (document.visibilityState === "visible") refresh();
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", visible);
        return () => {
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", visible);
        };
    }, []);

    useEffect(() => {
        let disposed = false;
        setCapabilities([]);
        setServiceError("");
        setChecking(false);
        if (wb.hydrated && (!cloud || previewError)) {
            setChecking(true);
            void getWorkerCapabilities(wb.worker)
                .then((value) => {
                    if (!disposed) setCapabilities(value);
                })
                .catch((error) => {
                    if (!disposed) setServiceError(publicServiceText(error instanceof Error ? error.message : "处理服务未连接"));
                })
                .finally(() => {
                    if (!disposed) setChecking(false);
                });
        }
        return () => {
            disposed = true;
        };
    }, [wb.hydrated, cloud, previewError, wb.worker.url, wb.worker.token, platformToken, serviceRevision]);

    useEffect(() => {
        quoteController.current?.abort();
        quoteController.current = null;
        setQuote(null);
        setQuoteError("");
        setQuoting(false);
        return () => quoteController.current?.abort();
    }, [inputKey, platformToken, revision]);
    useEffect(() => {
        setPreviewError(false);
    }, [preview?.storageKey, preview?.url]);
    useEffect(() => {
        if (d.final) {
            setHistoryPreview(null);
            setView("result");
        }
    }, [d.final?.storageKey]);

    const capability = capabilities.find((c) => c.name === "upscale");
    const unavailable = cloud
        ? !platformToken
            ? "登录后使用平台高清"
            : modelLoading
              ? "正在读取高清服务状态"
              : !model?.available
                ? publicServiceText(model?.reason || modelError || "平台高清暂不可用")
                : ""
        : checking
          ? "正在检查增强服务"
          : !capability?.available
            ? serviceError || capability?.reason || "当前服务未配置视频增强能力"
            : "";
    const blocked = !wb.hydrated ? "正在恢复本浏览器草稿" : uploading ? "正在保存视频，请稍候" : publicServiceText(unavailable || upscaleError(input) || (pending ? "已有已提交任务，请先恢复查询结果" : ""));

    const prepareQuote = async () => {
        if (blocked || locked || quoteController.current) return;
        const controller = new AbortController(),
            key = inputKey;
        quoteController.current = controller;
        setQuoting(true);
        setQuoteError("");
        setQuote(null);
        try {
            const value = await wb.quoteUpscale(controller.signal);
            if (!controller.signal.aborted && keyRef.current === key) setQuote({ key, value });
        } catch (error) {
            if (!controller.signal.aborted && keyRef.current === key) setQuoteError(publicServiceText(error instanceof Error ? error.message : "读取费用失败"));
        } finally {
            if (quoteController.current === controller) {
                quoteController.current = null;
                setQuoting(false);
            }
        }
    };
    const addFile = async (file: File) => {
        if (busy || restoring || uploadLock.current) return;
        uploadLock.current = true;
        setUploading(true);
        setUploadError("");
        try {
            const added = await wb.addFiles([file], "reference", "video/*");
            if (typeof added === "string") setUploadError(added);
            else {
                setHistoryPreview(null);
                setTab("current");
                setView(d.final ? "result" : "source");
            }
            return Array.isArray(added);
        } finally {
            uploadLock.current = false;
            setUploading(false);
        }
    };
    const insertAsset = async (payload: InsertAssetPayload) => {
        try {
            if (payload.kind !== "video") throw new Error("请选择视频素材");
            const blob = await workbenchMediaBlob({ url: payload.url, storageKey: payload.storageKey || "", mimeType: "video/mp4", bytes: 0 });
            if (await addFile(new File([blob], payload.title, { type: blob.type }))) setAssetOpen(false);
        } catch (error) {
            setUploadError(publicServiceText(error instanceof Error ? error.message : "读取素材失败"));
        }
    };
    const restoreInput = async (snapshot: UpscaleInput) => {
        if (locked || quoting) return;
        setRestoring(true);
        try {
            const media = await Promise.all(snapshot.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
            wb.edit({ ...snapshot, media }, "materials");
            setHistoryPreview(null);
            setTab("current");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "恢复输入失败"));
        } finally {
            setRestoring(false);
        }
    };
    const showRecord = async (record: VideoRecord) => {
        if (!record.result || locked) return;
        setRestoring(true);
        try {
            const result = await restoreWorkbenchFile(record.result);
            const source = record.upscaleInput?.media[0];
            setHistoryPreview({ record, result, source: source ? await restoreWorkbenchFile(source) : undefined });
            setView("result");
            setTab("current");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "读取历史作品失败"));
        } finally {
            setRestoring(false);
        }
    };
    const reconcile = (record: VideoRecord) => {
        let predictionId = "";
        modal.confirm({
            title: "核对并关联已有平台任务",
            content: (
                <div className="space-y-3">
                    <p>如果任务状态暂未返回，请填写原任务编号，此操作不会创建新任务。</p>
                    <Input
                        placeholder="原任务编号"
                        onChange={(e) => {
                            predictionId = e.target.value.trim();
                        }}
                    />
                </div>
            ),
            okText: "核对关联",
            cancelText: "取消",
            onOk: async () => {
                try {
                    await reconcileReplicateTask(record.replicateTask!.id, predictionId);
                    message.success("已关联，可恢复查询取得结果");
                } catch (error) {
                    message.error(publicServiceText(error instanceof Error ? error.message : "关联失败"));
                    throw error;
                }
            },
        });
    };
    const submit = (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={muted}>
                <span>{cloud ? (currentQuote ? `预计 ${currentQuote.credits.toLocaleString()} 算力点` : "费用待后台报价") : "费用以当前处理服务为准"}</span>
                {cloud && platformToken && (
                    <Button type="link" size="small" aria-label="查看费用" loading={quoting} disabled={Boolean(blocked) || locked} onClick={() => void prepareQuote()}>
                        查看费用
                    </Button>
                )}
            </div>
            {cloud && !platformToken ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">登录后使用平台高清</span>
                    <UserStatusActions accountOnly />
                </div>
            ) : (
                <Button
                    type="primary"
                    block
                    size="large"
                    aria-label={cloud ? "查看费用并开始" : "开始增强"}
                    icon={<Sparkles size={16} />}
                    loading={busy}
                    disabled={Boolean(blocked || currentQuote?.submissionBlocked || (currentQuote && !currentQuote.available)) || locked || quoting}
                    onClick={() => {
                        setHistoryPreview(null);
                        setTab("current");
                        void wb.run("upscale");
                    }}
                >
                    {cloud ? "查看费用并开始" : "开始增强"}
                </Button>
            )}
            <div className="text-xs" aria-live="polite" style={muted}>
                {busy
                    ? "停止等待不会取消已提交的任务，可恢复查询。"
                    : publicServiceText(blocked || currentQuote?.submissionBlocked || (currentQuote && !currentQuote.available ? currentQuote.reason : "") || (cloud ? "确认费用后创建任务，取消不扣点。" : "按当前增强服务能力处理视频。"))}
            </div>
            {quoteError && (
                <div role="alert" className="text-xs" style={{ color: token.colorError }}>
                    {quoteError}
                </div>
            )}
        </div>
    );

    return (
        <main className="flex h-full min-h-0 flex-col" style={{ color: token.colorText }}>
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
                <div className="flex items-center gap-3">
                    <Link to="/video" className="inline-flex items-center gap-1 text-sm" style={muted}>
                        <ArrowLeft size={15} />
                        视频制作
                    </Link>
                    <h1 className="text-lg font-semibold">视频高清</h1>
                </div>
                <span className="hidden text-sm sm:block" style={muted}>
                    提升视频清晰度与画面质量
                </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-6 lg:overflow-hidden" data-testid="upscale-scroll">
                <div className="mx-auto grid min-h-full max-w-[1800px] gap-5 lg:h-full lg:min-h-0 lg:grid-cols-[360px_minmax(0,1fr)]">
                    <section className="flex min-h-0 flex-col rounded-xl border" style={surface} aria-label="高清输入与设置">
                        <div className="flex min-h-0 flex-1 flex-col gap-5 p-4 lg:overflow-y-auto" data-testid="upscale-input-scroll">
                            <section>
                                <div className="mb-2 flex items-center justify-between gap-2">
                                    <span className="font-medium">原视频</span>
                                    <span className="text-xs" style={muted}>
                                        {reference ? "1" : "0"} / 1
                                    </span>
                                </div>
                                {reference && (
                                    <div className="mb-3 space-y-2">
                                        <video src={reference.url} controls preload="metadata" className="max-h-44 w-full rounded-lg" />
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="min-w-0 flex-1 truncate text-xs" title={reference.name}>
                                                {reference.name}
                                            </span>
                                            <Button type="text" size="small" disabled={locked} icon={<X size={14} />} aria-label="移除原视频" onClick={() => wb.removeMedia(reference.id)} />
                                        </div>
                                        <div className="text-xs" style={muted}>
                                            {formatBytes(reference.bytes)} · {reference.width && reference.height ? `${reference.width}×${reference.height}` : "尺寸未识别"} · {reference.durationMs ? formatDuration(reference.durationMs) : "时长未识别"}
                                        </div>
                                    </div>
                                )}
                                <Upload.Dragger
                                    height={132}
                                    accept="video/*"
                                    multiple={false}
                                    showUploadList={false}
                                    disabled={locked}
                                    beforeUpload={(file, files) => {
                                        if (files.length > 1) setUploadError("请每次选择一个原视频");
                                        else void addFile(file);
                                        return Upload.LIST_IGNORE;
                                    }}
                                    style={{ background: token.colorFillQuaternary }}
                                >
                                    <div className="flex items-center justify-center gap-2 text-sm" style={muted}>
                                        {uploading ? <Spin size="small" /> : <Video size={20} />}
                                        <span>{reference ? "点击或拖拽替换视频" : "点击或拖拽上传视频"}</span>
                                    </div>
                                    <div className="mt-2 px-3 text-xs" style={muted}>
                                        选择需要增强的原视频，上传后可预览
                                    </div>
                                </Upload.Dragger>
                                <Button type="text" size="small" className="mt-1" disabled={locked} onClick={() => setAssetOpen(true)}>
                                    从我的素材选择
                                </Button>
                                {uploadError && (
                                    <div role="alert" className="mt-1 text-xs" style={{ color: token.colorError }}>
                                        {uploadError}
                                    </div>
                                )}
                            </section>
                            <section className="space-y-3">
                                {cloud ? (
                                    <>
                                        <div className="font-medium">输出分辨率</div>
                                        <Segmented
                                            block
                                            aria-label="高清目标分辨率"
                                            disabled={locked}
                                            value={d.replicateTargetResolution}
                                            options={[
                                                { value: "720p", label: "720p" },
                                                { value: "1080p", label: "1080p" },
                                                { value: "4k", label: "4K" },
                                            ]}
                                            onChange={(v) => wb.edit({ replicateTargetResolution: v as typeof d.replicateTargetResolution }, "finish")}
                                        />
                                        <div className="font-medium">目标帧率</div>
                                        <Segmented
                                            block
                                            aria-label="高清目标帧率选项"
                                            disabled={locked}
                                            value={[30, 60].includes(d.replicateFps) ? d.replicateFps : "custom"}
                                            options={[
                                                { value: 30, label: "30 fps" },
                                                { value: 60, label: "60 fps" },
                                                { value: "custom", label: "自定义" },
                                            ]}
                                            onChange={(v) => wb.edit({ replicateFps: v === "custom" ? 24 : Number(v) }, "finish")}
                                        />
                                        {![30, 60].includes(d.replicateFps) && (
                                            <InputNumber
                                                className="w-full"
                                                aria-label="高清自定义帧率"
                                                min={15}
                                                max={60}
                                                precision={0}
                                                value={d.replicateFps}
                                                disabled={locked}
                                                onChange={(v) => {
                                                    if (v !== null) wb.edit({ replicateFps: v }, "finish");
                                                }}
                                            />
                                        )}
                                        <div className="text-xs" style={muted}>
                                            支持 15–60 fps；不高于 30 fps 按 30 fps 档计费，高于 30 fps 按 60 fps 档计费。
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="font-medium">放大倍数</div>
                                        <Segmented
                                            block
                                            disabled={locked}
                                            value={d.scale}
                                            options={[
                                                { value: 2, label: "2 倍" },
                                                { value: 4, label: "4 倍" },
                                            ]}
                                            onChange={(v) => wb.edit({ scale: Number(v) }, "finish")}
                                        />
                                        <div className="font-medium">目标帧率（可选）</div>
                                        <InputNumber className="w-full" aria-label="增强目标帧率" min={1} precision={0} disabled={locked} value={d.fps} placeholder="留空保持原帧率" onChange={(fps) => wb.edit({ fps }, "finish")} />
                                    </>
                                )}
                            </section>
                            <div className="space-y-2 rounded-lg p-3" style={{ background: token.colorFillQuaternary }}>
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm">{cloud ? "平台视频增强" : "增强处理服务"}</span>
                                    <Button
                                        type="text"
                                        size="small"
                                        icon={<RefreshCw size={14} />}
                                        aria-label="刷新高清服务状态"
                                        loading={cloud ? modelLoading : checking}
                                        disabled={locked || quoting}
                                        onClick={() => {
                                            setQuote(null);
                                            setRevision((v) => v + 1);
                                            setServiceRevision((v) => v + 1);
                                        }}
                                    />
                                </div>
                                <div className="text-xs" style={muted}>
                                    {upscaleSummary(input)}
                                </div>
                                {unavailable && (
                                    <div className="text-xs" style={muted}>
                                        {unavailable}
                                    </div>
                                )}
                            </div>
                            <Collapse
                                size="small"
                                items={[
                                    {
                                        key: "advanced",
                                        label: "高级设置",
                                        children: (
                                            <div className="space-y-3">
                                                <Select
                                                    className="w-full"
                                                    aria-label="高清处理渠道"
                                                    disabled={locked}
                                                    value={cloud ? "replicate" : "worker"}
                                                    options={[
                                                        { value: "replicate", label: "平台视频增强（推荐）" },
                                                        { value: "worker", label: "增强处理服务" },
                                                    ]}
                                                    onChange={(route) => wb.edit({ route }, "finish")}
                                                />
                                                {!cloud && (
                                                    <>
                                                        <Input aria-label="处理服务地址" disabled={locked} value={wb.worker.url} onChange={(e) => useVideoWorkbenchStore.getState().setWorker({ url: e.target.value })} />
                                                        <Input.Password
                                                            aria-label="处理服务令牌"
                                                            disabled={locked}
                                                            value={wb.worker.token}
                                                            placeholder="站内服务无需填写令牌"
                                                            onChange={(e) => useVideoWorkbenchStore.getState().setWorker({ token: e.target.value })}
                                                        />
                                                        <Button aria-label="检查连接" disabled={locked} loading={checking} onClick={() => setServiceRevision((v) => v + 1)}>
                                                            检查连接
                                                        </Button>
                                                        {serviceError && <Alert type="warning" title={serviceError} />}
                                                    </>
                                                )}
                                                <div className="text-xs" style={muted}>
                                                    {cloud ? "平台高清使用后台配置，无需个人模型 Key；按服务器读取的时长报价。" : "只检查当前服务的增强能力；站内服务由登录账号鉴权，直连服务使用此处令牌。"}
                                                </div>
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                            {currentQuote && (
                                <Alert
                                    type={currentQuote.usedDefaultDuration || !currentQuote.available || currentQuote.submissionBlocked ? "warning" : "info"}
                                    showIcon
                                    title={`本次预计 ${currentQuote.credits.toLocaleString()} 算力点`}
                                    description={
                                        <div className="space-y-1 text-xs">
                                            <div>{publicServiceText(currentQuote.calculation || currentQuote.billingDescription || "")}</div>
                                            {currentQuote.durationSeconds !== undefined && <div>服务器计费时长：{currentQuote.durationSeconds.toFixed(2)} 秒</div>}
                                            {currentQuote.usedDefaultDuration && <div>未能读取素材时长，当前使用后台备用时长。</div>}
                                            <div>{publicServiceText(currentQuote.submissionBlocked || currentQuote.reason || "")}</div>
                                        </div>
                                    }
                                />
                            )}
                        </div>
                        <footer className="shrink-0 border-t p-4" style={{ borderColor: token.colorBorderSecondary }}>
                            {submit}
                        </footer>
                    </section>
                    <section className="min-h-0 min-w-0 rounded-xl border p-4 lg:overflow-y-auto" style={surface} aria-label="高清作品区域" data-testid="upscale-result-scroll">
                        {wb.storageError && <Alert className="mb-3" type="error" showIcon title="本地保存异常" description={wb.storageError} />}
                        {busy && (
                            <Alert
                                className="mb-3"
                                type="info"
                                showIcon
                                icon={<Spin size="small" />}
                                title={active?.step || "正在准备高清任务"}
                                description={
                                    <Space wrap>
                                        <Button size="small" onClick={wb.stop}>
                                            停止等待
                                        </Button>
                                        {(active?.replicateTask || active?.workerJob) && (
                                            <Button size="small" danger onClick={() => void wb.cancel()}>
                                                取消处理任务
                                            </Button>
                                        )}
                                    </Space>
                                }
                            />
                        )}
                        {!busy && pending && (
                            <Alert
                                className="mb-3"
                                type="info"
                                showIcon
                                title="已有任务可恢复查询"
                                description={
                                    <Button
                                        size="small"
                                        disabled={locked || quoting}
                                        onClick={() => {
                                            setHistoryPreview(null);
                                            setTab("current");
                                            void wb.resume(pending);
                                        }}
                                    >
                                        恢复任务结果
                                    </Button>
                                }
                            />
                        )}
                        <Tabs
                            activeKey={tab}
                            onChange={setTab}
                            items={[
                                { key: "current", label: "当前作品" },
                                { key: "history", label: "本浏览器作品" },
                                { key: "guide", label: "使用说明" },
                            ]}
                        />
                        {tab === "current" && (
                            <div className="space-y-4">
                                {historyPreview && (
                                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                        <span>查看历史 · {new Date(historyPreview.record.createdAt).toLocaleString()}</span>
                                        <Button size="small" onClick={() => setHistoryPreview(null)}>
                                            返回当前作品
                                        </Button>
                                    </div>
                                )}
                                {stale && <Alert type="info" showIcon title="成片对应上次设置，仍可下载" description={outputInput ? `成片规格：${upscaleSummary(outputInput)}；原片预览显示该成片的原始输入。` : "当前设置变化不会删除上一成片。"} />}
                                {source || result ? (
                                    <>
                                        <Segmented
                                            aria-label="原片与成片"
                                            value={view}
                                            onChange={(v) => setView(String(v))}
                                            options={[
                                                { value: "source", label: "原片", disabled: !source },
                                                { value: "result", label: "成片", disabled: !result },
                                            ]}
                                        />
                                        <div className="flex min-h-[260px] items-center justify-center rounded-lg" style={{ background: token.colorFillQuaternary }}>
                                            {preview ? (
                                                <video key={preview.storageKey || preview.url} src={preview.url} controls preload="metadata" className="max-h-[65vh] w-full rounded-lg object-contain" onError={() => setPreviewError(true)} />
                                            ) : (
                                                <Empty description="原片尚未恢复" />
                                            )}
                                        </div>
                                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={muted}>
                                            <span>{source && "name" in source ? String(source.name) : "视频预览"}</span>
                                            <span>
                                                {preview?.width && preview.height ? `${preview.width}×${preview.height}` : "尺寸未识别"}
                                                {preview?.durationMs ? ` · ${formatDuration(preview.durationMs)}` : ""}
                                            </span>
                                        </div>
                                        {view === "result" && outputInput && <div className="text-xs" style={muted}>任务设置：{upscaleSummary(outputInput)}</div>}
                                    </>
                                ) : (
                                    <div className="flex min-h-[360px] items-center justify-center">
                                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="上传原视频，处理后可查看原片与成片" />
                                    </div>
                                )}
                                {previewError && (
                                    <Alert
                                        type="warning"
                                        showIcon
                                        title="当前浏览器无法播放此编码"
                                        description={
                                            <div className="space-y-2">
                                                <div>{historyPreview ? "历史作品可下载原文件；转码功能用于当前成片。" : "可通过具备转码能力的处理服务将当前成片转为 H.264 后预览。"}</div>
                                                {preview && <Button size="small" onClick={() => void wb.download(preview)}>下载当前预览文件</Button>}
                                                {view === "result" && !historyPreview && (capabilities.find((c) => c.name === "compose")?.available ? (
                                                    <Button disabled={locked || Boolean(pending)} onClick={() => void wb.run("compatibility")}>
                                                        转为可播放版本
                                                    </Button>
                                                ) : (
                                                    <div className="text-xs">
                                                        {checking ? "正在检查转码能力" : serviceError || "当前未连接可用转码服务"}
                                                        <Button type="link" size="small" disabled={locked} onClick={() => setServiceRevision((v) => v + 1)}>
                                                            重新检查
                                                        </Button>
                                                    </div>
                                                ))}
                                            </div>
                                        }
                                    />
                                )}
                                {result && (
                                    <Space wrap>
                                        <Button icon={<Download size={15} />} onClick={() => void wb.download(result)}>
                                            下载视频
                                        </Button>
                                        <Button disabled={locked} icon={<FolderPlus size={15} />} onClick={() => void wb.saveAsset(result)}>
                                            保存素材
                                        </Button>
                                        <Button disabled={locked} icon={<Grid2X2 size={15} />} onClick={() => void wb.toCanvas(result)}>
                                            加入新画布
                                        </Button>
                                    </Space>
                                )}
                            </div>
                        )}
                        {tab === "history" && (
                            <div className="space-y-3">
                                <p className="text-xs" style={muted}>
                                    任务与作品保存在当前浏览器，恢复查询不会创建新任务。
                                </p>
                                {wb.records.length ? (
                                    wb.records.map((r) => (
                                        <article key={r.id} className="space-y-2 rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary }}>
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                <span className="text-sm">
                                                    {r.upscaleInput?.media[0]?.name || "高清任务"}
                                                    {r.stage === "compatibility" ? " · 转码" : ""}
                                                </span>
                                                <Tag color={r.status === "completed" ? "success" : r.status === "failed" ? "error" : "processing"}>{statuses[r.status]}</Tag>
                                            </div>
                                            <div className="text-xs" style={muted}>
                                                {new Date(r.createdAt).toLocaleString()} · {r.upscaleInput ? upscaleSummary(r.upscaleInput) : "该记录未保存输入规格"}
                                            </div>
                                            {r.replicateTask && (
                                                <div className="break-all text-xs" style={muted}>
                                                    平台任务编号：{r.replicateTask.id}
                                                </div>
                                            )}
                                            {r.error && <Alert type="warning" title={r.error} />}
                                            <Space wrap>
                                                {r.result && (
                                                    <Button size="small" disabled={locked} onClick={() => void showRecord(r)}>
                                                        查看作品
                                                    </Button>
                                                )}
                                                {r.upscaleInput && (
                                                    <Button size="small" disabled={locked || quoting} onClick={() => void restoreInput(r.upscaleInput!)}>
                                                        恢复输入
                                                    </Button>
                                                )}
                                                {(r.replicateTask || r.workerJob) && r.status !== "completed" && (
                                                    <Button
                                                        size="small"
                                                        disabled={locked || quoting}
                                                        onClick={() => {
                                                            setHistoryPreview(null);
                                                            setTab("current");
                                                            void wb.resume(r);
                                                        }}
                                                    >
                                                        恢复查询
                                                    </Button>
                                                )}
                                                {r.status === "failed" && r.upscaleInput && (
                                                    <Button size="small" disabled={locked || quoting} onClick={() => void restoreInput(r.upscaleInput!)}>
                                                        恢复输入并准备重试
                                                    </Button>
                                                )}
                                                {administrator && r.replicateTask && r.status === "interrupted" && (
                                                    <Button size="small" disabled={locked} onClick={() => reconcile(r)}>
                                                        核对平台任务
                                                    </Button>
                                                )}
                                            </Space>
                                        </article>
                                    ))
                                ) : (
                                    <Empty description="暂无高清任务" />
                                )}
                            </div>
                        )}
                        {tab === "guide" && (
                            <div className="space-y-4 text-sm">
                                <p>1. 上传一段原视频，或从我的素材中选择。</p>
                                <p>2. 平台高清选择 720p、1080p 或 4K，以及 15–60 fps；增强处理服务可选择放大倍数与可选帧率。</p>
                                <p>3. 查看后台费用与时长，确认后创建处理任务。</p>
                                <p>4. 切换原片与成片预览，下载、保存素材或加入画布。</p>
                                <p style={muted}>原片与成片为独立播放。清晰度、运动细节和音轨以实际结果为准；尚无验收通过的官方增强示例。</p>
                                <p style={muted}>停止等待只暂停本地查询；取消请求需核对最终任务状态。素材与作品主要保存在本浏览器。</p>
                            </div>
                        )}
                    </section>
                </div>
            </div>
            <AssetPickerModal open={assetOpen} onClose={() => setAssetOpen(false)} onInsert={insertAsset} />
        </main>
    );
}

