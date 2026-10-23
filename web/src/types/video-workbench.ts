import type { UploadedFile } from "@/services/file-storage";
import type { VideoGenerationTask } from "@/services/api/video";
import type { AiConfig } from "@/stores/use-config-store";

export type StoreVideoSettings = Pick<AiConfig, "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoInputMode" | "videoInterpolate">;
export type StoreExploreInput = Pick<VideoDraft, "media" | "storeFacts" | "instructions" | "analysis" | "script" | "storeFirstFrameId" | "storeLastFrameId" | "storeSettings"> & { channelMode: AiConfig["channelMode"]; baseUrl: string };
export type ViralRecreateInput = Pick<
    VideoDraft,
    | "media"
    | "frames"
    | "frameCount"
    | "transcript"
    | "analysis"
    | "instructions"
    | "script"
    | "viralFacts"
    | "viralProductAnalysis"
    | "viralSettings"
    | "viralFirstFrameId"
    | "viralLastFrameId"
    | "viralUseVideo"
    | "viralFrameSource"
    | "viralFrameTimes"
    | "viralTranscriptSource"
    | "viralAnalysisStale"
    | "viralProductStale"
    | "viralScriptStale"
> & { channelMode: AiConfig["channelMode"]; baseUrl: string };
export type DigitalHumanInput = Pick<
    VideoDraft,
    | "media"
    | "instructions"
    | "script"
    | "narration"
    | "digitalBrief"
    | "digitalCopySource"
    | "digitalTranscribeRoute"
    | "digitalMotion"
    | "transcript"
    | "digitalTranscriptSource"
    | "digitalPreviewText"
    | "voicePreview"
    | "speech"
    | "voiceMode"
    | "digitalHumanMode"
    | "promptTranscript"
    | "language"
    | "replicateSpeaker"
    | "voice"
    | "route"
    | "cutSilence"
    | "addSubtitles"
    | "coverMode"
    | "title"
    | "tags"
    | "keywords"
    | "musicVolume"
    | "subtitleSize"
    | "subtitleColor"
    | "highlightColor"
    | "video"
    | "edited"
    | "final"
    | "subtitles"
    | "digitalRevision"
> & { channelMode: AiConfig["channelMode"]; baseUrl: string; audioModel?: string; textModel?: string };

