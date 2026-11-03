import { App } from "antd";
import { useEffect, useRef } from "react";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { canResumeStoreTask, resumeStoreTask } from "./store-task-runtime";

export function StoreTaskRecovery() {
    const config = useEffectiveConfig("store-explore.video");
    const hydrated = useVideoWorkbenchStore((s) => s.hydrated);
    const records = useVideoWorkbenchStore((s) => s.records);
    const token = useUserStore((s) => s.token);
    const user = useUserStore((s) => s.user);
    const attempted = useRef(new Set<string>());
    const initialized = useRef(false);
    const { message } = App.useApp();
    useEffect(() => {
        const sync = () => { void useVideoWorkbenchStore.persist.rehydrate(); };
        const completed = (event: Event) => {
            const project = useVideoWorkbenchStore.getState().storeProjects[(event as CustomEvent).detail.projectId];
            void message.success(`${project?.name || "探店项目"}：任务已完成，可在生成任务中查看并采用`);
        };
        window.addEventListener("video-workbench-synced", sync);
        window.addEventListener("store-task-completed", completed);
        return () => {
            window.removeEventListener("video-workbench-synced", sync);
            window.removeEventListener("store-task-completed", completed);
        };
    }, [message]);
    useEffect(() => {
        if (!hydrated || initialized.current) return;
        initialized.current = true;
        const state = useVideoWorkbenchStore.getState();
        state.ensureStoreProject();
        for (const record of state.records) {
            if (record.tool !== "store-explore" || record.status !== "running" || canResumeStoreTask(record)) continue;
            const interrupted = () => {
                const latest = useVideoWorkbenchStore.getState().records.find((r) => r.id === record.id);
                if (!latest || latest.status !== "running" || canResumeStoreTask(latest)) return;
                useVideoWorkbenchStore.getState().patchRecord(record.id, {
                    status: "interrupted",
                    error: latest.storeSubmissionStarted
                        ? "视频提交状态待核对：尚未取得任务编号，请先核对使用日志或渠道记录，不会自动重新提交"
                        : "上次本地等待已中断，已保留输入和候选；此请求没有可恢复的任务编号，请先核对使用日志",
                });
            };
            if (navigator.locks) void navigator.locks.request(`store-task-submit:${record.id}`, { ifAvailable: true }, (lock) => { if (lock) interrupted(); });
            else interrupted();
        }
    }, [hydrated]);
    useEffect(() => {
        if (!hydrated) return;
        for (const record of records) {
            if (record.tool !== "store-explore" || !["running", "interrupted"].includes(record.status) || !canResumeStoreTask(record) || record.storeQueryState === "paused") continue;
            if ((record.storeOrigin?.channelMode || record.storeExploreInput?.channelMode) === "remote" && (!token || !user || (record.storeOrigin?.userId && record.storeOrigin.userId !== user.id))) continue;
            const key = `${record.id}:${token}:${JSON.stringify(config.channels.map((c) => [c.id, c.baseUrl]))}`;
            if (attempted.current.has(key)) continue;
            attempted.current.add(key);
            void resumeStoreTask(record, config, true).catch(() => {});
        }
    }, [hydrated, records, config, token, user]);
    return null;
}
