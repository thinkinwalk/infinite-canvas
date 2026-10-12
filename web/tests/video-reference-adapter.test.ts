import { afterEach, expect, test } from "bun:test";
import axios from "axios";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const { createVideoGenerationTask, quoteVideoModel } = await import("../src/services/api/video");
const { defaultConfig, createModelChannel } = await import("../src/stores/use-config-store");
import type { VideoModelProfile } from "../src/services/api/admin";

const originalPost = axios.post;
afterEach(() => { axios.post = originalPost; });
const profile: VideoModelProfile = { displayName: "Test", description: "Test", interface: "relay", maxImages: 7, maxVideos: 3, maxAudios: 3, resolutions: ["720"], seconds: ["5"], generateAudio: false };
const config = { ...defaultConfig, channels: [createModelChannel({ id: "remote", models: [{ name: "seedance-test", capability: "video" }] })], channelMode: "remote" as const, model: "seedance-test", videoModel: "seedance-test", videoSeconds: "5", vquality: "720", videoModels: { "seedance-test": profile } };
const image = { id: "image", name: "image.png", type: "image/png", dataUrl: "https://example.com/image.png" };
const video = { id: "video", name: "video.mp4", type: "video/mp4", url: "https://example.com/video.mp4" };
const audio = { id: "audio", name: "audio.mp3", type: "audio/mpeg", url: "https://example.com/audio.mp3" };

test("relay sends real video/audio fields and the confirmed price without creating a real prediction", async () => {
    axios.post = (async (url, body, options) => {
        expect(url).toBe("/api/v1/videos");
        expect(body.reference_videos).toEqual([video.url]);
        expect(body.audio_urls).toEqual([audio.url]);
        expect(body.image_url).toBe(image.dataUrl);
        expect(body.prompt).toContain("视频1");
        expect(options.headers["X-Expected-Credits"]).toBe("180");
        return { data: { id: "mock-only" } };
    }) as typeof axios.post;
    expect((await createVideoGenerationTask(config, "参考 @视频1 的运镜", [image], [video], [audio], { expectedCredits: 180 })).provider).toBe("openai");
});

test("remote Ark config works without exposing the private upstream URL", async () => {
    axios.post = (async (url, body) => {
        expect(url).toBe("/api/v1/videos");
        expect(body.content).toContainEqual({ type: "video_url", video_url: { url: video.url }, role: "reference_video" });
        expect(body.content).toContainEqual({ type: "audio_url", audio_url: { url: audio.url }, role: "reference_audio" });
        return { data: { id: "mock-ark" } };
    }) as typeof axios.post;
    const ark = { ...config, videoModels: { "seedance-test": { ...profile, interface: "ark" as const } } };
    expect((await createVideoGenerationTask(ark, "参考 @视频1", [image], [video], [audio])).provider).toBe("seedance");
});

test("unsupported reference media are rejected before any HTTP request", async () => {
    let requests = 0;
    axios.post = (async () => { requests++; throw new Error("unexpected request"); }) as typeof axios.post;
    const imagesOnly = { ...config, videoModels: { "seedance-test": { ...profile, maxVideos: 0, maxAudios: 0 } } };
    await expect(createVideoGenerationTask(imagesOnly, "商品视频", [image], [video])).rejects.toThrow("不受当前模型支持");
    expect(requests).toBe(0);
});

const h3 = { ...config, channels: [createModelChannel({ id: "remote", models: [{ name: "H3video-2k", capability: "video" }] })], model: "H3video-2k", videoModel: "H3video-2k", vquality: "2K", videoSeconds: "15", size: "9:16", videoModels: { "H3video-2k": { ...profile, interface: "openai" as const, billingMode: "duration_resolution" } } };

for (const videoSeconds of ["5", "10", "15"]) {
    test(`H3 quotes and submits 2K at ${videoSeconds} seconds despite a stale profile`, async () => {
        const calls: string[] = [];
        axios.post = (async (url, body) => {
            calls.push(String(url));
            expect(body.resolution).toBe("2K");
            expect(body.seconds).toBe(videoSeconds);
            if (String(url).endsWith("/quote")) return { data: { credits: 480, calculation: "每次" } };
            expect(body.aspect_ratio).toBe("9:16");
            expect(body.size).toBeUndefined();
            expect(body.ratio).toBeUndefined();
            return { data: { id: "mock-h3" } };
        }) as typeof axios.post;
        const cfg = { ...h3, videoSeconds };
        expect((await quoteVideoModel(cfg, cfg.model)).credits).toBe(480);
        await createVideoGenerationTask(cfg, "测试");
        expect(calls).toEqual(["/api/v1/models/quote", "/api/v1/videos"]);
    });
}

test("H3 preserves all nine reference images and supports the 768p request tier", async () => {
    const images = Array.from({ length: 9 }, (_, i) => ({ ...image, id: String(i), dataUrl: `https://example.com/${i}.png` }));
    axios.post = (async (_url, body) => {
        expect(body.resolution).toBe("768p");
        expect([body.image_url, ...body.reference_image_urls]).toEqual(images.map((item) => item.dataUrl));
        expect(body.reference_videos).toEqual([video.url]);
        expect(body.audio_urls).toEqual([audio.url]);
        return { data: { id: "mock-h3-refs" } };
    }) as typeof axios.post;
    await createVideoGenerationTask({ ...h3, vquality: "768" }, "测试", images, [video], [audio]);
});

test("H3 rejects legacy resolutions, duration and excess references before HTTP", async () => {
    let requests = 0;
    axios.post = (async () => { requests++; throw new Error("unexpected request"); }) as typeof axios.post;
    for (const vquality of ["480", "720", "1080", "4K"]) await expect(createVideoGenerationTask({ ...h3, vquality }, "测试")).rejects.toThrow("分辨率");
    await expect(createVideoGenerationTask({ ...h3, videoSeconds: "7" }, "测试")).rejects.toThrow("时长");
    await expect(createVideoGenerationTask(h3, "测试", Array.from({ length: 10 }, () => image))).rejects.toThrow("数量超限");
    expect(requests).toBe(0);
});