export type VideoTool = "cloud-create" | "content-replace" | "store-explore" | "viral-recreate" | "upscale" | "subtitle-remove" | "digital-human" | "photo-talk" | "lipsync";
export const isTalkingVideoTool = (tool: VideoTool) => ["digital-human", "photo-talk", "lipsync"].includes(tool);
export type MediaRole = "reference" | "learning" | "product" | "model" | "background" | "voice" | "avatar" | "music" | "mask" | "first-frame";
export type VideoImportSource = { platform: string; title: string; author: string; sourceUrl: string; coverUrl?: string; clip?: { extractionId: string; start: number; end: number } };
export type WorkbenchMedia = UploadedFile & { id: string; name: string; kind: "image" | "video" | "audio"; role: MediaRole; source?: VideoImportSource };
export type UpscaleInput = Pick<VideoDraft, "media" | "route" | "replicateTargetResolution" | "replicateFps" | "scale" | "fps">;
export type SubtitleSegment = { start: number; end: number; text: string };
export type SubtitleRegion = { x: number; y: number; width: number; height: number };
export type SubtitleMarkMode = "auto" | "manual";
export type DigitalHumanBrief = {
    type: "persona" | "selling" | "knowledge" | "story";
    industry: string;
    audience: string;
    persona: string;
    product: string;
    sellingPoints: string;
    price: string;
    duration: string;
    style: string;
    callToAction: string;
};
export type DigitalHumanPreset = {
    id: string;
    name: string;
    kind: "avatar" | "voice";
    media: WorkbenchMedia[];
    settings: Pick<VideoDraft, "digitalHumanMode" | "digitalMotion" | "voiceMode" | "promptTranscript" | "language" | "replicateSpeaker" | "voice" | "route" | "subtitleSize" | "subtitleColor" | "highlightColor">;
};
export type SubtitleRemoveInput = {
    media: WorkbenchMedia[];
    subtitleMode: SubtitleMarkMode;
    regions: SubtitleRegion[];
    route: VideoDraft["route"];
    workerUrl: string;
};
export type VideoDraft = {
    media: WorkbenchMedia[];
    instructions: string;
    analysis: string;
    frames: UploadedFile[];
    transcript: string;
    frameCount: number;
    voiceMode: "api" | "clone";
    digitalHumanMode: "photo" | "video";
    digitalBrief: DigitalHumanBrief;
    digitalCopySource: "brief" | "reference" | "manual";
    digitalTranscribeRoute: "replicate" | "worker";
    digitalMotion: string;
    digitalTranscriptSource: string;
    digitalPreviewText: string;
    voicePreview: UploadedFile | null;
    coverMode: "frame" | "image";
    script: string;
    narration: string;
    promptTranscript: string;
    speech: UploadedFile | null;
    video: UploadedFile | null;
    edited: UploadedFile | null;
    final: UploadedFile | null;
    cover: UploadedFile | null;
    subtitles: SubtitleSegment[];
    subtitleMode: SubtitleMarkMode;
    regions: SubtitleRegion[];
    replacement: "person" | "product" | "background";
    /** 人物替换使用的模型：wan 保留动作的整人替换，headswap 只换头部。 */
    replacementModel: "wan" | "headswap";
    /** 旧人物局部替换任务恢复专用；当前草稿固定为 false，不再创建此类任务。 */
    maskedPerson: boolean;
    replacementSeedTime?: number;
    maskedEdit: boolean;
    route: "replicate" | "model" | "worker";
    replicateSpeaker: string;
    replicateResolution: "480p" | "720p";
    replicateTargetResolution: "720p" | "1080p" | "4k";
    replicateFrames: number;
    replicateFps: number;
    title: string;
    tags: string;
    keywords: string;
    voice: string;
    language: string;
    scale: number;
    fps: number | null;
    musicVolume: number;
    subtitleSize: number;
    subtitleColor: string;
    highlightColor: string;
    cutSilence: boolean;
    addSubtitles: boolean;
    /** 内容替换时清理原硬字幕；是否重新生成由 regenerateSubtitles 控制。 */
    replaceSubtitles: boolean;
    regenerateSubtitles: boolean;
    replacementJobId?: string;
    replacementAspectRatio?: string;
    replacementResultKey?: string;
    replacementSource?: UploadedFile;
    activeRecord?: string;
    digitalRevision?: number;
    upscaleOutputInput?: UpscaleInput;
    upscaleOutputStale?: boolean;
    storeFacts?: string;
    storeSettings?: StoreVideoSettings;
    storeFirstFrameId?: string;
    storeLastFrameId?: string;
    storeAnalysisStale?: boolean;
    storeScriptStale?: boolean;
    storeOutputStale?: boolean;
    storeAnalysisSuggestion?: string;
    storeScriptSuggestion?: string;
    viralFacts?: string;
    viralProductAnalysis?: string;
    viralSettings?: StoreVideoSettings;
    viralFirstFrameId?: string;
    viralLastFrameId?: string;
    viralUseVideo?: boolean;
    viralFrameSource?: string;
    viralFrameTimes?: number[];
    viralTranscriptSource?: string;
    viralAnalysisStale?: boolean;
    viralProductStale?: boolean;
    viralScriptStale?: boolean;
    viralOutputStale?: boolean;
    viralAnalysisSuggestion?: string;
    viralProductSuggestion?: string;
    viralScriptSuggestion?: string;
    viralRevision?: number;
};
export type VideoRecord = {
    id: string;
    tool: VideoTool;
    stage: string;
    status: "running" | "completed" | "failed" | "interrupted";
    createdAt: number;
    error?: string;
    modelTask?: VideoGenerationTask;
    workerJob?: { id: string; url: string };
    replicateTask?: { id: string; operation: string };
    replicateBilling?: { credits: number; refunded: boolean };
    replacementMask?: UploadedFile;
    replacementMaskTask?: { id: string; operation: "track-mask" };
    maskedReplacement?: {
        phase: "mask" | "generate" | "subject" | "composite";
        workerUrl: string;
        mask?: UploadedFile;
        generated?: UploadedFile;
        subjectMask?: UploadedFile;
        maskTask?: { id: string; operation: "track-mask" };
        subjectMaskTask?: { id: string; operation: "track-mask" };
        generationTask?: { id: string; operation: "masked-edit" | "replace-person" };
    };
    result?: UploadedFile;
    text?: string;
    step?: string;
    draftPatch?: Partial<VideoDraft>;
    replacementInput?: Pick<VideoDraft, "replacement" | "replacementModel" | "maskedPerson" | "replacementSeedTime" | "route" | "instructions" | "maskedEdit" | "replicateResolution" | "regions" | "media" | "replaceSubtitles" | "regenerateSubtitles" | "subtitleSize" | "subtitleColor">;
    replacementPipeline?: {
        subtitleMethod?: "audio-after-generation" | "cloud-joint";
        regenerateSubtitles?: boolean;
        phase: "prepare" | "mask" | "generate" | "finish";
        workerUrl: string;
        model: string;
        channelMode: AiConfig["channelMode"];
        baseUrl: string;
        generation: Pick<AiConfig, "size" | "vquality" | "videoSeconds" | "videoInputMode" | "videoGenerateAudio">;
        prepared?: UploadedFile;
        mask?: UploadedFile;
        generated?: UploadedFile;
        composited?: UploadedFile;
        maskTask?: { id: string; operation: "track-mask" };
        generationTask?: { id: string; operation: "masked-edit" };
        subtitles?: SubtitleSegment[];
    };
    storeExploreInput?: StoreExploreInput;
    viralInput?: ViralRecreateInput;
    digitalHumanInput?: DigitalHumanInput;
    digitalHumanQuote?: import("@/services/api/replicate").ReplicateQuote;
    upscaleInput?: UpscaleInput;
    subtitleRemoveInput?: SubtitleRemoveInput;
};
export type WorkerConfig = { url: string; token: string };
export type WorkerCapabilities = { name: string; available: boolean; reason?: string };
export type WorkerJob = {
    id: string;
    status: "running" | "completed" | "failed" | "cancelled";
    step: string;
    error?: string;
    result?: { file?: string; files?: string[]; segments?: SubtitleSegment[]; text?: string; metadata?: Record<string, unknown> };
};

