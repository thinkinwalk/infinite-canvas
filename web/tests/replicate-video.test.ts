import { afterEach, expect, test } from "bun:test";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    },
});
const { createVideoGenerationTask, pollVideoGenerationTask } = await import("../src/services/api/video");
const { defaultConfig, createModelChannel } = await import("../src/stores/use-config-store");
const { useUserStore } = await import("../src/stores/use-user-store");
const { REPLICATE_VIDEO_MODEL, REPLICATE_TEXT_VIDEO_MODEL, HAILUO_VIDEO_MODEL, publicServiceText } = await import("../src/services/api/replicate");
const { resolveAutomaticVideoModel } = await import("../src/lib/video-capabilities");
const models = [REPLICATE_VIDEO_MODEL, REPLICATE_TEXT_VIDEO_MODEL, HAILUO_VIDEO_MODEL];
const channels = [createModelChannel({ id: "replicate", models: models.map((model) => ({ name: model.replace("replicate::", ""), capability: "video" })) })];
const config = { ...defaultConfig, channels, models, model: REPLICATE_VIDEO_MODEL, videoModel: REPLICATE_VIDEO_MODEL, vquality: "720", videoSeconds: "7.5", videoInterpolate: "true", videoInputMode: "first_last" };
const references = [{ id: "image", name: "test.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }];
const originalFetch = globalThis.fetch;
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });

test("empty person mask failure gives actionable Chinese guidance", () => {
    const text = publicServiceText("ValueError: zero-size array to reduction operation minimum which has no identity");
    expect(text).toContain("人物跟踪失败");
    expect(text).toContain("按镜头拆分视频");
    expect(text).not.toContain("zero-size array");
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    useUserStore.setState({ token: "" });
});

function mockCloud(events: string[]) {
    useUserStore.setState({ token: "local-test" });
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.startsWith("data:")) return originalFetch(url, init);
        if (path === "/api/v1/media/references") {
            events.push("upload");
            return ok({ url: "https://test.example/api/media/references/test.png" });
        }
        if (path === "/api/v1/replicate/quote") {
            events.push("quote");
            const body = JSON.parse(String(init?.body));
            expect(body.operation).toBe("image-to-video");
            expect(body.input).toMatchObject({ image: "https://test.example/api/media/references/test.png", num_frames: 121, resolution: "720p", interpolate_output: true });
            expect(body.input.durationSeconds).toBeUndefined();
            return ok({ operation: "image-to-video", available: true, credits: 510 });
        }
        if (path === "/api/v1/replicate/tasks") {
            events.push("create");
            const body = JSON.parse(String(init?.body));
            expect(body.expectedCredits).toBe(510);
            expect(body.id).toBeTruthy();
            return ok({ id: body.id, status: "running" });
        }
        // Background balance refresh uses this response; no live network is used.
        return ok({ id: "local-test", credits: 0 });
    };
}

test("Wan quote and confirmation precede task persistence and charge request", async () => {
    const events: string[] = [];
    mockCloud(events);
    const task = await createVideoGenerationTask(config, "镜头环绕商品", references, [], [], {
        confirmReplicate: async (quote) => {
            expect(quote.credits).toBe(510);
            events.push("confirm");
        },
        onTaskSubmitted: async (task) => {
            expect(task.provider).toBe("replicate");
            events.push("persist");
        },
    });
    expect(task.provider).toBe("replicate");
    expect(events).toEqual(["upload", "quote", "confirm", "persist", "create"]);
});

test("cancelling fee confirmation creates no task and charges nothing", async () => {
    const events: string[] = [];
    mockCloud(events);
    await expect(
        createVideoGenerationTask(config, "镜头环绕商品", references, [], [], {
            confirmReplicate: async () => {
                throw new DOMException("用户取消", "AbortError");
            },
            onTaskSubmitted: async () => {
                events.push("persist");
            },
        }),
    ).rejects.toThrow("用户取消");
    expect(events).toEqual(["upload", "quote"]);
});

test("Wan sends an optional last_image for the second frame", async () => {
    const events: string[] = [];
    mockCloud(events);
    const second = { ...references[0], id: "last", name: "last.png" };
    await createVideoGenerationTask(config, "test", [references[0], second], [], [], { confirmReplicate: async () => { events.push("confirm"); } });
    expect(events).toEqual(["upload", "upload", "quote", "confirm", "create"]);
});

test("Wan rejects extra references and requires a fee confirmation handler", async () => {
    const events: string[] = [];
    mockCloud(events);
    await expect(createVideoGenerationTask(config, "test", references)).rejects.toThrow("确认平台视频服务费用");
    await expect(createVideoGenerationTask(config, "test", [...references, ...references, ...references], [], [], { confirmReplicate: async () => {} })).rejects.toThrow("1张首帧图片");
    expect(events).toEqual([]);
});

