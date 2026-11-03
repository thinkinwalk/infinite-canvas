import { configForFeature, modelOptionLabel, resolveEffectiveConfig, resolveModelChannel, resolveModelRequestConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import { flushWorkbenchStorage } from "@/stores/workbench-storage";
import { useUserStore } from "@/stores/use-user-store";
import { isVideoTaskFailed, storeGeneratedVideo, waitForVideoGenerationTask } from "@/services/api/video";
import { publicServiceText, storeReplicateResult, waitForReplicateTask } from "@/services/api/replicate";
import { resolveWorkerUrl, storeWorkerResult, waitForWorkerJob } from "@/services/api/video-worker";
import { storeSubtitleSource } from "./store-explore-plan";
import { emptyVideoDraft, type StoreTaskOrigin, type VideoDraft, type VideoRecord } from "@/types/video-workbench";

const controllers = new Map<string, AbortController>();
const requested = new Set<string>();
const store = () => useVideoWorkbenchStore.getState();

export function storeTaskOrigin(config: AiConfig): StoreTaskOrigin {
    const channel = resolveModelChannel(config, config.videoModel);
    return {
        channelMode: config.channelMode, channelId: channel.id,
        baseUrl: resolveModelRequestConfig(config, config.videoModel).baseUrl,
        model: config.videoModel, modelLabel: modelOptionLabel(config, config.videoModel),
        featureId: config.featureId || config.featureIds?.video,
        userId: useUserStore.getState().user?.id,
    };
}

function taskConfig(record: VideoRecord, config: AiConfig): AiConfig {
    const origin = record.storeOrigin;
    const input = record.storeExploreInput;
    const mode = origin?.channelMode || input?.channelMode || config.channelMode;
    const model = origin?.model || input?.storeSettings?.videoModel || record.modelTask?.model || "";
    let scoped = { ...config, channelMode: mode };
    if (mode === "remote") {
        const session = useUserStore.getState();
        if (!session.token || (origin?.userId && session.user?.id !== origin.userId)) throw new Error("请登录提交此任务的账号后恢复查询");
        const settings = useConfigStore.getState();
        scoped = configForFeature(resolveEffectiveConfig({ ...settings.config, channelMode: "remote" }, settings.publicSettings), origin?.featureId || "store-explore.video", "video");
    } else {
        const channels = useConfigStore.getState().config.channels;
        const channel = origin
            ? channels.find((c) => c.id === origin.channelId && c.baseUrl === origin.baseUrl)
            : channels.find((c) => c.baseUrl === input?.baseUrl && c.models.some((m) => model.includes(m.name)));
        if (!channel?.apiKey) throw new Error("原任务的自定义渠道已移除或地址已变化，请恢复该渠道后查询");
        scoped = { ...scoped, channels: [channel], baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat };
    }
    return { ...scoped, ...input?.storeSettings, model, videoModel: model };
}

export const canResumeStoreTask = (record: VideoRecord) => Boolean(record.modelTask || record.replicateTask || record.workerJob);
export const stopStoreTask = (id: string) => controllers.get(id)?.abort();

export async function queryStoreTask(id: string, action: (signal: AbortSignal) => Promise<Partial<VideoDraft>>, automatic = false) {
    if (requested.has(id)) return;
    requested.add(id);
    const execute = async () => {
        await useVideoWorkbenchStore.persist.rehydrate();
        const record = store().records.find((r) => r.id === id);
        if (!record || record.status === "completed" || record.status === "failed" || (automatic && record.storeQueryState === "paused")) return;
        const controller = new AbortController();
        controllers.set(id, controller);
        store().setStoreQuerying(id, true);
        store().patchRecord(id, { status: "running", storeQueryState: "querying", error: undefined });
        const session = useUserStore.getState().token;
        const unsubscribe = useUserStore.subscribe((state) => { if (state.token !== session) controller.abort(); });
        try {
            const value = await action(controller.signal);
            controller.signal.throwIfAborted();
            store().patchRecord(id, {
                status: "completed", storeQueryState: undefined, storeResultPending: false, error: undefined, draftPatch: value,
                result: value.final || value.video || value.speech || undefined, step: "已完成，等待采用",
            });
            await flushWorkbenchStorage();
            window.dispatchEvent(new CustomEvent("store-task-completed", { detail: { projectId: record.storeProjectId } }));
        } catch (error) {
            const failed = isVideoTaskFailed(error) || store().records.find((r) => r.id === id)?.status === "failed";
            store().patchRecord(id, {
                status: failed ? "failed" : "running",
                storeQueryState: failed ? undefined : controller.signal.aborted ? "paused" : "interrupted",
                error: controller.signal.aborted
                    ? session !== useUserStore.getState().token ? "登录状态已变化，查询已暂停；任务编号已保留" : "已停止本地等待，云端任务可能继续处理，可恢复原任务查询"
                    : publicServiceText(error instanceof Error ? error.message : "查询中断，请恢复查询"),
            });
        } finally {
            unsubscribe();
            controllers.delete(id);
            store().setStoreQuerying(id, false);
        }
    };
    try {
        if (navigator.locks) await navigator.locks.request(`store-video-query:${id}`, () => navigator.locks.request(`store-task-submit:${id}`, execute));
        else await execute();
    } catch (error) {
        store().patchRecord(id, { storeQueryState: "interrupted", error: error instanceof Error ? error.message : "本地记录读取失败，请恢复查询" });
    } finally {
        requested.delete(id);
    }
}

export function resumeStoreTask(record: VideoRecord, config: AiConfig, automatic = false) {
    return queryStoreTask(record.id, async (signal) => {
        const original = { ...emptyVideoDraft("store-explore"), ...record.storeExploreInput };
        if (record.modelTask) {
            const cfg = taskConfig(record, config);
            return {
                video: await storeGeneratedVideo(await waitForVideoGenerationTask(cfg, record.modelTask, {
                    signal,
                    onWaitState: (state) => store().patchRecord(record.id, {
                        ...(state === "retrieving" ? { storeResultPending: true } : {}),
                        storeQueryState: state === "query_interrupted" ? "interrupted" : "querying",
                        step: state === "retrieving" ? "云端已完成，正在取回视频" : state === "query_interrupted" ? "查询暂时中断，正在继续查询" : state === "background" ? "已转后台查询" : "视频模型正在处理",
                    }),
                })),
                storeOutputStale: false,
            };
        }
        if (record.replicateTask) {
            taskConfig(record, config);
            const task = await waitForReplicateTask(record.replicateTask.id, signal, (job) =>
                store().patchRecord(record.id, { step: publicServiceText(job.error || job.status), ...(["failed", "cancelled"].includes(job.status) ? { status: "failed" as const } : {}), replicateBilling: { credits: job.credits, refunded: job.refunded } }));
            const result = await storeReplicateResult(task);
            return record.stage === "speech" ? { speech: result, storeSpeechKey: record.storeExploreInput?.storeSpeechKey, storeFinishStale: true } : { video: result, storeOutputStale: false };
        }
        if (record.workerJob) {
            if (record.storeOrigin?.channelMode === "remote") taskConfig(record, config);
            const worker = { ...store().worker };
            if (resolveWorkerUrl(worker) !== resolveWorkerUrl({ ...worker, url: record.workerJob.url })) throw new Error("请先连接此任务原来的处理服务，再恢复查询");
            const job = await waitForWorkerJob(worker, record.workerJob.id, signal, (job) => store().patchRecord(record.id, { step: job.step, ...(["failed", "cancelled"].includes(job.status) ? { status: "failed" as const } : {}) }));
            if (record.stage === "subtitles") {
                if (!job.result?.segments?.length) throw new Error("没有识别到人声字幕，请检查音轨或手动填写字幕");
                return { subtitles: job.result.segments, storeSubtitleSource: storeSubtitleSource(original), storeFinishStale: true };
            }
            if (!job.result?.file) throw new Error("处理服务未返回输出文件，请恢复查询");
            return { final: await storeWorkerResult(worker, job.result.file), storeFinishStale: false };
        }
        throw new Error("此记录没有可查询的任务编号，请先核对使用日志");
    }, automatic);
}
