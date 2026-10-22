import { afterEach, expect, test } from "bun:test";
import axios from "axios";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const { createVideoGenerationTask, quoteVideoModel } = await import("../src/services/api/video");
const { defaultConfig, createModelChannel } = await import("../src/stores/use-config-store");
const { useUserStore } = await import("../src/stores/use-user-store");
import type { VideoModelProfile } from "../src/services/api/admin";

const originalPost = axios.post;
const originalToken = useUserStore.getState().token;
afterEach(() => { axios.post = originalPost; useUserStore.setState({ token: originalToken }); });
const profile: VideoModelProfile = { displayName: "Test", description: "Test", interface: "relay", maxImages: 7, maxVideos: 3, maxAudios: 3, resolutions: ["720"], seconds: ["5"], generateAudio: false };
const config = { ...defaultConfig, channels: [createModelChannel({ id: "remote", models: [{ name: "seedance-test", capability: "video" }] })], channelMode: "remote" as const, model: "seedance-test", videoModel: "seedance-test", videoSeconds: "5", vquality: "720", videoModels: { "seedance-test": profile } };
const image = { id: "image", name: "image.png", type: "image/png", dataUrl: "https://example.com/image.png" };
const video = { id: "video", name: "video.mp4", type: "video/mp4", url: "https://example.com/video.mp4" };
const audio = { id: "audio", name: "audio.mp3", type: "audio/mpeg", url: "https://example.com/audio.mp3" };

for (const seconds of ["4", "6", "16", "30"]) test(`Wan30 relay preserves selected ${seconds} seconds and all reference media`, async () => {
    const wan = { ...config, channels: [createModelChannel({ id: "remote", models: [{ name: "wan30-720p", capability: "video" }] })], model: "wan30-720p", videoModel: "wan30-720p", videoSeconds: seconds, videoModels: { "wan30-720p": { ...profile, maxImages: 10, maxVideos: 5, maxAudios: 5, seconds: Array.from({ length: 27 }, (_, i) => String(i + 4)) } } };
    const images = Array.from({ length: 10 }, (_, i) => ({ ...image, id: String(i), dataUrl: `https://example.com/${i}.png` }));
    const videos = Array.from({ length: 5 }, (_, i) => ({ ...video, id: String(i), url: `https://example.com/${i}.mp4`, durationMs: 15000 }));
    const audios = Array.from({ length: 5 }, (_, i) => ({ ...audio, id: String(i), url: `https://example.com/${i}.mp3` }));
    axios.post = (async (_url, body) => {
        expect(body.seconds).toBe(seconds);
        expect(body.resolution).toBe("720p");
        expect([body.image_url, ...body.reference_image_urls]).toEqual(images.map((item) => item.dataUrl));
        expect(body.reference_videos).toEqual(videos.map((item) => item.url));
        expect(body.audio_urls).toEqual(audios.map((item) => item.url));
        return { data: { id: "mock-wan30" } };
    }) as typeof axios.post;
    await createVideoGenerationTask(wan, "按参考素材生成", images, videos, audios);
    await expect(createVideoGenerationTask({ ...wan, videoSeconds: "31" }, "按参考素材生成")).rejects.toThrow("时长");
});

test("Wan30 rejects invalid reference durations before submitting or uploading", async () => {
    const wan = { ...config, channels: [createModelChannel({ id: "remote", models: [{ name: "wan30-720p", capability: "video" }] })], model: "wan30-720p", videoModel: "wan30-720p", videoModels: { "wan30-720p": profile } };
    let requests = 0;
    axios.post = (async () => { requests++; return { data: { id: "mock" } }; }) as typeof axios.post;
    for (const durationMs of [undefined, 0, 999, 15001, Infinity, NaN]) await expect(createVideoGenerationTask(wan, "参考视频", [], [{ ...video, durationMs }])).rejects.toThrow("参考视频");
    expect(requests).toBe(0);
    for (const durationMs of [1000, 15000]) await createVideoGenerationTask(wan, "参考视频", [], [{ ...video, durationMs }]);
    expect(requests).toBe(2);
});

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