test("persisted Replicate task polls its original provider and downloads its result", async () => {
    useUserStore.setState({ token: "local-test" });
    const requests: string[] = [];
    globalThis.fetch = async (url) => {
        requests.push(String(url));
        return String(url).endsWith("/content") ? new Response("video", { headers: { "Content-Type": "video/mp4" } }) : ok({ id: "saved-task", status: "completed" });
    };
    const result = await pollVideoGenerationTask(defaultConfig, { id: "saved-task", provider: "replicate", model: REPLICATE_VIDEO_MODEL });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(await result.result.blob?.text()).toBe("video");
    expect(requests).toEqual(["/api/v1/replicate/tasks/saved-task", "/api/v1/replicate/tasks/saved-task/content"]);
});

test("failed Replicate task reports failure instead of resubmitting", async () => {
    useUserStore.setState({ token: "local-test" });
    globalThis.fetch = async () => ok({ status: "failed", error: "模型失败，已退款", refunded: false });
    expect(await pollVideoGenerationTask(defaultConfig, { id: "failed", provider: "replicate", model: REPLICATE_VIDEO_MODEL })).toEqual({ status: "failed", error: "模型失败，已退款" });
});

test("a rejected create with no owned task ends polling instead of hanging forever", async () => {
    useUserStore.setState({ token: "local-test" });
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1, msg: "任务不存在或无权访问" }));
    const state = await pollVideoGenerationTask(defaultConfig, { id: "not-created", provider: "replicate", model: REPLICATE_VIDEO_MODEL });
    expect(state.status).toBe("failed");
});

const hailuoConfig = { ...config, model: HAILUO_VIDEO_MODEL, videoModel: HAILUO_VIDEO_MODEL, vquality: "768", videoSeconds: "10" };
function mockHailuo(events: string[], image: boolean) {
    useUserStore.setState({ token: "local-test" });
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        if (path.startsWith("data:")) return originalFetch(url, init);
        if (path === "/api/v1/media/references") {
            events.push("upload");
            return ok({ url: "https://test.example/api/media/references/test.png" });
        }
        if (path === "/api/v1/replicate/quote" || path === "/api/v1/replicate/tasks") {
            const body = JSON.parse(String(init?.body));
            expect(body.operation).toBe("hailuo-video");
            expect(body.input).toMatchObject({ resolution: "768p", duration: 10, prompt_optimizer: true });
            expect(body.input.first_frame_image).toBe(image ? "https://test.example/api/media/references/test.png" : undefined);
            expect(body.input.image).toBeUndefined();
            if (path.endsWith("quote")) {
                events.push("quote");
                return ok({ operation: "hailuo-video", available: true, credits: 1600 });
            }
            expect(body.expectedCredits).toBe(1600);
            events.push("create");
            return ok({ id: body.id, status: "running" });
        }
        return ok({ id: "local-test", credits: 0 });
    };
}

test("Hailuo text-only generation quotes and confirms before creating a task", async () => {
    const events: string[] = [];
    mockHailuo(events, false);
    const task = await createVideoGenerationTask(hailuoConfig, "商品展示", [], [], [], {
        confirmReplicate: async () => { events.push("confirm"); },
        onTaskSubmitted: async () => { events.push("persist"); },
    });
    expect(task.provider).toBe("replicate");
    expect(events).toEqual(["quote", "confirm", "persist", "create"]);
});

test("Hailuo image generation sends the first_frame_image field", async () => {
    const events: string[] = [];
    mockHailuo(events, true);
    await createVideoGenerationTask(hailuoConfig, "商品展示", references, [], [], {
        confirmReplicate: async () => { events.push("confirm"); },
    });
    expect(events).toEqual(["upload", "quote", "confirm", "create"]);
});

test("Hailuo cancellation prevents creation and invalid specifications make no request", async () => {
    const events: string[] = [];
    mockHailuo(events, false);
    await expect(createVideoGenerationTask(hailuoConfig, "test", [], [], [], {
        confirmReplicate: async () => { throw new DOMException("已取消", "AbortError"); },
    })).rejects.toThrow("已取消");
    expect(events).toEqual(["quote"]);
    events.length = 0;
    await expect(createVideoGenerationTask({ ...hailuoConfig, vquality: "1080" }, "test", [], [], [], { confirmReplicate: async () => {} })).rejects.toThrow("1080p 仅支持 6 秒");
    await expect(createVideoGenerationTask(hailuoConfig, "test", [...references, ...references], [], [], { confirmReplicate: async () => {} })).rejects.toThrow("最多支持 1 张");
    expect(events).toEqual([]);
});

