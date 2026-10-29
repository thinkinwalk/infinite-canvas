import { afterEach, expect, mock, test } from "bun:test";
import { create } from "zustand";
import type { AiConfig } from "../src/stores/use-config-store";
import type { GenerationLog } from "../src/stores/use-image-workbench-store";

const saved = new Map<string, GenerationLog>();
let failRead = false,
    failWrite = false,
    failImageSave = false;
let removeWait: Promise<void> | undefined;
const user = create<{ token: string }>(() => ({ token: "account-a" }));
const agentUpdates: unknown[] = [];
const calls: Array<{
    config: AiConfig;
    prompt: string;
    references: unknown[];
    resolve: (images: Array<{ id: string; dataUrl: string }>) => void;
    reject: (error: Error) => void;
}> = [];
const request = (config: AiConfig, prompt: string, references: unknown[], options?: { signal?: AbortSignal }) =>
    new Promise<Array<{ id: string; dataUrl: string }>>((resolve, reject) => {
        calls.push({ config, prompt, references, resolve, reject });
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
mock.module("localforage", () => ({
    default: {
        createInstance: () => ({
            iterate: async (visit: (log: GenerationLog) => void) => {
                if (failRead) throw new Error("read");
                saved.forEach(visit);
            },
            setItem: async (id: string, log: GenerationLog) => {
                if (failWrite) throw new Error("quota");
                saved.set(id, structuredClone(log));
            },
            removeItem: async (id: string) => {
                await removeWait;
                saved.delete(id);
            },
        }),
    },
}));
mock.module("../src/i18n", () => ({ default: { t: (key: string) => key, resolvedLanguage: "en-US" } }));
mock.module("../src/stores/use-config-store", () => ({ modelOptionLabel: (_config: AiConfig, model: string) => model }));
mock.module("../src/stores/use-user-store", () => ({ useUserStore: user }));
mock.module("../src/stores/use-workbench-agent-store", () => ({ useWorkbenchAgentStore: { getState: () => ({ updateTask: (...args: unknown[]) => agentUpdates.push(args) }) } }));
mock.module("../src/services/api/image", () => ({
    requestGeneration: (config: AiConfig, prompt: string, options?: { signal?: AbortSignal }) => request(config, prompt, [], options),
    requestEdit: request,
}));
mock.module("../src/services/image-storage", () => ({
    uploadImage: async (url: string) => {
        if (failImageSave) throw new Error("image quota");
        return { url, storageKey: `key:${url}`, width: 100, height: 200, bytes: 1024, mimeType: "image/png" };
    },
    resolveImageUrl: async (_key: string, fallback: string) => fallback || "blob:restored",
    ensureImagePreview: async () => undefined,
    deleteStoredImages: async () => undefined,
    collectImageStorageKeys: () => new Set<string>(),
}));
const { useImageWorkbenchStore: store, IMAGE_WORKBENCH_CONCURRENCY } = await import("../src/stores/use-image-workbench-store");
const config = () =>
    ({
        model: "original-model",
        imageModel: "original-model",
        channelMode: "local",
        count: "1",
        size: "1024x1024",
        quality: "high",
        background: "transparent",
        systemPrompt: "original system prompt",
        apiKey: "private-key",
        channels: [{ id: "custom", apiKey: "private-channel-key", models: [] }],
    }) as unknown as AiConfig;
const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Condition did not become true");
};
const complete = (index: number) => calls[index].resolve([{ id: `image-${index}`, dataUrl: `blob:image-${index}` }]);
const idle = () => store.getState().logs.every((log) => log.status !== "queued" && log.status !== "running");
afterEach(async () => {
    failWrite = false;
    failImageSave = false;
    removeWait = undefined;
    for (let i = 0; i < calls.length; i++) complete(i);
    await waitFor(idle);
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls.length = 0;
    agentUpdates.length = 0;
    saved.clear();
    failRead = false;
    store.setState({ logs: [], loaded: false, loadError: "", storageError: "", activeLogId: null, prompt: "", references: [], templateInput: undefined });
    user.setState({ token: "account-a" });
});

test("different batches share three image slots and retain their results when completion is reversed", async () => {
    const original = config();
    const references = [{ id: "ref", name: "original", type: "image/png", dataUrl: "data:image/png;base64,AA" }];
    const first = store.getState().enqueue(original, "first", references, 2);
    original.background = "changed";
    original.channels[0].apiKey = "changed-key";
    references[0].name = "changed";
    const second = store.getState().enqueue(config(), "second", [], 2);
    await waitFor(() => calls.length === IMAGE_WORKBENCH_CONCURRENCY);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ prompt: "first", references: [{ name: "original" }], config: { background: "transparent", channels: [{ apiKey: "private-channel-key" }] } });
    expect(
        store
            .getState()
            .logs.find((log) => log.id === second)
            ?.results?.map((item) => item.status),
    ).toEqual(["pending", "queued"]);
    store.getState().setPrompt("unfinished next draft");
    store.getState().selectLog(first);
    complete(2);
    await waitFor(() => calls.length === 4);
    complete(3);
    complete(1);
    complete(0);
    await waitFor(idle);
    expect(store.getState().activeLogId).toBe(first);
    expect(store.getState().prompt).toBe("unfinished next draft");
    expect(
        store
            .getState()
            .logs.find((log) => log.id === first)
            ?.images.map((image) => image.id),
    ).toEqual(["image-0", "image-1"]);
    expect(
        store
            .getState()
            .logs.find((log) => log.id === second)
            ?.images.map((image) => image.id),
    ).toEqual(["image-2", "image-3"]);
    await waitFor(() => saved.get(first)?.status === "success");
    expect(JSON.stringify(saved.get(first))).not.toContain("private-key");
    expect(JSON.stringify(saved.get(first))).not.toContain("private-channel-key");
});