for (const channelMode of ["remote", "local"] as const) {
    for (const imageCount of [0, 1, 3]) {
        test(`H3video-768 submits JSON with ${imageCount} optional images in ${channelMode} mode`, async () => {
            const name = "H3video-768";
            const selected = channelMode === "local" ? `h3::${name}` : name;
            const cfg = { ...config, channelMode, channels: [createModelChannel({ id: "h3", baseUrl: "https://example.com/v1", apiKey: "test", models: [{ name, capability: "video" }] })], model: selected, videoModel: selected, vquality: "768", videoSeconds: "10", size: "9:16", videoModels: { [name]: { ...profile, interface: "openai" as const, maxVideos: 0, maxAudios: 0, resolutions: ["480", "720", "1080"], seconds: [], inputModes: ["reference"], firstFrameRequired: true } } };
            const images = Array.from({ length: imageCount }, (_, i) => ({ ...image, id: String(i), dataUrl: `https://example.com/${i}.png` }));
            let requests = 0;
            axios.post = (async (url, body, options) => {
                requests++;
                expect(url).toBe(channelMode === "remote" ? "/api/v1/videos" : "https://example.com/v1/videos");
                expect(body).not.toBeInstanceOf(FormData);
                expect(body.model).toBe(name);
                expect(body.prompt).toContain("测试");
                expect(body.seconds).toBe("10");
                expect(body.resolution).toBe("768p");
                expect(body.aspect_ratio).toBe("9:16");
                expect(body.image_url).toBe(images[0]?.dataUrl);
                expect(body.reference_image_urls).toEqual(imageCount > 1 ? images.slice(1).map((item) => item.dataUrl) : undefined);
                for (const field of ["preset", "resolution_name", "size", "input_reference[]", "image_path"]) expect(body[field]).toBeUndefined();
                expect(options.headers["Content-Type"]).toBe("application/json");
                expect(options.headers["X-Expected-Credits"]).toBe(channelMode === "remote" ? "400" : undefined);
                return { data: { task_id: "mock-h3-768" } };
            }) as typeof axios.post;
            const task = await createVideoGenerationTask(cfg, "测试", images, [], [], { expectedCredits: 400 });
            expect(task.id).toBe("mock-h3-768");
            expect(task.provider).toBe("openai");
            expect(requests).toBe(1);
        });
    }
}

test("H3video-768 local uploaded images go through the authenticated media endpoint before JSON generation", async () => {
    useUserStore.setState({ token: "test-user-token" });
    const name = "H3video-768";
    const cfg = { ...config, channelMode: "local" as const, channels: [createModelChannel({ id: "h3", baseUrl: "https://example.com/v1", apiKey: "test", models: [{ name, capability: "video" }] })], model: `h3::${name}`, videoModel: `h3::${name}`, vquality: "768", videoSeconds: "10", videoModels: { [name]: { ...profile, interface: "openai" as const, maxImages: 7, maxVideos: 0, maxAudios: 0, resolutions: ["768"], seconds: [], inputModes: ["reference"], firstFrameRequired: true } } };
    let generationRequests = 0;
    axios.post = (async (url, body, options) => {
        if (url === "/api/v1/media/references") {
            expect(body).toBeInstanceOf(FormData);
            expect(options.headers.Authorization).toBe("Bearer test-user-token");
            return { data: { code: 0, data: { id: "uploaded-ref", url: "https://studio.example.com/api/media/references/uploaded-ref", mimeType: "image/png", bytes: 68 } } };
        }
        generationRequests++;
        expect(url).toBe("https://example.com/v1/videos");
        expect(body.image_url).toBe("https://studio.example.com/api/media/references/uploaded-ref");
        expect(body.resolution).toBe("768p");
        expect(body).not.toBeInstanceOf(FormData);
        return { data: { task_id: "mock-h3-local-upload" } };
    }) as typeof axios.post;
    await createVideoGenerationTask(cfg, "测试", [{ ...image, dataUrl: "data:image/png;base64,aGVsbG8=" }]);
    expect(generationRequests).toBe(1);
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