for (const count of [0, 1, 2]) {
    test(`automatic routing with ${count} images quotes and submits the same operation`, async () => {
        const selectedModel = resolveAutomaticVideoModel(config, count, 0, 0);
        expect(selectedModel).toBe(count ? REPLICATE_VIDEO_MODEL : REPLICATE_TEXT_VIDEO_MODEL);
        const events: string[] = [];
        const expectedInput = count
            ? { image: "https://test.example/api/media/references/test.png", ...(count === 2 ? { last_image: "https://test.example/api/media/references/test.png" } : {}) }
            : { aspect_ratio: "9:16" };
        let quotedInput: unknown;
        useUserStore.setState({ token: "local-test" });
        globalThis.fetch = async (url, init) => {
            const path = String(url);
            if (path.startsWith("data:")) return originalFetch(url, init);
            if (path === "/api/v1/media/references") { events.push("upload"); return ok({ url: "https://test.example/api/media/references/test.png" }); }
            if (path === "/api/v1/replicate/quote" || path === "/api/v1/replicate/tasks") {
                const body = JSON.parse(String(init?.body));
                expect(body.operation).toBe(count ? "image-to-video" : "text-to-video");
                expect(body.input).toMatchObject({ prompt: "商品展示", resolution: "720p", num_frames: 121, interpolate_output: true, ...expectedInput });
                if (!count) { expect(body.input.image).toBeUndefined(); expect(body.input.last_image).toBeUndefined(); }
                if (path.endsWith("quote")) { quotedInput = body.input; events.push("quote"); return ok({ available: true, credits: 390 }); }
                expect(body.input).toEqual(quotedInput);
                expect(body.expectedCredits).toBe(390);
                events.push("create");
                return ok({ id: body.id, status: "running" });
            }
            return ok({ id: "local-test", credits: 0 });
        };
        const task = await createVideoGenerationTask({ ...config, model: selectedModel, videoModel: selectedModel, size: "9:16" }, "商品展示", Array.from({ length: count }, (_, index) => ({ ...references[0], id: String(index) })), [], [], {
            confirmReplicate: async () => { events.push("confirm"); },
            onTaskSubmitted: async () => { events.push("persist"); },
        });
        expect(task.model).toBe(selectedModel);
        expect(events).toEqual([...Array(count).fill("upload"), "quote", "confirm", "persist", "create"]);
    });
}

test("automatic routing uses enabled compatible services and never drops unsupported references", () => {
    const imageOnly = { ...config, channels: [createModelChannel({ id: "replicate", models: [{ name: "wan-video/wan-2.2-i2v-fast", capability: "video" }] })] };
    expect(resolveAutomaticVideoModel(imageOnly, 0, 0, 0)).toBe("");
    expect(resolveAutomaticVideoModel(config, 3, 0, 0)).toBe("");
    expect(resolveAutomaticVideoModel(config, 0, 1, 0)).toBe("");
    const hailuoOnly = { ...config, channels: [createModelChannel({ id: "replicate", models: [{ name: "minimax/hailuo-2.3", capability: "video" }] })] };
    expect(resolveAutomaticVideoModel(hailuoOnly, 0, 0, 0)).toBe(HAILUO_VIDEO_MODEL);
    expect(resolveAutomaticVideoModel(hailuoOnly, 1, 0, 0)).toBe(HAILUO_VIDEO_MODEL);
    expect(resolveAutomaticVideoModel(hailuoOnly, 2, 0, 0)).toBe("");
    const referenceConfig = {
        ...config, channelMode: "remote" as const,
        channels: [...channels, createModelChannel({ id: "remote", models: [{ name: "seedance-test", capability: "video" }] })],
        videoModels: { "seedance-test": { displayName: "参考服务", description: "测试", interface: "ark" as const, maxImages: 7, maxVideos: 3, maxAudios: 3, resolutions: ["720"], seconds: ["5"], generateAudio: true } },
    };
    expect(resolveAutomaticVideoModel(referenceConfig, 3, 0, 0)).toBe("remote::seedance-test");
    expect(resolveAutomaticVideoModel(referenceConfig, 0, 1, 1)).toBe("remote::seedance-test");
});

test("text-only Wan rejects images and empty scripts before any cloud request", async () => {
    const events: string[] = [];
    mockCloud(events);
    const textConfig = { ...config, model: REPLICATE_TEXT_VIDEO_MODEL, videoModel: REPLICATE_TEXT_VIDEO_MODEL, size: "16:9" };
    await expect(createVideoGenerationTask(textConfig, "test", references, [], [], { confirmReplicate: async () => {} })).rejects.toThrow("不受当前模型支持");
    await expect(createVideoGenerationTask(textConfig, "   ", [], [], [], { confirmReplicate: async () => {} })).rejects.toThrow("视频脚本");
    expect(events).toEqual([]);
});
