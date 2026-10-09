import { App } from "antd";
import { useReplicateConfirmation } from "@/hooks/use-replicate-confirmation";
import { nanoid } from "nanoid";
import { useEffect, useRef } from "react";
import { saveAs } from "file-saver";
import { useNavigate } from "react-router-dom";

import { createCanvasNode, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestEdit, requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { createVideoGenerationTask, isVideoTaskFailed, quoteTextModel, quoteVideoModel, storeGeneratedVideo, waitForVideoGenerationTask, type VideoPrice } from "@/services/api/video";
import { isReplicateVideoModel, publicServiceText, readReplicateTranscription, REPLICATE_VIDEO_MODEL, transcriptionUnavailable } from "@/services/api/replicate";
import { remapMaterialMentions } from "@/lib/video-capabilities";
import { storeMaterialLabels, storeVideoConfig, storeVideoError, storeVideoMaterials, storeVideoPrompt, storeVideoSettings } from "./store-explore-request";
import { viralInput, viralMaterialLabels, viralSource, viralVideoConfig, viralVideoError, viralVideoMaterials, viralVideoPrompt } from "./viral-recreate-request";
import { upscaleError, upscaleInput } from "./upscale-settings";
import { digitalHumanBriefText, digitalHumanRequest, digitalHumanScriptError, digitalHumanScriptPrompt, digitalHumanSubtitleError, digitalLearningSource } from "./digital-human-request";
import { cancelWorkerJob, createWorkerJob, getWorkerCapabilities, resolveWorkerUrl, storeWorkerImage, storeWorkerResult, uploadWorkerMedia, waitForWorkerJob, workbenchMediaBlob } from "@/services/api/video-worker";
import { resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { resolveModelRequestConfig, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { cancelReplicateTask, createReplicateTask, getReplicateModels, quoteReplicate, readReplicateTask, storeReplicateResult, uploadReplicateReference, waitForReplicateTask, type ReplicateOperation, type ReplicateTask } from "@/services/api/replicate";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import { emptyVideoDraft, isTalkingVideoTool, type MediaRole, type VideoDraft, type VideoRecord, type VideoTool, type WorkbenchMedia, type WorkerConfig, type WorkerJob } from "@/types/video-workbench";

export const stageLabels: Record<string, string> = {
    frames: "抽取参考关键帧",
    transcribe: "参考语音转写",
    analyze: "素材与视频分析",
    script: "撰写脚本",
    speech: "生成口播",
    "speech-preview": "音色试听",
    video: "生成视频",
    cut: "剪气口",
    metadata: "标题与标签",
    subtitles: "识别字幕",
    compose: "字幕与配乐",
    cover: "生成封面",
    compatibility: "转换播放格式",
    "product-analyze": "新商品分析",
    upscale: "视频增强",
    "subtitle-remove": "去除硬字幕",
};
const controllers = new Map<VideoTool, AbortController>();
const store = () => useVideoWorkbenchStore.getState();
const read = (tool: VideoTool) => isTalkingVideoTool(tool) ? { ...emptyVideoDraft(tool), ...store().drafts[tool] } : store().drafts[tool] || emptyVideoDraft(tool);
const imagesOf = (media: WorkbenchMedia[]): ReferenceImage[] => media.filter((m) => m.kind === "image").map((m) => ({ id: m.id, name: m.name, type: m.mimeType, dataUrl: m.url, storageKey: m.storageKey }));
const mediaOf = (media: WorkbenchMedia[], kind: "video" | "audio") =>
    media.filter((m) => m.kind === kind).map((m) => ({ id: m.id, name: m.name, type: m.mimeType, url: m.url, storageKey: m.storageKey, width: m.width, height: m.height, durationMs: m.durationMs }));
function replacementRequest(d: VideoDraft): { operation: ReplicateOperation; fields: Record<string, unknown>; materials: Record<string, UploadedFile | UploadedFile[]> } {
    const video = d.media.find((m) => m.role === "reference" && m.kind === "video");
    const image = d.media.find((m) => m.role === (d.replacement === "background" ? "background" : "model") && m.kind === "image");
    if (!video) throw new Error("请先上传原视频");
    if (!image) throw new Error("请先上传替换参考图片");
    if (d.replacement === "person") return { operation: "replace-person", fields: { resolution: d.replicateResolution.replace("p", ""), merge_audio: true }, materials: { video, character_image: image } };
    if (!d.instructions.trim()) throw new Error("请填写具体替换要求");
    const prompt = `${d.instructions} Replace only the ${d.replacement} using the reference image. Preserve the remaining people, actions and camera movement.`;
    if (d.maskedEdit) {
        const mask = d.media.find((m) => m.role === "mask");
        if (!mask) throw new Error("请先上传编辑掩膜");
        return { operation: "masked-edit", fields: { prompt }, materials: { src_video: video, src_mask: mask, src_ref_images: [image] } };
    }
    if (video.durationMs && (video.durationMs < 2000 || video.durationMs > 10000)) throw new Error("当前视频编辑模型要求原视频为 2–10 秒，请先裁剪素材");
    return { operation: "video-edit", fields: { prompt, resolution: "720p", audio_setting: "origin" }, materials: { video, reference_image: image } };
}
function subtitleRemoveRequest(d: VideoDraft): { operation: ReplicateOperation; fields: Record<string, unknown>; materials: Record<string, UploadedFile | UploadedFile[]> } {
    const video = d.media.find((m) => m.role === "reference" && m.kind === "video");
    if (!video) throw new Error("请先上传原视频");
    if (d.subtitleMode !== "manual") throw new Error("平台智能服务暂要求手动框选字幕区域；自动 OCR 请切换到增强处理服务");
    if (!d.regions.length) throw new Error("请先手动框选至少一个字幕区域");
    if (video.durationMs && (video.durationMs < 2000 || video.durationMs > 10000)) throw new Error("当前视频去字幕服务要求原视频为 2–10 秒，请先裁剪素材");
    const areas = d.regions.map((region, index) => `区域${index + 1}：左${Math.round(region.x * 100)}%、上${Math.round(region.y * 100)}%、宽${Math.round(region.width * 100)}%、高${Math.round(region.height * 100)}%`).join("；");
    const prompt = `Remove all burned-in subtitles or text overlays only inside these normalized video regions: ${areas}. Reconstruct the background naturally, preserve people, products, camera movement and every other visual detail. Keep the original audio unchanged. Do not add new text or subtitles.`;
    return {
        operation: "subtitle-remove",
        fields: { prompt, audio_setting: "origin", ...(video.durationMs ? { duration: Math.ceil(video.durationMs / 1000) } : {}) },
        materials: { video },
    };
}
export async function restoreWorkbenchFile(file: UploadedFile): Promise<UploadedFile> {
    return { ...file, url: await (file.mimeType.startsWith("image/") ? resolveImageUrl(file.storageKey, file.url) : resolveMediaUrl(file.storageKey, file.url)) };
}

type Context = { signal: AbortSignal; recordId: string; worker: WorkerConfig };
type Invalidation = "materials" | "brief" | "learning" | "preview" | "script" | "speech" | "video" | "finish" | "cover";
export function useVideoWorkbench(tool: VideoTool) {
    const { message, modal } = App.useApp();
    const confirmReplicate = useReplicateConfirmation();
    const navigate = useNavigate();
    const config = useEffectiveConfig();
    const state = useVideoWorkbenchStore();
    const cloudReferences = useRef({ token: "", urls: new Map<string, string>() });
    const digital = isTalkingVideoTool(tool);
    const draft = { ...emptyVideoDraft(tool), ...state.drafts[tool] };
    const busy = Boolean(state.busyTools[tool]);
    const patch = (value: Partial<VideoDraft>) => store().patchDraft(tool, value);

    useEffect(() => {
        if (!state.hydrated) return;
        let disposed = false;
        const resolve = async () => {
            const saved = store().drafts[tool];
            const current = read(tool);
            const media = await Promise.all(current.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
            const frames = await Promise.all(current.frames.map(restoreWorkbenchFile));
            const outputs: Partial<VideoDraft> = {};
            for (const key of ["speech", "voicePreview", "video", "edited", "final", "cover"] as const) {
                const file = current[key];
                if (file) outputs[key] = await restoreWorkbenchFile(file);
            }
            if (tool === "upscale" && current.upscaleOutputInput) outputs.upscaleOutputInput = { ...current.upscaleOutputInput, media: await Promise.all(current.upscaleOutputInput.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) }))) };
            if (!disposed && store().drafts[tool] === saved) patch({ media, frames, ...outputs });
        };
        void resolve().catch((error) => message.error(`素材恢复失败：${error instanceof Error ? error.message : "请重新上传"}`));
        return () => {
            disposed = true;
        };
    }, [tool, state.hydrated]);

    const edit = (value: Partial<VideoDraft>, invalidate?: Invalidation) => {
        if (store().busyTools[tool]) return;
        if (digital && invalidate) value = { ...value, digitalRevision: (read(tool).digitalRevision || 0) + 1 };
        if (digital && ["brief", "learning", "preview"].includes(invalidate || "")) {
            patch({ ...(invalidate === "learning" ? { transcript: "", digitalTranscriptSource: "" } : {}), ...(invalidate === "preview" ? { voicePreview: null } : {}), ...value });
            return;
        }
        if (tool === "upscale") {
            patch({ ...(invalidate ? { upscaleOutputStale: true } : {}), ...value });
            return;
        }
        if (tool === "viral-recreate") {
            const current = read(tool),
                next = { ...current, ...value };
            const sourceChanged = viralSource(current) !== viralSource(next),
                countChanged = value.frameCount !== undefined && value.frameCount !== current.frameCount;
            const productChanged = value.viralFacts !== undefined || (value.media && JSON.stringify(current.media.filter((m) => m.role === "product").map((m) => m.id)) !== JSON.stringify(value.media.filter((m) => m.role === "product").map((m) => m.id)));
            const mentions =
                value.media || sourceChanged || countChanged
                    ? {
                          instructions: remapMaterialMentions(current.instructions, viralMaterialLabels(current), viralMaterialLabels({ ...next, ...(sourceChanged || countChanged ? { frames: [] } : {}) })),
                          script: remapMaterialMentions(current.script, viralMaterialLabels(current), viralMaterialLabels({ ...next, ...(sourceChanged || countChanged ? { frames: [] } : {}) })),
                      }
                    : {};
            patch({
                ...(invalidate ? { viralRevision: (current.viralRevision || 0) + 1, viralOutputStale: true, viralScriptStale: true, viralScriptSuggestion: "" } : {}),
                ...(sourceChanged || countChanged ? { frames: [], viralFrameSource: "", viralFrameTimes: [], viralAnalysisStale: true, viralAnalysisSuggestion: "" } : {}),
                ...(sourceChanged ? { transcript: "", viralTranscriptSource: "" } : {}),
                ...(productChanged ? { viralProductStale: true, viralProductSuggestion: "" } : {}),
                ...mentions,
                ...value,
            });
            return;
        }
        if (tool === "store-explore") {
            const current = read(tool);
            const mentions = value.media
                ? {
                      instructions: remapMaterialMentions(current.instructions, storeMaterialLabels(current), storeMaterialLabels({ ...current, ...value })),
                      script: remapMaterialMentions(current.script, storeMaterialLabels(current), storeMaterialLabels({ ...current, ...value })),
                  }
                : {};
            patch({ ...(invalidate ? { storeOutputStale: true, storeScriptStale: true, storeScriptSuggestion: "" } : {}), ...(invalidate === "materials" ? { storeAnalysisStale: true, storeAnalysisSuggestion: "" } : {}), ...mentions, ...value });
            return;
        }
        if (digital && value.digitalHumanMode && value.digitalHumanMode !== read(tool).digitalHumanMode) {
            const current = read(tool);
            const kind = value.digitalHumanMode === "video" ? "video" : "image";
            patch({
                media: current.media.filter((m) => m.role !== "avatar" || m.kind === kind),
                video: null,
                edited: null,
                final: null,
                cover: null,
                subtitles: [],
                ...(invalidate === "speech" ? { speech: null, voicePreview: null } : {}),
                ...value,
            });
            return;
        }
        const cleared: Partial<VideoDraft> = {};
        if (invalidate === "materials") Object.assign(cleared, { analysis: "", frames: [], transcript: "", script: "", narration: "" });
        if (["materials", "script", "speech"].includes(invalidate || "")) cleared.speech = null;
        if (["materials", "script", "speech", "video"].includes(invalidate || "")) Object.assign(cleared, { video: null, edited: null, subtitles: [], title: "", tags: "" });
        if (invalidate) Object.assign(cleared, { ...(digital && invalidate === "cover" ? {} : { final: null }), cover: null });
        if (digital) { delete cleared.title; delete cleared.tags; }
        if (digital && invalidate === "speech") cleared.voicePreview = null;
        patch({ ...cleared, ...value });
    };
    const addFiles = async (files: File[], role: MediaRole, accept: string) => {
        if (busy) return;
        try {
            const added: WorkbenchMedia[] = [];
            for (const file of files) {
                if (!accept.split(",").some((a) => file.type.startsWith(a.trim().replace("*", "")))) throw new Error("请选择该位置支持的图片、视频或音频格式");
                const result = file.type.startsWith("image/") ? await uploadImage(file) : await uploadMediaFile(file, "video-material");
                added.push({ ...result, storageKey: result.storageKey || "", id: nanoid(), name: file.name, kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "video", role });
            }
            const single = ["voice", "avatar", "music", "mask", "first-frame", "learning"].includes(role) || (tool === "content-replace" && ["model", "background"].includes(role)) || (role === "reference" && added.some((m) => m.kind === "video"));
            const media = [...read(tool).media.filter((m) => !single || m.role !== role), ...added];
            edit(
                { media, ...(digital && role === "avatar" && added[0] ? { digitalHumanMode: added[0].kind === "video" ? "video" : "photo" } : {}), ...(digital && role === "reference" ? { video: added.find((m) => m.kind === "video") || null } : {}) },
                role === "learning" ? "learning" : role === "music" ? "finish" : role === "voice" ? "speech" : role === "avatar" || role === "first-frame" || (digital && role === "reference") ? "video" : "materials",
            );
            return added;
        } catch (error) {
            const detail = error instanceof Error ? error.message : "上传失败";
            message.error(publicServiceText(detail));
            return detail;
        }
    };
    const removeMedia = (id: string) => {
        const item = read(tool).media.find((m) => m.id === id);
        if (!item) return;
        edit(
            { media: read(tool).media.filter((m) => m.id !== id) },
            item.role === "learning" ? "learning" : item.role === "music" ? "finish" : item.role === "voice" ? "speech" : item.role === "avatar" || item.role === "first-frame" || (digital && item.role === "reference") ? "video" : "materials",
        );
    };
    const modelConfig = (capability: "text" | "video" | "audio" | "image", overrides: Partial<AiConfig> = {}): AiConfig => {
        const model = config[`${capability}Model`];
        if (!model) throw new Error(`请先在模型设置中选择${{ text: "分析/文案", video: "视频", audio: "语音", image: "封面图片" }[capability]}模型`);
        return { ...config, model, ...overrides };
    };
    const confirmStorePrice = (quote: VideoPrice, label: string, signal: AbortSignal, details: string) =>
        new Promise<void>((resolve, reject) => {
            const finish = (accepted: boolean) => {
                signal.removeEventListener("abort", abort);
                accepted ? resolve() : reject(new DOMException("已取消本次制作，未创建收费任务", "AbortError"));
            };
            const dialog = modal.confirm({
                title: `确认${label}费用`,
                content: `${details}；${quote.calculation}；本次 ${quote.credits.toLocaleString()} 算力点。文案与视频分开计费。`,
                okText: "确认制作",
                cancelText: "取消",
                onOk: () => finish(true),
                onCancel: () => finish(false),
            });
            const abort = () => {
                dialog.destroy();
                finish(false);
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
        });
    const quoteStoreVideo = async (signal?: AbortSignal) => {
        const d = read(tool),
            cfg = storeVideoConfig(d, config);
        const error = storeVideoError(d, cfg);
        if (error) throw new Error(error);
        if (cfg.channelMode !== "remote" && !isReplicateVideoModel(cfg.videoModel)) throw new Error("自定义渠道费用以该服务账单为准");
        return quoteVideoModel(cfg, cfg.videoModel, signal);
    };
    const quoteViralVideo = async (signal?: AbortSignal) => {
        const d = read(tool),
            cfg = viralVideoConfig(d, config),
            error = viralVideoError(d, cfg);
        if (error) throw new Error(error);
        if (cfg.channelMode !== "remote" && !isReplicateVideoModel(cfg.videoModel)) throw new Error("自定义渠道费用以该服务账单为准");
        return quoteVideoModel(cfg, cfg.videoModel, signal);
    };
    const text = async (ctx: Context, instruction: string, imageFiles: UploadedFile[] = []) => {
        if (["store-explore", "viral-recreate", "digital-human", "photo-talk", "lipsync"].includes(tool) && config.channelMode === "remote") {
            const cfg = modelConfig("text");
            const quote = await quoteTextModel(cfg, cfg.model, ctx.signal);
            await confirmStorePrice(quote, "文案处理", ctx.signal, "分析 / 撰写按当前文字模型单独计费");
            ctx.signal.throwIfAborted();
        }
        const content: Exclude<AiTextMessage["content"], string> = [{ type: "text", text: instruction }];
        for (const image of imageFiles) {
            content.push({ type: "image_url", image_url: { url: await imageToDataUrl({ dataUrl: image.url, storageKey: image.storageKey }) } });
        }
        const value = await requestImageQuestion(modelConfig("text"), [{ role: "user", content }], (value) => store().patchRecord(ctx.recordId, { text: value }), { signal: ctx.signal });
        if (!value.trim()) throw new Error("模型没有返回内容");
        return value;
    };
    const workerJob = async (ctx: Context, operation: string, inputs: Record<string, UploadedFile | UploadedFile[]>, options: Record<string, unknown> = {}) => {
        const capabilities = await getWorkerCapabilities(ctx.worker);
        const name = operation === "replace" ? (read(tool).replacement === "person" ? "replace-person" : "replace-product") : operation;
        const capability = capabilities.find((c) => c.name === name);
        if (!capability?.available) throw new Error(capability?.reason || `处理服务不支持 ${operation}`);
        const uploaded: Record<string, string | string[]> = {};
        for (const [key, files] of Object.entries(inputs)) {
            uploaded[key] = Array.isArray(files)
                ? await Promise.all(files.map((file) => uploadWorkerMedia(ctx.worker, { ...file, kind: file.mimeType.startsWith("image/") ? "image" : file.mimeType.startsWith("audio/") ? "audio" : "video" }, ctx.signal)))
                : await uploadWorkerMedia(ctx.worker, { ...files, kind: files.mimeType.startsWith("image/") ? "image" : files.mimeType.startsWith("audio/") ? "audio" : "video" }, ctx.signal);
        }
        const job = await createWorkerJob(ctx.worker, operation, uploaded, options, ctx.signal);
        store().patchRecord(ctx.recordId, { workerJob: { id: job.id, url: resolveWorkerUrl(ctx.worker) } });
        const result = await waitForWorkerJob(ctx.worker, job.id, ctx.signal, (job) => store().patchRecord(ctx.recordId, { step: job.step, ...(digital && ["failed", "cancelled"].includes(job.status) ? { status: "failed" as const } : {}) }));
        if (digital && operation === "transcribe" && !result.result?.text?.trim()) {
            store().patchRecord(ctx.recordId, { status: "failed" });
            throw new Error("没有识别到口播文字，请检查人声或手动粘贴参考原文");
        }
        return result;
    };
    const required = (file: UploadedFile | null | undefined, label: string) => {
        if (!file) throw new Error(`请先${label}`);
        return file;
    };
    const applyWorkerResult = async (stage: string, job: WorkerJob, worker: WorkerConfig, source = read(tool)): Promise<Partial<VideoDraft>> => {
        if (!job.result) throw new Error("处理服务未返回结果");
        if (stage === "frames") {
            const frames = await Promise.all((job.result.files || []).map((id) => storeWorkerImage(worker, id)));
            if (!frames.length) throw new Error("处理服务没有返回抽样画面");
            return {
                frames,
                ...(tool === "viral-recreate"
                    ? {
                          viralFrameSource: viralSource(source),
                          viralFrameTimes: Number(job.result!.metadata?.duration) > 0 ? frames.map((_, i) => (Number(job.result!.metadata?.duration) * i) / source.frameCount) : [],
                          viralAnalysisStale: true,
                          viralAnalysisSuggestion: "",
                          viralScriptStale: Boolean(source.script),
                          viralScriptSuggestion: "",
                          viralOutputStale: true,
                      }
                    : {}),
            };
        }
        if (stage === "transcribe") {
            if (digital && !job.result.text?.trim()) throw new Error("没有识别到口播文字，请检查人声或手动粘贴参考原文");
            return {
                transcript: job.result.text || "",
                ...(digital ? { digitalTranscriptSource: digitalLearningSource(source) } : {}),
                ...(tool === "viral-recreate" ? { viralTranscriptSource: viralSource(source), viralAnalysisStale: true, viralAnalysisSuggestion: "", viralScriptStale: Boolean(source.script), viralScriptSuggestion: "", viralOutputStale: true } : {}),
            };
        }
        if (stage === "subtitles") return { subtitles: job.result.segments || [] };
        if (stage === "cover") {
            if (!job.result.files?.[0]) throw new Error("没有提取到封面帧");
            return { cover: await storeWorkerImage(worker, job.result.files[0]) };
        }
        if (!job.result.file) throw new Error("处理服务未返回输出文件");
        const result = await storeWorkerResult(worker, job.result.file);
        return { [stage === "speech-preview" ? "voicePreview" : stage === "speech" ? "speech" : stage === "video" ? "video" : stage === "cut" ? "edited" : "final"]: result };
    };
    const cloudResult = async (stage: string, task: ReplicateTask): Promise<Partial<VideoDraft>> => {
        if (task.operation === "transcribe") {
            const result = await readReplicateTranscription(task);
            if (stage === "subtitles") {
                if (!result.segments?.length) throw new Error("识别已完成，但未返回有效字幕时间轴，请手动添加字幕");
                return { subtitles: result.segments };
            }
            return { transcript: result.text, digitalTranscriptSource: digitalLearningSource(read(tool)) };
        }
        const file = await storeReplicateResult(task);
        return stage === "speech-preview" ? { voicePreview: file } : stage === "speech" ? { speech: file } : stage === "upscale" || stage === "subtitle-remove" ? { final: file } : { video: file };
    };
    const cloudInput = async (fields: Record<string, unknown>, materials: Record<string, UploadedFile | UploadedFile[]>, signal?: AbortSignal, purpose?: "transcribe") => {
        const session = useUserStore.getState().token;
        if (cloudReferences.current.token !== session) cloudReferences.current = { token: session, urls: new Map() };
        const cache = cloudReferences.current;
        const upload = async (file: UploadedFile) => {
            if (!["content-replace", "upscale", "digital-human", "photo-talk", "lipsync"].includes(tool)) return uploadReplicateReference(file, signal);
            const key = `${purpose || "media"}:${file.storageKey || file.url}`;
            if (cache.urls.has(key)) return cache.urls.get(key)!;
            const url = await uploadReplicateReference(file, signal, purpose);
            signal?.throwIfAborted();
            if (useUserStore.getState().token !== session) throw new Error("登录状态已变化，请重新查看费用");
            cache.urls.set(key, url);
            return url;
        };
        const input = { ...fields };
        for (const [key, files] of Object.entries(materials)) input[key] = Array.isArray(files) ? await Promise.all(files.map(upload)) : await upload(files);
        return input;
    };
    const quoteReplacement = async (signal?: AbortSignal) => {
        const { operation, fields, materials } = replacementRequest(read(tool));
        return quoteReplicate(operation, await cloudInput(fields, materials, signal), signal);
    };
    const quoteDigitalHuman = async (signal?: AbortSignal) => {
        const { operation, fields, materials } = digitalHumanRequest(read(tool));
        return quoteReplicate(operation, await cloudInput(fields, materials, signal), signal);
    };
    const quoteUpscale = async (signal?: AbortSignal) => {
        const d = read(tool), input = upscaleInput(d), error = upscaleError(input);
        if (error) throw new Error(error);
        if (d.route !== "replicate") throw new Error("增强处理费用以当前处理服务为准");
        return quoteReplicate("upscale", await cloudInput({ target_resolution: d.replicateTargetResolution, target_fps: d.replicateFps }, { video: input.media[0] }, signal), signal);
    };
    const cloud = async (ctx: Context, stage: string, operation: ReplicateOperation, fields: Record<string, unknown>, materials: Record<string, UploadedFile | UploadedFile[]>): Promise<Partial<VideoDraft>> => {
        if (operation === "transcribe") {
            const model = (await getReplicateModels(ctx.signal)).find((item) => item.operation === operation);
            const reason = transcriptionUnavailable(model);
            if (reason) throw new Error(reason);
        }
        const input = await cloudInput(fields, materials, ctx.signal, operation === "transcribe" ? "transcribe" : undefined);
        const quote = await quoteReplicate(operation, input, ctx.signal);
        await confirmReplicate(quote, ctx.signal);
        ctx.signal.throwIfAborted();
        if (digital) store().patchRecord(ctx.recordId, { digitalHumanQuote: quote });
        store().patchRecord(ctx.recordId, { replicateTask: { id: ctx.recordId, operation } });
        try {
            await createReplicateTask(ctx.recordId, operation, input, quote.credits, ctx.signal);
        } catch (error) {
            if (operation === "transcribe" && !ctx.signal.aborted) {
                try { await readReplicateTask(ctx.recordId, ctx.signal); }
                catch (lookupError) {
                    if (lookupError instanceof Error && lookupError.name === "ReplicateTaskNotFound") store().patchRecord(ctx.recordId, { replicateTask: undefined, status: "failed" });
                }
            }
            throw error;
        }
        const task = await waitForReplicateTask(ctx.recordId, ctx.signal, (job) =>
            store().patchRecord(ctx.recordId, {
                step: job.status === "generated" ? "模型已完成，正在保存作品" : job.status === "creating" ? "平台任务正在提交" : job.status === "running" ? "平台服务正在处理" : publicServiceText(job.error || job.status),
                ...(job.status === "failed" || job.status === "cancelled" ? { status: "failed" as const } : {}),
            }),
        );
        return cloudResult(stage, task);
    };
    const execute = async (stage: string, ctx: Context): Promise<Partial<VideoDraft>> => {
        const d = read(tool);
        if (tool === "viral-recreate" && ["analyze", "product-analyze", "script"].includes(stage)) {
            const cfg = viralVideoConfig(d, config),
                labels = viralMaterialLabels(d);
            const images = stage === "analyze" ? d.frames : d.media.filter((m) => m.kind === "image" && (stage === "product-analyze" ? m.role === "product" : ["product", "model", "first-frame"].includes(m.role)));
            const instruction =
                stage === "analyze"
                    ? `分析原视频的均匀抽样画面，按开场、可见镜头顺序、卖点承接、结尾整理。采样秒数：${(d.viralFrameTimes || []).join("、")}。这不是镜头边界，不推测精确转场或音乐节拍。${d.transcript && d.viralTranscriptSource === viralSource(d) ? `用户确认/转写的音轨：${d.transcript}` : "没有音轨转写，只能按画面分析，不声称听到了口播或音乐。"} 只描述可见事实，不混入新商品或人物。`
                    : stage === "product-analyze"
                      ? `分析新商品图片，只写可见外观和可用展示方式。用户真实资料：${d.viralFacts || "未提供"}。不得编造价格、优惠、功效或承诺；未知标待确认。`
                      : `为参考视频改编新商品中文脚本，只返回可编辑脚本，适配实际${cfg.videoSeconds}秒单片段。不能承诺多镜头后期、配音字幕已完成。真实商品资料：${d.viralFacts || "未提供，不虚构价格、优惠、功效或承诺"}。参考结构：${d.viralAnalysisStale ? "旧分析输入已变，需核对：" : ""}${d.analysis}。新商品分析：${d.viralProductStale ? "旧分析素材已变，以资料和图片为准" : d.viralProductAnalysis || "未提供"}。改编要求：${d.instructions}。原稿：${d.script}。编号：${labels.map((l) => `${l.label}=${l.name}`).join("；")}。保留用户@编号，不编造编号。当前视频实际输入为${
                            viralVideoMaterials(d, cfg)
                                .map((m) => m.name)
                                .join("、") || "尚未选择"
                        }；未发送的新人物/商品须准备相应首帧，不承诺凭文字即可精准替换。`;
            const value = await text(ctx, instruction, images);
            if (stage === "analyze") return { ...(d.analysis ? { viralAnalysisSuggestion: value } : { analysis: value, viralAnalysisStale: false }), viralScriptStale: Boolean(d.script), viralOutputStale: true };
            if (stage === "product-analyze") return { ...(d.viralProductAnalysis ? { viralProductSuggestion: value } : { viralProductAnalysis: value, viralProductStale: false }), viralScriptStale: Boolean(d.script), viralOutputStale: true };
            return d.script ? { viralScriptSuggestion: value } : { script: value, viralScriptStale: false, viralOutputStale: true };
        }
        if (tool === "viral-recreate" && stage === "video") {
            const cfg = viralVideoConfig(d, config),
                error = viralVideoError(d, cfg),
                materials = viralVideoMaterials(d, cfg);
            if (error) throw new Error(error);
            let expectedCredits: number | undefined;
            if (cfg.channelMode === "remote" && !isReplicateVideoModel(cfg.videoModel)) {
                const quote = await quoteVideoModel(cfg, cfg.videoModel, ctx.signal);
                await confirmStorePrice(quote, "视频制作", ctx.signal, `${cfg.videoSeconds}秒 · ${cfg.vquality}p · ${materials.filter((m) => m.kind === "image").length}张图片 / ${materials.filter((m) => m.kind === "video").length}个视频实际输入`);
                expectedCredits = quote.credits;
            }
            ctx.signal.throwIfAborted();
            const task = await createVideoGenerationTask(cfg, viralVideoPrompt(d, cfg), imagesOf(materials), mediaOf(materials, "video"), [], {
                signal: ctx.signal,
                expectedCredits,
                confirmReplicate,
                onTaskSubmitted: async (task) => {
                    store().patchRecord(ctx.recordId, { modelTask: task, ...(task.provider === "replicate" ? { replicateTask: { id: task.id, operation: task.model === REPLICATE_VIDEO_MODEL ? "image-to-video" : "hailuo-video" } } : {}) });
                },
            });
            store().patchRecord(ctx.recordId, { modelTask: task });
            return {
                video: await storeGeneratedVideo(
                    await waitForVideoGenerationTask(cfg, task, {
                        signal: ctx.signal,
                        onWaitState: (state) => store().patchRecord(ctx.recordId, { step: state === "query_interrupted" ? "查询中断，可恢复原任务" : state === "background" ? "已转后台查询" : "视频模型正在处理" }),
                    }),
                ),
                viralOutputStale: false,
            };
        }
        if (tool === "store-explore") {
            const cfg = storeVideoConfig(d, config);
            const labels = storeMaterialLabels(d);
            const images = d.media.filter((m) => m.kind === "image" && ["reference", "model", "first-frame"].includes(m.role));
            if (stage === "analyze" || stage === "script") {
                const instruction =
                    stage === "analyze"
                        ? `分析门店环境、商品和可用镜头，只描述图片可见事实。价格、地址、活动只能引用用户真实资料，未知事项标记待确认。人物图只用于描述人物。真实资料：${d.storeFacts || "未提供"}。创作要求：${d.instructions}`
                        : `为探店视频写一段可直接提交模型的中文镜头脚本。只输出脚本，适配实际${cfg.videoSeconds}秒单条片段，不能承诺长视频、多镜头剪辑、配音或字幕已经完成。门店价格、地址和活动只能引用用户真实资料。资料：${d.storeFacts || "未提供，不虚构"}。要求：${d.instructions}。视觉分析：${d.analysis}。原稿供参考：${d.script}。素材编号：${labels.map((m) => `${m.label}=${m.name}`).join("；")}；保留用户的@素材编号，不添加不存在的编号。`;
                const value = await text(ctx, instruction, images);
                return stage === "analyze"
                    ? { ...(d.analysis ? { storeAnalysisSuggestion: value } : { analysis: value, storeAnalysisStale: false }), storeScriptStale: Boolean(d.script), storeOutputStale: true }
                    : d.script
                      ? { storeScriptSuggestion: value }
                      : { script: value, storeScriptStale: false, storeOutputStale: true };
            }
            if (stage === "video") {
                const error = storeVideoError(d, cfg);
                if (error) throw new Error(error);
                let expectedCredits: number | undefined;
                if (cfg.channelMode === "remote" && !isReplicateVideoModel(cfg.videoModel)) {
                    const quote = await quoteVideoModel(cfg, cfg.videoModel, ctx.signal);
                    await confirmStorePrice(quote, "视频制作", ctx.signal, `${cfg.videoSeconds}秒 · ${cfg.vquality}p · ${storeVideoMaterials(d, cfg).length}张实际图片输入`);
                    expectedCredits = quote.credits;
                }
                ctx.signal.throwIfAborted();
                const task = await createVideoGenerationTask(cfg, storeVideoPrompt(d, cfg), imagesOf(storeVideoMaterials(d, cfg)), [], [], {
                    signal: ctx.signal,
                    expectedCredits,
                    confirmReplicate,
                    onTaskSubmitted: async (task) => {
                        store().patchRecord(ctx.recordId, { modelTask: task, ...(task.provider === "replicate" ? { replicateTask: { id: task.id, operation: task.model === REPLICATE_VIDEO_MODEL ? "image-to-video" : "hailuo-video" } } : {}) });
                    },
                });
                store().patchRecord(ctx.recordId, { modelTask: task });
                return {
                    video: await storeGeneratedVideo(
                        await waitForVideoGenerationTask(cfg, task, {
                            signal: ctx.signal,
                            onWaitState: (state) => store().patchRecord(ctx.recordId, { step: state === "query_interrupted" ? "查询中断，可恢复原任务" : state === "background" ? "已转后台查询" : "视频模型正在处理" }),
                        }),
                    ),
                    storeOutputStale: false,
                };
            }
        }
        const reference = d.media.find((m) => m.role === "reference" && m.kind === "video");
        if (stage === "frames") return applyWorkerResult(stage, await workerJob(ctx, "frames", { video: required(reference, "上传参考视频") }, { count: d.frameCount }), ctx.worker, d);
        if (stage === "transcribe") {
            const video = required(digital ? d.media.find((m) => m.role === "learning" && m.kind === "video") : reference, "上传参考视频");
            if (digital && d.digitalTranscribeRoute !== "worker") return cloud(ctx, stage, "transcribe", { task: "transcribe", timestamp: "word", language: "None" }, { audio: video });
            return applyWorkerResult(stage, await workerJob(ctx, "transcribe", { video }), ctx.worker, d);
        }
        if (stage === "analyze")
            return {
                analysis: await text(
                    ctx,
                    `分析这些${tool === "store-explore" ? "门店/商品素材，按空间、产品卖点、可用镜头" : "按时间顺序抽取的参考视频帧及商品/模特素材，按开场钩子、镜头顺序、动作、转场、节奏、卖点、结尾转化"}整理成中文拍摄分析。只描述可见事实，不编造价格、门店位置或促销。用户资料：${d.instructions}。${d.transcript ? `已转写的音轨：${d.transcript}` : "当前没有语音转写，明确注明仅根据画面进行分析，不声称听到了原视频。"}`,
                    [...d.frames, ...d.media.filter((m) => m.kind === "image" && ["reference", "model", "background"].includes(m.role))],
                ),
            };
        if (stage === "script") {
            if (digital) {
                const error = digitalHumanScriptError(d);
                if (error) throw new Error(error);
                const script = await text(ctx, digitalHumanScriptPrompt(d));
                return { script, narration: script };
            }
            const script = await text(
                ctx,
                `为${tool === "store-explore" ? "探店视频" : tool === "cloud-create" ? "视频创作" : "参考视频改编"}写中文制作脚本。用户资料：${d.instructions}。素材分析：${d.analysis}。目标时长${config.videoSeconds}秒。给出镜头顺序、画面、动作、口播、时长与字幕建议。保留商品真实信息，不虚构承诺。只返回脚本，可直接编辑。`,
            );
            return { script };
        }
        if (stage === "speech" || stage === "speech-preview") {
            const narration = stage === "speech-preview" ? d.digitalPreviewText.trim() : d.narration.trim() || d.script.trim();
            if (!narration) throw new Error("请先填写或生成口播文案");
            if (d.route === "replicate") {
                const materials: Record<string, UploadedFile | UploadedFile[]> = {};
                if (d.voiceMode === "clone")
                    materials.reference_audio = required(
                        d.media.find((m) => m.role === "voice"),
                        "上传声音样本",
                    );
                return cloud(
                    ctx,
                    stage,
                    "speech",
                    {
                        text: narration,
                        mode: d.voiceMode === "clone" ? "voice_clone" : "custom_voice",
                        language: d.language === "中文" ? "Chinese" : d.language,
                        ...(d.voiceMode === "clone" ? { ...(d.promptTranscript.trim() ? { reference_text: d.promptTranscript } : {}) } : { speaker: d.replicateSpeaker }),
                    },
                    materials,
                );
            }
            if (d.voiceMode === "clone") {
                if (!d.promptTranscript.trim()) throw new Error("请填写声音样本的原文，供 CosyVoice 对齐");
                return applyWorkerResult(
                    stage,
                    await workerJob(
                        ctx,
                        "voice-clone",
                        {
                            voice: required(
                                d.media.find((m) => m.role === "voice"),
                                "上传声音样本",
                            ),
                        },
                        { text: narration, promptText: d.promptTranscript },
                    ),
                    ctx.worker,
                );
            }
            return {
                [stage === "speech-preview" ? "voicePreview" : "speech"]: await storeGeneratedAudio(
                    await requestAudioGeneration(modelConfig("audio", { audioVoice: d.voice || config.audioVoice, audioInstructions: `用${d.language}自然表达。${config.audioInstructions}` }), narration, { signal: ctx.signal }),
                ),
            };
        }
        if (stage === "video") {
            if (d.route === "replicate") {
                if (digital) {
                    const { operation, fields, materials } = digitalHumanRequest(d);
                    return cloud(ctx, stage, operation, fields, materials);
                }
                if (tool === "content-replace") {
                    const { operation, fields, materials } = replacementRequest(read(tool));
                    return cloud(ctx, stage, operation, fields, materials);
                }
                if (!d.script.trim()) throw new Error("请先填写或生成视频脚本");
                const image = required(d.media.find((m) => m.role === "first-frame") || d.media.find((m) => m.kind === "image" && m.role === "reference") || d.frames[0], "上传首帧图片或先抽取参考视频画面");
                return cloud(ctx, stage, "image-to-video", { prompt: d.script, num_frames: d.replicateFrames, resolution: d.replicateResolution }, { image });
            }
            if (digital)
                return applyWorkerResult(
                    stage,
                    await workerJob(ctx, "digital-human", {
                        avatar: required(
                            d.media.find((m) => m.role === "avatar" && m.kind === (d.digitalHumanMode === "video" ? "video" : "image")),
                            "上传当前模式的数字人形象",
                        ),
                        audio: required(d.speech, "生成或导入口播音频"),
                    }),
                    ctx.worker,
                );
            if (tool === "content-replace" && d.route === "worker")
                return applyWorkerResult(
                    stage,
                    await workerJob(
                        ctx,
                        "replace",
                        {
                            video: required(reference, "上传原视频"),
                            ...(d.replacement === "background"
                                ? {
                                      image: required(
                                          d.media.find((m) => m.role === "background" || m.role === "model"),
                                          "上传背景图片",
                                      ),
                                  }
                                : {
                                      image: required(
                                          d.media.find((m) => m.role === "model"),
                                          "上传替换主体图",
                                      ),
                                  }),
                            ...(d.replacement !== "person" && d.media.find((m) => m.role === "mask") ? { mask: d.media.find((m) => m.role === "mask")! } : {}),
                            ...(d.replacement !== "background" && d.media.find((m) => m.role === "background") ? { background: d.media.find((m) => m.role === "background")! } : {}),
                        },
                        { replacement: d.replacement, prompt: d.instructions, regions: d.regions },
                    ),
                    ctx.worker,
                );
            if (!d.script.trim() && tool !== "content-replace") throw new Error("请先编辑或生成脚本");
            if (tool === "content-replace") {
                required(reference, "上传原视频");
                required(
                    d.media.find((m) => m.role === (d.replacement === "background" ? "background" : "model")),
                    "上传替换图片",
                );
            }
            const prompt =
                tool === "content-replace"
                    ? `对参考视频进行${{ person: "人物", product: "商品", background: "背景" }[d.replacement]}替换。使用对应参考图，保持原视频动作、构图、节奏及其他内容。${d.instructions}`
                    : `${d.script}\n实际素材信息：${d.instructions}\n${d.analysis}`;
            const materials = d.media.filter((m) => (tool === "content-replace" ? m.role === "reference" || m.role === (d.replacement === "background" ? "background" : "model") : ["reference", "model", "background"].includes(m.role)));
            const task = await createVideoGenerationTask(modelConfig("video"), prompt, imagesOf(materials), mediaOf(materials, "video"), mediaOf(materials, "audio"), { signal: ctx.signal });
            store().patchRecord(ctx.recordId, { modelTask: task });
            return {
                video: await storeGeneratedVideo(
                    await waitForVideoGenerationTask(modelConfig("video"), task, {
                        signal: ctx.signal,
                        onWaitState: (value) => store().patchRecord(ctx.recordId, { step: value === "background" ? "模型处理中，已转后台查询" : value === "query_interrupted" ? "查询被打断，可恢复查询" : "模型正在生成" }),
                    }),
                ),
            };
        }
        if (stage === "cut") return applyWorkerResult(stage, await workerJob(ctx, "cut", { video: required(d.video, "生成或导入视频") }), ctx.worker);
        if (stage === "metadata") {
            const output = await text(ctx, `根据以下口播和素材资料，生成一个中文短视频标题和 3 到 6 个相关话题标签，不虚构承诺。只输出 JSON：{"title":"标题","tags":["标签"]}。${d.narration || d.script}\n${digital ? digitalHumanBriefText(d) : d.instructions}\n${d.analysis}`);
            const data = JSON.parse(
                output
                    .trim()
                    .replace(/^```(?:json)?\s*/, "")
                    .replace(/\s*```$/, ""),
            );
            if (typeof data.title !== "string" || !Array.isArray(data.tags)) throw new Error("模型标题格式不正确，请重试此步骤");
            return { title: data.title, tags: data.tags.filter((t: unknown) => typeof t === "string").join(", ") };
        }
        if (stage === "subtitles") {
            const video = required(d.edited || d.video, "生成或导入视频");
            if (digital && d.digitalTranscribeRoute !== "worker") return cloud(ctx, stage, "transcribe", { task: "transcribe", timestamp: "chunk", language: "None" }, { audio: video });
            return applyWorkerResult(stage, await workerJob(ctx, "transcribe", { video }), ctx.worker);
        }
        if (stage === "compose") {
            if (d.addSubtitles && !d.subtitles.length) throw new Error("请先识别或手动录入字幕时间轴");
            if (digital && digitalHumanSubtitleError(d)) throw new Error(digitalHumanSubtitleError(d));
            const music = d.media.find((m) => m.role === "music");
            return applyWorkerResult(
                stage,
                await workerJob(
                    ctx,
                    "compose",
                    { video: required(d.edited || d.video, "生成或导入视频"), ...(music ? { music } : {}) },
                    { subtitles: d.addSubtitles ? d.subtitles : [], musicVolume: d.musicVolume, subtitleSize: d.subtitleSize, subtitleColor: d.subtitleColor, highlightColor: d.highlightColor, keywords: d.keywords },
                ),
                ctx.worker,
            );
        }
        if (stage === "cover") {
            const video = required(d.final || d.edited || d.video, "生成或导入视频");
            if (d.coverMode === "frame") return applyWorkerResult(stage, await workerJob(ctx, "frames", { video }, { count: 1 }), ctx.worker);
            const frames = await workerJob(ctx, "frames", { video }, { count: 1 });
            const first = frames.result?.files?.[0];
            if (!first) throw new Error("无法抽取封面参考帧");
            store().patchRecord(ctx.recordId, { workerJob: undefined });
            const image = await storeWorkerImage(ctx.worker, first);
            const result = await requestEdit(
                modelConfig("image", { count: "1" }),
                `将参考视频画面制作成短视频封面，保留人物/产品特征，排版清晰醒目，中文主标题为：${d.title || d.instructions}。`,
                [{ id: nanoid(), name: "封面参考帧", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey }],
                { signal: ctx.signal },
            );
            if (!result[0]) throw new Error("封面模型未返回图片");
            const cover = await uploadImage(result[0].dataUrl);
            return { cover: { ...cover, storageKey: cover.storageKey || "" } };
        }
        if (stage === "compatibility") return applyWorkerResult(stage, await workerJob(ctx, "compose", { video: required(d.final || d.video, "生成视频") }), ctx.worker);
        if (stage === "upscale" && d.route === "replicate") return cloud(ctx, stage, "upscale", { target_resolution: d.replicateTargetResolution, target_fps: d.replicateFps }, { video: required(reference, "上传原视频") });
        if (stage === "subtitle-remove" && d.route === "replicate") {
            const { operation, fields, materials } = subtitleRemoveRequest(read(tool));
            return cloud(ctx, stage, operation, fields, materials);
        }
        if (stage === "upscale" || stage === "subtitle-remove")
            return applyWorkerResult(stage, await workerJob(ctx, stage, { video: required(reference, "上传原视频") }, stage === "upscale" ? { scale: d.scale, fps: d.fps } : { regions: d.regions }), ctx.worker);
        throw new Error("未知制作步骤");
    };
    const clearAfter = (stage: string): Partial<VideoDraft> => {
        if (tool === "viral-recreate") return stage === "video" ? { edited: null, final: null, cover: null, viralOutputStale: false } : {};
        if (tool === "store-explore") return stage === "video" ? { edited: null, final: null, cover: null, storeOutputStale: false } : {};
        if (stage === "video") return { edited: null, final: null, cover: null, subtitles: [] };
        if (stage === "cut") return { final: null, cover: null, subtitles: [] };
        if (stage === "speech") return { video: null, edited: null, final: null, cover: null, subtitles: [] };
        if (stage === "script" || stage === "analyze") return { speech: null, video: null, edited: null, final: null, cover: null, ...(digital ? {} : { title: "", tags: "" }), subtitles: [] };
        if (stage === "subtitles") return { final: null, cover: null };
        if (["compose", "metadata", "upscale", "subtitle-remove", "compatibility"].includes(stage)) return { cover: null };
        return {};
    };
    const perform = async (stage: string, signal: AbortSignal) => {
        for (const record of store().records.filter((r) => r.tool === tool && r.stage === stage && r.replicateTask && r.status !== "completed")) {
            const existing = await readReplicateTask(record.replicateTask!.id, signal);
            if (existing.status !== "failed" && existing.status !== "cancelled") throw new Error("该步骤已有云任务，请从任务记录恢复查询，避免重复付费");
        }
        const id = nanoid();
        const worker = { ...store().worker };
        const d = read(tool);
        store().addRecord({
            id,
            tool,
            stage,
            status: "running",
            createdAt: Date.now(),
            ...(tool === "upscale" ? { upscaleInput: stage === "compatibility" ? d.upscaleOutputInput : upscaleInput(d) } : {}),
            ...(tool === "content-replace"
                ? {
                      replacementInput: {
                          replacement: d.replacement,
                          route: d.route,
                          instructions: d.instructions,
                          maskedEdit: d.maskedEdit,
                          replicateResolution: d.replicateResolution,
                          regions: d.regions,
                          media: d.media.filter(
                              (m) =>
                                  m.role === "reference" ||
                                  m.role === (d.replacement === "background" ? "background" : "model") ||
                                  (m.role === "mask" && d.replacement !== "person" && (d.maskedEdit || d.route === "worker")) ||
                                  (m.role === "background" && d.route === "worker"),
                          ),
                      },
                  }
                : {}),
        });
        if (digital)
            store().patchRecord(id, {
                digitalHumanInput: {
                    media: d.media.filter((m) => ["avatar", "voice", "reference", "learning", "music"].includes(m.role)),
                    instructions: d.instructions,
                    digitalBrief: d.digitalBrief,
                    digitalCopySource: d.digitalCopySource,
                    digitalTranscribeRoute: d.digitalTranscribeRoute,
                    digitalMotion: d.digitalMotion,
                    transcript: d.transcript,
                    digitalTranscriptSource: d.digitalTranscriptSource,
                    digitalPreviewText: d.digitalPreviewText,
                    voicePreview: d.voicePreview,
                    script: d.script,
                    narration: d.narration,
                    speech: d.speech,
                    voiceMode: d.voiceMode,
                    digitalHumanMode: d.digitalHumanMode,
                    promptTranscript: d.promptTranscript,
                    language: d.language,
                    replicateSpeaker: d.replicateSpeaker,
                    voice: d.voice,
                    route: d.route,
                    cutSilence: d.cutSilence,
                    addSubtitles: d.addSubtitles,
                    coverMode: d.coverMode,
                    title: d.title,
                    tags: d.tags,
                    keywords: d.keywords,
                    musicVolume: d.musicVolume,
                    subtitleSize: d.subtitleSize,
                    subtitleColor: d.subtitleColor,
                    highlightColor: d.highlightColor,
                    video: d.video,
                    edited: d.edited,
                    final: d.final,
                    subtitles: d.subtitles,
                    digitalRevision: d.digitalRevision,
                    channelMode: config.channelMode,
                    baseUrl: d.route === "replicate" ? "" : resolveWorkerUrl(worker),
                    audioModel: config.audioModel,
                    textModel: config.textModel,
                },
            });
        if (tool === "subtitle-remove")
            store().patchRecord(id, {
                subtitleRemoveInput: {
                    media: d.media.filter((m) => m.role === "reference" && m.kind === "video"),
                    subtitleMode: d.subtitleMode,
                    regions: d.regions,
                    route: d.route,
                    workerUrl: worker.url,
                },
            });
        if (tool === "store-explore")
            store().patchRecord(id, {
                storeExploreInput: {
                    media: d.media,
                    storeFacts: d.storeFacts,
                    instructions: d.instructions,
                    analysis: d.analysis,
                    script: d.script,
                    storeFirstFrameId: d.storeFirstFrameId,
                    storeLastFrameId: d.storeLastFrameId,
                    storeSettings: storeVideoSettings(storeVideoConfig(d, config)),
                    channelMode: config.channelMode,
                    baseUrl: resolveModelRequestConfig(config, storeVideoConfig(d, config).videoModel).baseUrl,
                },
            });
        if (tool === "viral-recreate") store().patchRecord(id, { viralInput: viralInput(d, viralVideoConfig(d, config)) });
        patch({ activeRecord: id });
        try {
            const value = await execute(stage, { signal, recordId: id, worker });
            signal.throwIfAborted();
            if (tool === "upscale" && stage === "upscale") Object.assign(value, { upscaleOutputInput: upscaleInput(d), upscaleOutputStale: false });
            if ((tool !== "viral-recreate" || (read(tool).viralRevision || 0) === (d.viralRevision || 0)) && (!digital || (read(tool).digitalRevision || 0) === (d.digitalRevision || 0))) {
                const current = read(tool);
                const mentions =
                    tool === "viral-recreate" && value.frames
                        ? {
                              instructions: remapMaterialMentions(current.instructions, viralMaterialLabels(current), viralMaterialLabels({ ...current, ...value })),
                              script: remapMaterialMentions(current.script, viralMaterialLabels(current), viralMaterialLabels({ ...current, ...value })),
                          }
                        : {};
                patch({ ...clearAfter(stage), ...value, ...mentions });
            }
            const result = [value.final, value.cover, value.edited, value.video, value.speech, value.voicePreview].find(Boolean) || undefined;
            store().patchRecord(id, {
                status: "completed",
                result,
                draftPatch: value,
                text:
                    value.analysis ||
                    value.script ||
                    value.storeAnalysisSuggestion ||
                    value.storeScriptSuggestion ||
                    value.viralAnalysisSuggestion ||
                    value.viralProductAnalysis ||
                    value.viralProductSuggestion ||
                    value.viralScriptSuggestion ||
                    value.transcript,
                step: "已完成",
            });
        } catch (error) {
            const stopped = signal.aborted;
            const detail = stopped ? "已停止本地等待；已提交的模型任务仍可能继续运行，可恢复查询" : error instanceof Error ? error.message : "执行失败";
            const submitted = store().records.find((r) => r.id === id);
            if (["content-replace", "store-explore", "viral-recreate", "upscale", "digital-human", "photo-talk", "lipsync"].includes(tool) && !submitted?.replicateTask && !submitted?.workerJob && !submitted?.modelTask && (stopped || (error instanceof DOMException && error.name === "AbortError"))) {
                useVideoWorkbenchStore.setState({ records: store().records.filter((r) => r.id !== id) });
                patch({ activeRecord: tool === "upscale" ? d.activeRecord : undefined });
                throw new DOMException("已取消本次制作，未创建收费任务", "AbortError");
            }
            store().patchRecord(id, {
                status:
                    stopped || (submitted?.replicateTask && submitted.status !== "failed" && !isVideoTaskFailed(error)) || (digital && submitted?.workerJob && submitted.status !== "failed") || (["store-explore", "viral-recreate", "digital-human", "photo-talk", "lipsync"].includes(tool) && submitted?.modelTask && !isVideoTaskFailed(error))
                        ? "interrupted"
                        : "failed",
                error: detail,
            });
            throw new Error(detail);
        }
    };
    const guard = async (action: (signal: AbortSignal) => Promise<void>) => {
        if (store().busyTools[tool] || controllers.has(tool)) return;
        const controller = new AbortController();
        controllers.set(tool, controller);
        store().setBusy(tool, true);
        try {
            await action(controller.signal);
            message.success("处理完成，结果已保存到本地工作台");
        } catch (error) {
            if (["content-replace", "store-explore", "viral-recreate", "upscale", "digital-human", "photo-talk", "lipsync"].includes(tool) && error instanceof DOMException && error.name === "AbortError") message.info(error.message);
            else message.error(publicServiceText(error instanceof Error ? error.message : "处理失败"));
        } finally {
            controllers.delete(tool);
            store().setBusy(tool, false);
        }
    };
    const run = (stage: string) =>
        guard(async (signal) => {
            if (digital && store().records.some((r) => r.tool === tool && ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask))) throw new Error("已有任务，请先恢复查询核对结果，避免重复提交");
            if (tool === "upscale") {
                if (store().records.some((r) => r.tool === tool && ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob))) throw new Error("已有高清任务，请先恢复查询核对结果，避免重复提交");
                if (stage === "upscale") {
                    const error = upscaleError(upscaleInput(read(tool)));
                    if (error) throw new Error(error);
                }
            }
            if (tool === "subtitle-remove" && stage === "subtitle-remove") {
                const current = read(tool);
                required(current.media.find((m) => m.role === "reference" && m.kind === "video"), "请先上传原视频");
                if (current.subtitleMode === "manual" && !current.regions.length) throw new Error("手动标记至少需要一个字幕区域");
                if (current.route === "replicate") {
                    subtitleRemoveRequest(current);
                } else {
                    const capabilities = await getWorkerCapabilities(store().worker);
                    const repair = capabilities.find((item) => item.name === "subtitle-remove");
                    if (!repair?.available) throw new Error(repair?.reason || "字幕修复引擎未配置");
                    if (current.subtitleMode === "auto" && !capabilities.find((item) => item.name === "ocr")?.available) throw new Error("自动标记需要启用智能识别服务；也可以切换到手动标记");
                }
            }
            if (tool === "viral-recreate" && stage === "video") {
                const error = viralVideoError(read(tool), viralVideoConfig(read(tool), config));
                if (error) throw new Error(error);
                if (store().records.some((r) => r.tool === tool && r.stage === "video" && ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask))) throw new Error("已有视频任务，请恢复查询原任务，避免重复付费");
            }
            if (tool === "viral-recreate" && stage === "product-analyze" && !read(tool).media.some((m) => m.role === "product" && m.kind === "image")) throw new Error("请先上传新商品图片");
            if (tool === "store-explore" && stage === "video") {
                const error = storeVideoError(read(tool), storeVideoConfig(read(tool), config));
                if (error) throw new Error(error);
                if (store().records.some((r) => r.tool === tool && r.stage === "video" && ["running", "interrupted"].includes(r.status) && (r.modelTask || r.replicateTask))) throw new Error("已有视频任务，请恢复查询原任务，避免重复付费");
            }
            if (tool === "content-replace" && stage === "video" && read(tool).route === "replicate") replacementRequest(read(tool));
            if (tool === "viral-recreate" && stage === "analyze" && !viralSource(read(tool))) throw new Error("请先上传参考视频，或手动填写参考结构");
            if (stage === "analyze" && read(tool).media.some((m) => m.role === "reference" && m.kind === "video") && (!read(tool).frames.length || (tool === "viral-recreate" && read(tool).viralFrameSource !== viralSource(read(tool)))))
                await perform("frames", signal);
            await perform(stage, signal);
        });
    const automatic = () =>
        guard(async (signal) => {
            const d = read(tool);
            if (tool !== "digital-human") throw new Error("此自动流程仅用于数字人");
            if (store().records.some((r) => r.tool === tool && ["running", "interrupted"].includes(r.status) && (r.replicateTask || r.workerJob || r.modelTask))) throw new Error("已有任务，请先恢复查询核对结果，避免重复提交");
            if (!d.video) {
                required(
                    d.media.find((m) => m.role === "avatar" && m.kind === (d.digitalHumanMode === "video" ? "video" : "image")),
                    d.digitalHumanMode === "video" ? "上传正面人物视频" : "上传人物照片",
                );
                if (!d.speech && !d.script.trim() && !d.narration.trim()) {
                    const error = digitalHumanScriptError(d);
                    if (error) throw new Error(error);
                    await perform("script", signal);
                }
                if (!read(tool).speech) await perform("speech", signal);
                await perform("video", signal);
            }
            if (read(tool).cutSilence && !read(tool).edited) await perform("cut", signal);
            if (!read(tool).title && !read(tool).tags && (read(tool).narration.trim() || read(tool).script.trim() || read(tool).instructions.trim())) await perform("metadata", signal);
            if (read(tool).coverMode === "image" && !read(tool).title.trim()) throw new Error("图片模型封面需要标题，请先填写标题再继续");
            if (read(tool).addSubtitles && !read(tool).subtitles.length) await perform("subtitles", signal);
            if (!read(tool).final) await perform("compose", signal);
            if (!read(tool).cover) await perform("cover", signal);
        });
    const resume = (record: VideoRecord) =>
        guard(async (signal) => {
            const worker = { ...store().worker };
            if (record.workerJob && resolveWorkerUrl({ ...worker, url: record.workerJob.url }) !== resolveWorkerUrl(worker)) throw new Error("该任务属于另一处理服务，请先切换到记录中的服务地址；不会向旧地址发送当前令牌");
            store().patchRecord(record.id, { status: "running", error: undefined });
            try {
                if (digital && record.digitalHumanInput) {
                    const { channelMode, baseUrl: _url, audioModel: _audio, textModel: _text, ...input } = record.digitalHumanInput;
                    if (!record.replicateTask && channelMode !== config.channelMode) throw new Error("请切换回任务原渠道后恢复查询");
                    const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    const outputs: Partial<VideoDraft> = {};
                    for (const key of ["speech", "voicePreview", "video", "edited", "final"] as const) outputs[key] = input[key] ? await restoreWorkbenchFile(input[key]!) : null;
                    signal.throwIfAborted();
                    patch({ ...input, ...outputs, media, cover: null, activeRecord: record.id });
                } else if (tool === "upscale" && record.upscaleInput) {
                    const media = await Promise.all(record.upscaleInput.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    signal.throwIfAborted();
                    patch({ ...record.upscaleInput, media, activeRecord: record.id });
                } else if (tool === "content-replace" && record.replacementInput) {
                    const media = await Promise.all(record.replacementInput.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    signal.throwIfAborted();
                    patch({ ...clearAfter("video"), video: null, ...record.replacementInput, media, activeRecord: record.id });
                } else if (tool === "viral-recreate" && record.viralInput) {
                    if (record.viralInput.channelMode !== config.channelMode) throw new Error("请切换回该任务原来的平台 / 自定义渠道后恢复查询");
                    if (config.channelMode === "local" && record.viralInput.baseUrl !== resolveModelRequestConfig(config, record.viralInput.viralSettings?.videoModel || record.modelTask?.model || "").baseUrl)
                        throw new Error("当前渠道地址与原任务不同，请恢复原渠道设置后查询");
                    const { channelMode: _mode, baseUrl: _url, ...input } = record.viralInput;
                    const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    const frames = await Promise.all(input.frames.map(restoreWorkbenchFile));
                    signal.throwIfAborted();
                    patch({ ...input, media, frames, activeRecord: record.id, video: null, viralAnalysisSuggestion: "", viralProductSuggestion: "", viralScriptSuggestion: "" });
                } else if (tool === "store-explore" && record.storeExploreInput) {
                    if (record.storeExploreInput.channelMode !== config.channelMode) throw new Error("请切换回该任务原来的平台 / 自定义渠道后恢复查询");
                    if (config.channelMode === "local" && record.storeExploreInput.baseUrl !== resolveModelRequestConfig(config, record.storeExploreInput.storeSettings?.videoModel || record.modelTask?.model || "").baseUrl)
                        throw new Error("当前自定义渠道地址与原任务不同，请恢复原渠道设置后查询");
                    const { channelMode: _mode, baseUrl: _url, ...input } = record.storeExploreInput;
                    const media = await Promise.all(input.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    signal.throwIfAborted();
                    patch({ ...input, media, activeRecord: record.id, video: null, storeAnalysisSuggestion: "", storeScriptSuggestion: "", storeAnalysisStale: false, storeScriptStale: false });
                } else if (tool === "subtitle-remove" && record.subtitleRemoveInput) {
                    const media = await Promise.all(record.subtitleRemoveInput.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
                    signal.throwIfAborted();
                    patch({ ...clearAfter(record.stage), ...record.subtitleRemoveInput, media, activeRecord: record.id, video: null, final: null });
                } else patch({ activeRecord: record.id });
                let value: Partial<VideoDraft>;
                if (record.replicateTask)
                    value = await cloudResult(
                        record.stage,
                        await waitForReplicateTask(record.replicateTask.id, signal, (job) =>
                            store().patchRecord(record.id, { step: publicServiceText(job.error || job.status), ...(job.status === "failed" || job.status === "cancelled" ? { status: "failed" as const } : {}) }),
                        ),
                    );
                else if (record.workerJob) value = await applyWorkerResult(record.stage, await waitForWorkerJob(worker, record.workerJob.id, signal, (job) => store().patchRecord(record.id, { step: job.step, ...(digital && ["failed", "cancelled"].includes(job.status) ? { status: "failed" as const } : {}) })), worker);
                else if (record.modelTask)
                    value = {
                        video: await storeGeneratedVideo(
                            await waitForVideoGenerationTask(tool === "store-explore" ? storeVideoConfig(read(tool), config) : tool === "viral-recreate" ? viralVideoConfig(read(tool), config) : config, record.modelTask, { signal }),
                        ),
                    };
                else throw new Error("该任务没有可恢复的服务端任务编号，请重试该步骤");
                signal.throwIfAborted();
                if (tool === "upscale" && record.upscaleInput) Object.assign(value, { upscaleOutputInput: upscaleInput(read(tool)), upscaleOutputStale: false });
                const current = read(tool);
                const mentions =
                    tool === "viral-recreate" && value.frames
                        ? {
                              instructions: remapMaterialMentions(current.instructions, viralMaterialLabels(current), viralMaterialLabels({ ...current, ...value })),
                              script: remapMaterialMentions(current.script, viralMaterialLabels(current), viralMaterialLabels({ ...current, ...value })),
                          }
                        : {};
                patch({ ...clearAfter(record.stage), ...value, ...mentions });
                const result = value.video ?? value.final ?? value.edited ?? value.speech ?? value.cover ?? undefined;
                store().patchRecord(record.id, { status: "completed", draftPatch: value, result, step: "已完成" });
            } catch (error) {
                store().patchRecord(record.id, {
                    status:
                        signal.aborted ||
                        (record.replicateTask && store().records.find((r) => r.id === record.id)?.status !== "failed" && !isVideoTaskFailed(error)) ||
                        (digital && record.workerJob && store().records.find((r) => r.id === record.id)?.status !== "failed") ||
                        (["store-explore", "viral-recreate", "digital-human", "photo-talk", "lipsync"].includes(tool) && record.modelTask && !isVideoTaskFailed(error))
                            ? "interrupted"
                            : "failed",
                    error: publicServiceText(error instanceof Error ? error.message : "恢复失败"),
                });
                throw error;
            }
        });
    const stop = () => controllers.get(tool)?.abort();
    const cancel = async () => {
        const record = store().records.find((r) => r.id === read(tool).activeRecord);
        if (record?.replicateTask) {
            try {
                const task = await cancelReplicateTask(record.replicateTask.id);
                stop();
                message.info(task.status === "cancelled" ? "云任务已取消" : "取消请求已提交，请恢复查询核对最终状态");
            } catch (error) {
                message.error(publicServiceText(error instanceof Error ? error.message : "取消失败"));
            }
            return;
        }
        if (!record?.workerJob) return;
        try {
            if (resolveWorkerUrl({ ...store().worker, url: record.workerJob.url }) !== resolveWorkerUrl(store().worker)) throw new Error("请先连接该任务所属服务");
            await cancelWorkerJob(store().worker, record.workerJob.id);
            stop();
            message.info("处理服务已收到取消请求");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "取消失败"));
        }
    };
    const download = async (file: UploadedFile) => {
        try {
            saveAs(
                await workbenchMediaBlob({ ...file, kind: file.mimeType.startsWith("image/") ? "image" : undefined }),
                `${read(tool).title || "视频工作台"}.${({ "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "video/webm": "webm", "video/mp4": "mp4" } as Record<string, string>)[file.mimeType] || file.mimeType.split("/")[1] || "bin"}`,
            );
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "下载失败"));
        }
    };
    const saveAsset = async (file?: UploadedFile) => {
        try {
            const d = read(tool);
            const video = await restoreWorkbenchFile(required(file || d.final || d.edited || d.video, "生成视频"));
            useAssetStore.getState().addAsset({ kind: "video", title: d.title || "视频工作台作品", coverUrl: d.cover?.url || "", tags: d.tags.split(/[,，#\s]+/).filter(Boolean), data: { ...video, width: video.width || 0, height: video.height || 0 } });
            if (d.cover) {
                const cover = await restoreWorkbenchFile(d.cover);
                useAssetStore.getState().addAsset({
                    kind: "image",
                    title: `${d.title || "作品"}封面`,
                    coverUrl: cover.url,
                    tags: [],
                    data: { dataUrl: cover.url, storageKey: cover.storageKey, width: cover.width || 0, height: cover.height || 0, bytes: cover.bytes, mimeType: cover.mimeType },
                });
            }
            message.success("已保存到我的素材（本浏览器）");
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "保存失败"));
        }
    };
    const toCanvas = async (file?: UploadedFile) => {
        try {
            const d = read(tool);
            const video = await restoreWorkbenchFile(required(file || d.final || d.edited || d.video, "生成视频"));
            const id = useCanvasStore.getState().importProject({ title: d.title || "视频工作台作品", nodes: [createCanvasNode(CanvasNodeType.Video, { x: 400, y: 300 }, videoMetadata(video))] });
            navigate(`/canvas/${id}`);
        } catch (error) {
            message.error(publicServiceText(error instanceof Error ? error.message : "加入画布失败"));
        }
    };
    return {
        draft,
        busy,
        hydrated: state.hydrated,
        storageError: state.storageError,
        worker: state.worker,
        records: state.records.filter((r) => r.tool === tool),
        edit,
        patch,
        addFiles,
        removeMedia,
        run,
        quoteReplacement,
        quoteDigitalHuman,
        quoteUpscale,
        quoteStoreVideo,
        quoteViralVideo,
        automatic,
        resume,
        stop,
        cancel,
        download,
        saveAsset,
        toCanvas,
    };
}
