import { useUserStore } from "@/stores/use-user-store";
import { isRetiredHeadSwapModel, RETIRED_HEAD_SWAP_MESSAGE } from "@/lib/content-replacement-state";

export type ReplacementJob = {
    id: string;
    model: string;
    modelLabel?: string;
    featureId?: string;
    modelAdapter?: string;
    resolution: string;
    seconds: string;
    aspectRatio?: string;
    requestedAspectRatio?: string;
    sourceSize?: [number, number];
    status: "planning" | "ready" | "preview" | "running" | "paused" | "completed";
    step: string;
    error?: string;
    credits: number;
    planned: boolean;
    selectionMode?: boolean;
    selectedParts?: number[];
    previewRequired: boolean;
    previewReady: boolean;
    previewApproved: boolean;
    previewResult?: string;
    result?: string;
    subtitleOutput?: "editable";
    captionSegments?: ReplacementCaption[];
    captionRevision: number;
    captionStatus?: "recognizing" | "draft" | "rendering" | "completed" | "failed";
    captionError?: string;
    captionResult?: string;
    subtitleSize: number;
    subtitleColor: string;
    subtitleBottom: number;
    subtitleFont: string;
    source: string;
    subtitles: boolean;
    regenerateSubtitles: boolean;
    subtitleMethod?: "audio-after-generation" | "cloud-joint";
    reviewed?: boolean;
    archived?: boolean;
    previousResults?: string[];
    createdAt: string;
    updatedAt?: string;
    parts: { start: number; end: number; inputStart: number; inputEnd: number; seconds: number; referenceSeconds?: number; validated: boolean; submitted: boolean; input?: string; taskId?: string; generated?: string; result?: string; credits: number }[] | null;
};
export type ReplacementCaption = { start: number; end: number; text: string };

export const isRetiredReplacementJob = (job: Pick<ReplacementJob, "model" | "featureId" | "modelAdapter">) =>
    job.featureId === "replace.head" || job.modelAdapter === "cloud:head-swap" || isRetiredHeadSwapModel(job.model);

async function request<T>(path: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请登录后使用后台整片处理");
    const response = await fetch(`/api/v1/replacement-jobs${path}`, {
        method: input === undefined ? "GET" : "POST", signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: input === undefined ? undefined : JSON.stringify(input),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.code !== 0) throw new Error(value?.msg || "后台整片处理尚未部署或请求失败");
    return value.data;
}
export const listReplacementJobs = (signal?: AbortSignal) => request<ReplacementJob[]>("", undefined, signal);
export const createReplacementJob = async (input: {
    id: string; source: string; image: string; model: string; featureId?: string; resolution: string; seconds: string; aspectRatio?: string;
    prompt: string; subtitles: boolean; regenerateSubtitles?: boolean; subtitleSize: number; subtitleColor: string; previewRequired?: boolean;
}) => {
    if (isRetiredReplacementJob(input)) throw new Error(RETIRED_HEAD_SWAP_MESSAGE);
    return request<ReplacementJob>("", input);
};
export const startReplacementJob = async (job: ReplacementJob, approvePreview = false) => {
    if (isRetiredReplacementJob(job)) throw new Error(RETIRED_HEAD_SWAP_MESSAGE);
    return request<ReplacementJob>(`/${job.id}/start`, { expectedCredits: job.credits, ...(approvePreview ? { approvePreview: true, previewResult: job.previewResult } : {}) });
};
export const generateReplacementParts = async (job: ReplacementJob, parts: number[], expectedCredits: number) => {
    if (isRetiredReplacementJob(job) && parts.some((index) => !job.parts?.[index]?.submitted || !job.parts?.[index]?.taskId)) throw new Error(RETIRED_HEAD_SWAP_MESSAGE);
    return request<ReplacementJob>(`/${job.id}/generate-parts`, { parts, expectedCredits });
};
export const pauseReplacementJob = (id: string) => request<{ message: string }>(`/${id}/pause`, {});
export const archiveReplacementJob = (id: string, archived: boolean) => request<ReplacementJob>(`/${id}/${archived ? "archive" : "unarchive"}`, {});

export const quoteReplacementPart = (id: string, part: number) => request<{ credits: number }>(`/${id}/quote-part`, { part });
export const repriceReplacementJob = (id: string) => request<ReplacementJob>(`/${id}/reprice`, {});
export const setReplacementAspectRatio = (id: string, aspectRatio: string) => request<ReplacementJob>(`/${id}/set-aspect-ratio`, { aspectRatio });
export const retryReplacementPart = async (job: ReplacementJob, part: number, expectedCredits: number) => {
    if (isRetiredReplacementJob(job)) throw new Error(RETIRED_HEAD_SWAP_MESSAGE);
    return request<ReplacementJob>(`/${job.id}/retry`, { part, expectedCredits });
};
export const reviewReplacementJob = (id: string) => request<ReplacementJob>(`/${id}/review`, {});
export const saveReplacementCaptions = (id: string, input: { revision: number; segments: ReplacementCaption[]; size: number; color: string; bottom: number; font: string }) => request<ReplacementJob>(`/${id}/save-captions`, input);
export const recognizeReplacementCaptions = (id: string, revision: number) => request<ReplacementJob>(`/${id}/recognize-captions`, { revision });
export const renderReplacementCaptions = (id: string, revision: number) => request<ReplacementJob>(`/${id}/render-captions`, { revision });