test("one failed image leaves other images intact; retry keeps its snapshot and rejects a duplicate retry", async () => {
    const id = store.getState().enqueue(config(), "original prompt", [], 2, "agent-id");
    await waitFor(() => calls.length === 2);
    calls[0].reject(new Error("provider rejected"));
    complete(1);
    await waitFor(idle);
    expect(store.getState().logs[0]).toMatchObject({ status: "partial", successCount: 1, failCount: 1 });
    const resultId = store.getState().logs[0].results![0].id;
    store.getState().setPrompt("different draft");
    expect(store.getState().retry(id, resultId)).toBe(true);
    expect(store.getState().retry(id, resultId)).toBe(false);
    await waitFor(() => calls.length === 3);
    expect(calls[2]).toMatchObject({ prompt: "original prompt", config: { background: "transparent", systemPrompt: "original system prompt" } });
    complete(2);
    await waitFor(idle);
    expect(store.getState().logs[0]).toMatchObject({ status: "success", successCount: 2, failCount: 0 });
    expect(agentUpdates.at(-1)).toEqual(["agent-id", expect.objectContaining({ status: "succeeded", successCount: 2, failCount: 0 })]);
});

test("new drafts and deletion cannot remove active jobs", async () => {
    const id = store.getState().enqueue(config(), "keep running", [], 1);
    await waitFor(() => calls.length === 1);
    store.getState().newDraft();
    await store.getState().removeLogs([id]);
    expect(store.getState().activeLogId).toBeNull();
    expect(store.getState().logs).toHaveLength(1);
    complete(0);
    await waitFor(idle);
    await store.getState().removeLogs([id]);
    expect(store.getState().logs).toHaveLength(0);
    expect(saved.has(id)).toBe(false);
});

