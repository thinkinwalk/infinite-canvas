import { useUserStore } from "@/stores/use-user-store";

export type ReplacementJob = {
    id: string;
    model: string;
    resolution: string;
    seconds: string;
    status: "planning" | "ready" | "running" | "paused" | "completed";
    step: string;
    error?: string;
    credits: number;
    planned: boolean;
    result?: string;
    createdAt: string;
    parts: { start: number; end: number; seconds: number; validated: boolean; submitted: boolean; taskId?: string; credits: number }[] | null;
};

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
export const createReplacementJob = (input: {
    id: string; source: string; image: string; model: string; resolution: string; seconds: string;
    prompt: string; subtitles: boolean; subtitleSize: number; subtitleColor: string;
}) => request<ReplacementJob>("", input);
export const startReplacementJob = (job: ReplacementJob) => request<ReplacementJob>(`/${job.id}/start`, { expectedCredits: job.credits });
export const pauseReplacementJob = (id: string) => request<{ message: string }>(`/${id}/pause`, {});

export const quoteReplacementPart = (id: string, part: number) => request<{ credits: number }>(`/${id}/quote-part`, { part });
export const repriceReplacementJob = (id: string) => request<ReplacementJob>(`/${id}/reprice`, {});
export const retryReplacementPart = (job: ReplacementJob, part: number, expectedCredits: number) => request<ReplacementJob>(`/${job.id}/retry`, { part, expectedCredits });
