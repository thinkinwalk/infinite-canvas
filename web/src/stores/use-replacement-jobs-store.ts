import { create } from "zustand";
import { listReplacementJobs, type ReplacementJob } from "@/services/api/replacement-jobs";
import { useUserStore } from "@/stores/use-user-store";

type ReplacementJobsState = {
    session: string;
    jobs: ReplacementJob[];
    loading: boolean;
    error: string;
    reset: (session: string) => void;
    refresh: (signal?: AbortSignal) => Promise<void>;
    update: (job: ReplacementJob, session: string) => void;
};

let revision = 0;

export const useReplacementJobsStore = create<ReplacementJobsState>((set, get) => ({
    session: "", jobs: [], loading: false, error: "",
    reset: (session) => {
        revision++;
        set({ session, jobs: [], loading: Boolean(session), error: "" });
    },
    refresh: async (signal) => {
        const session = useUserStore.getState().token || "";
        if (!session) return;
        const request = ++revision;
        try {
            const jobs = await listReplacementJobs(signal);
            if (request === revision && !signal?.aborted && get().session === session && useUserStore.getState().token === session)
                set({ jobs: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), loading: false, error: "" });
        } catch (error) {
            if (request === revision && !signal?.aborted && get().session === session && useUserStore.getState().token === session)
                set({ loading: false, error: error instanceof Error ? error.message : "读取任务失败" });
        }
    },
    update: (job, session) => {
        if (get().session !== session || useUserStore.getState().token !== session) return;
        revision++;
        set((state) => ({ loading: false, error: "", jobs: state.jobs.some((item) => item.id === job.id)
            ? state.jobs.map((item) => item.id === job.id ? job : item) : [job, ...state.jobs] }));
    },
}));
