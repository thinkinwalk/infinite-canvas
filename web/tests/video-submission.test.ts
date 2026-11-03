import { afterEach, expect, test } from "bun:test";
import axios from "axios";
import { VideoSubmissionError, videoSubmissionError } from "../src/services/api/video-submission";
import { createVideoGenerationTask, pollVideoGenerationTask, quoteVideoModel } from "../src/services/api/video";
import { configForFeature, defaultConfig, managedEffectiveConfig } from "../src/stores/use-config-store";
import { sparkCineH3Preset } from "../src/lib/video-capabilities";
import { useUserStore } from "../src/stores/use-user-store";
import type { PublicManagedCatalog } from "../src/services/api/model-management";

const catalog: PublicManagedCatalog = { enabled: true, revision: 30, features: [],
    models: [{ id: "model_h3", label: "H3", capability: "video" }],
    bindings: [{ featureId: "store-explore.video", modelId: "model_h3", available: true, default: true, order: 0, operations: ["video"], adapter: "video.sparkcine_h3", credits: 24, video: sparkCineH3Preset() }],
};
const base = configForFeature(managedEffectiveConfig({ ...defaultConfig, channelMode: "remote" }, catalog, { video: "store-explore.video" }), "store-explore.video", "video");
const config = { ...base, videoSeconds: "15", size: "768x1366", vquality: "768", model: base.videoModel };
const originalPost = axios.post, originalGet = axios.get, originalUser = useUserStore.getState();
afterEach(() => { axios.post = originalPost; axios.get = originalGet; useUserStore.setState(originalUser); });

test("business rejection, lost response and gateway unknown preserve separate submission outcomes", () => {
    const rejected = videoSubmissionError(Error("unsupported"), "真实拒绝原因", { status: 200, data: { code: 1 }, headers: { "x-video-submission": "rejected", "x-video-stage": "references", "x-request-id": "req-1" } });
    expect(rejected).toBeInstanceOf(VideoSubmissionError);
    expect(rejected.submission).toMatchObject({ outcome: "rejected", stage: "references", requestId: "req-1", code: "1" });
    expect(rejected.message).toBe("真实拒绝原因");
    expect(videoSubmissionError(Error("network"), "network").submission.outcome).toBe("unknown");
    expect(videoSubmissionError(Error("gateway"), "gateway", { status: 200, data: { code: 1 }, headers: { "x-video-submission": "unknown" } }).submission.outcome).toBe("unknown");
    expect(videoSubmissionError(Error("missing ID"), "missing ID", { status: 200, data: {} }).submission.outcome).toBe("unknown");
});

test("H3 preflight and create share exact body and confirmed proof during parallel quotes", async () => {
    useUserStore.setState({ token: "qa-only" });
    const posts: { url: string; body: unknown; headers: unknown }[] = [];
    axios.post = (async (url: string, body: any, options: any) => {
        posts.push({ url, body, headers: options?.headers });
        if (url.endsWith("/quote")) return { data: { code: 0, data: { credits: 90, quoteToken: `quote-${posts.length}` } } };
        if (url.endsWith("/validate")) return { data: { code: 0, data: { validated: true } } };
        return { data: { task_id: "h3-original" } };
    }) as typeof axios.post;
    const first = await quoteVideoModel(config, config.model);
    await quoteVideoModel(config, config.model);
    let started = false;
    const images = ["door.jpg", "inside.webp", "product.webp"].map(name => ({ id: name, name, type: "image/jpeg", dataUrl: `https://cdn.example/${name}` }));
    await createVideoGenerationTask(config, "门店", images, [], [], { preflight: true, expectedCredits: 90, quoteToken: first.quoteToken, onSubmissionStarted: async () => { started = true; expect(posts.at(-1)?.url).toBe("/api/v1/videos/validate"); } });
    expect(started).toBe(true);
    expect(posts[2].body).toEqual(posts[3].body);
    expect(posts[3].body).toMatchObject({ model: "model_h3", seconds: "15", aspect_ratio: "9:16", resolution: "768p" });
    expect(posts[2].headers).toMatchObject({ "X-Model-Quote": first.quoteToken, "X-Expected-Credits": "90", "X-Model-Feature": "store-explore.video" });
    expect(posts[3].headers).toEqual(posts[2].headers);
});

test("preflight rejection cannot start paid submission and keeps diagnostic information", async () => {
    const posts: string[] = [];
    axios.post = (async (url: string) => {
        posts.push(url);
        return { status: 200, data: { code: 1, msg: "H3 参考素材不存在或无权访问" }, headers: { "x-video-stage": "references", "x-request-id": "req-ref", "x-video-submission": "rejected" } };
    }) as typeof axios.post;
    let started = false;
    try {
        await createVideoGenerationTask(config, "门店", [], [], [], { preflight: true, onSubmissionStarted: async () => { started = true; } });
        throw Error("expected rejection");
    } catch (error) {
        expect(error).toBeInstanceOf(VideoSubmissionError);
        expect((error as VideoSubmissionError).submission).toMatchObject({ outcome: "rejected", stage: "references", requestId: "req-ref" });
        expect((error as Error).message).toContain("无权访问");
    }
    expect(started).toBe(false);
    expect(posts).toEqual(["/api/v1/videos/validate"]);
});

test("cloud completion remains retrieving when content is unavailable and downloads by original ID", async () => {
    const gets: string[] = [], states: string[] = [];
    let downloadable = false;
    axios.get = (async (url: string) => {
        gets.push(url);
        if (url.endsWith("/content")) {
            if (!downloadable) throw Error("download temporarily unavailable");
            const bytes = new Uint8Array(2048);
            bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
            return { data: new Blob([bytes], { type: "video/mp4" }), headers: { "content-type": "video/mp4" } };
        }
        return { data: { id: "original", status: "completed" } };
    }) as typeof axios.get;
    const task = { id: "original", model: config.model, provider: "openai" as const };
    expect(await pollVideoGenerationTask(config, task, { onWaitState: s => states.push(s) })).toEqual({ status: "retrieving" });
    downloadable = true;
    expect((await pollVideoGenerationTask(config, task)).status).toBe("completed");
    expect(states).toContain("retrieving");
    expect(gets).toEqual(["/api/v1/videos/original", "/api/v1/videos/original/content", "/api/v1/videos/original", "/api/v1/videos/original/content"]);
});