export const emptyVideoDraft = (tool?: VideoTool): VideoDraft => ({
    media: [],
    instructions: "",
    analysis: "",
    frames: [],
    transcript: "",
    frameCount: 6,
    voiceMode: "api",
    digitalHumanMode: tool === "lipsync" ? "video" : "photo",
    digitalBrief: { type: "selling", industry: "", audience: "", persona: "", product: "", sellingPoints: "", price: "", duration: "", style: "", callToAction: "" },
    digitalCopySource: "brief",
    digitalTranscribeRoute: "replicate",
    digitalMotion: "",
    digitalTranscriptSource: "",
    digitalPreviewText: "你好，欢迎来到我的频道。今天和你分享一个实用的小知识。",
    voicePreview: null,
    coverMode: "frame",
    script: "",
    narration: "",
    promptTranscript: "",
    speech: null,
    video: null,
    edited: null,
    final: null,
    cover: null,
    subtitles: [],
    subtitleMode: "auto",
    regions: [],
    replacement: "person",
    replacementModel: "wan",
    maskedPerson: false,
    maskedEdit: false,
    route: "replicate",
    replicateSpeaker: "Serena",
    replicateResolution: "480p",
    replicateTargetResolution: "1080p",
    replicateFrames: 81,
    replicateFps: 30,
    title: "",
    tags: "",
    keywords: "",
    voice: "alloy",
    language: "中文",
    scale: 2,
    fps: null,
    musicVolume: 0.3,
    subtitleSize: 42,
    subtitleColor: "#ffffff",
    highlightColor: "#ffe066",
    cutSilence: false,
    addSubtitles: true,
    // Subtitle repair is opt-in; the CPU server can compose audio and captions but does not run OCR/inpainting.
    replaceSubtitles: false,
    regenerateSubtitles: false,
});