test("failed initial persistence does not submit a paid request", async () => {
    failWrite = true;
    store.getState().enqueue(config(), "must not be sent", [], 1);
    await waitFor(idle);
    expect(calls).toHaveLength(0);
    expect(store.getState().logs[0].results![0].error).toBe("imageWorkbench.saveBeforeRunFailed");
    expect(store.getState().storageError).toBe("imageWorkbench.saveFailed");
});

test("deletion prevents a concurrent retry from submitting a new request", async () => {
    const id = store.getState().enqueue(config(), "delete failed task", [], 1);
    await waitFor(() => calls.length === 1);
    calls[0].reject(new Error("provider rejected"));
    await waitFor(idle);
    const resultId = store.getState().logs[0].results![0].id;
    let release!: () => void;
    removeWait = new Promise<void>((resolve) => {
        release = resolve;
    });
    const removal = store.getState().removeLogs([id]);
    expect(store.getState().retry(id, resultId)).toBe(false);
    release();
    await removal;
    expect(store.getState().logs).toHaveLength(0);
    expect(calls).toHaveLength(1);
});

test("image storage failure preserves the upstream result instead of offering another paid generation", async () => {
    const id = store.getState().enqueue(config(), "keep upstream result", [], 1);
    await waitFor(() => calls.length === 1);
    failImageSave = true;
    complete(0);
    await waitFor(idle);
    const log = store.getState().logs[0];
    expect(log).toMatchObject({ status: "success", successCount: 1, images: [{ dataUrl: "blob:image-0" }] });
    expect(store.getState().storageError).toBe("imageWorkbench.saveFailed");
    expect(store.getState().retry(id, log.results![0].id)).toBe(false);
    expect(calls).toHaveLength(1);
});

test("a final history write failure keeps the successful image and never retries generation", async () => {
    store.getState().enqueue(config(), "keep result", [], 1);
    await waitFor(() => calls.length === 1);
    failWrite = true;
    complete(0);
    await waitFor(() => store.getState().storageError !== "");
    expect(store.getState().logs[0]).toMatchObject({ status: "success", successCount: 1 });
    expect(calls).toHaveLength(1);
});

test("reloading restores completed images and marks unfinished slots interrupted without submitting them", async () => {
    const id = store.getState().enqueue(config(), "restore", [], 2);
    await waitFor(() => calls.length === 2);
    complete(0);
    complete(1);
    await waitFor(() => saved.get(id)?.status === "success");
    const log = saved.get(id)!;
    log.status = "running";
    log.results![1] = { id: log.results![1].id, status: "pending" };
    log.images = log.images.slice(0, 1);
    log.successCount = 1;
    const requestCount = calls.length;
    store.setState({ loaded: false, logs: [] });
    await store.getState().loadLogs();
    expect(store.getState().logs[0].status).toBe("interrupted");
    expect(store.getState().logs[0].results!.map((result) => result.status)).toEqual(["success", "interrupted"]);
    expect(store.getState().logs[0].images).toHaveLength(1);
    expect(calls).toHaveLength(requestCount);
    expect(store.getState().retry(id, log.results![1].id)).toBe(false);
});

test("history read failure is visible and retryable without erasing existing history", async () => {
    failRead = true;
    await store.getState().loadLogs();
    expect(store.getState().loaded).toBe(false);
    expect(store.getState().loadError).toBe("imageWorkbench.loadFailed");
    failRead = false;
    await store.getState().loadLogs();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().loadError).toBe("");
});

test("account changes stop active requests and prevent queued requests from using the next account", async () => {
    const remote = { ...config(), channelMode: "remote" as const };
    store.getState().enqueue(remote, "account scoped", [], 4);
    await waitFor(() => calls.length === 3);
    user.setState({ token: "account-b" });
    await waitFor(idle);
    expect(calls).toHaveLength(3);
    expect(store.getState().logs[0].status).toBe("interrupted");
    expect(store.getState().logs[0].results!.every((result) => result.error === "imageWorkbench.sessionChanged")).toBe(true);
});
