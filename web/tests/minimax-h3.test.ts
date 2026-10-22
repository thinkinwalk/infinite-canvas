import { afterEach, expect, test } from "bun:test";
import axios from "axios";
import sizeContract from "../../handler/testdata/minimax-h3-size-contract.json";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const { createVideoGenerationTask, quoteVideoModel } = await import("../src/services/api/video");
const { createModelChannel, defaultConfig, guessCapability, selectableModelsByCapability } = await import("../src/stores/use-config-store");
const { videoModelsForInputMode, videoProfile } = await import("../src/lib/video-capabilities");
const { isMiniMaxH3NamedSize, miniMaxH3VideoBody } = await import("../src/lib/minimax-h3");
const { computeVideoSize, parseVideoResolution } = await import("../src/lib/media-size");

const originalPost = axios.post;
afterEach(() => { axios.post = originalPost; });
const models = ["minimax-h3", "minimax-h3-fl2v"];
const channels = [createModelChannel({ id: "remote", models: models.map((name) => ({ name, capability: "text" as const })) })];
const config = { ...defaultConfig, channels, channelMode: "remote" as const, vquality: "768", videoSeconds: "5", size: "9:16" };
const images = ["first", "last"].map((id) => ({ id, name: `${id}.png`, type: "image/png", dataUrl: `https://example.com/${id}.png` }));
const video = { id: "video", name: "video.mp4", type: "video/mp4", url: "https://example.com/video.mp4" };
const audio = { id: "audio", name: "audio.mp3", type: "audio/mpeg", url: "https://example.com/audio.mp3" };

test("MiniMax H3 names are videos and appear only in their supported creation mode", () => {
    for (const name of models) expect(guessCapability(name)).toBe("video");
    expect(guessCapability("minimax-m2.7")).toBe("text");
    expect(selectableModelsByCapability(config, "video")).toEqual(models.map((name) => `remote::${name}`));
    expect(videoModelsForInputMode(config, "reference")).toEqual(["remote::minimax-h3"]);
    expect(videoModelsForInputMode(config, "first_last")).toEqual(["remote::minimax-h3-fl2v"]);
    const restricted = { ...config, videoModels: { "minimax-h3": { ...videoProfile(config, "minimax-h3"), interface: "unavailable" as const } } };
    expect(videoModelsForInputMode(restricted, "reference")).toEqual([]);
});

for (const channelMode of ["local", "remote"] as const) {
    for (const name of models) {
        test(`${name} submits ordered references in ${channelMode} mode without paid requests`, async () => {
            const selected = channelMode === "remote" ? name : `custom::${name}`;
            const cfg = { ...config, channelMode, model: selected, videoModel: selected, videoInputMode: name.endsWith("fl2v") ? "first_last" : "reference",
                channels: channelMode === "remote" ? channels : [createModelChannel({ id: "custom", baseUrl: "https://example.com/v1", apiKey: "test", models: [{ name, capability: "video" }] })] };
            const frames = name.endsWith("fl2v");
            axios.post = (async (url, body, options) => {
                expect(body).not.toBeInstanceOf(FormData);
                expect(url).toBe(channelMode === "remote" ? "/api/v1/videos" : "https://example.com/v1/videos");
                expect(options.headers["Content-Type"]).toBe("application/json");
                expect(body.model).toBe(name);
                if (channelMode === "local") {
                    expect(body.aspect_ratio).toBeUndefined();
                    expect(body.seconds).toBe(5);
                    expect(body.size).toBe("768x1376");
                    expect(body.images).toEqual(images.map((image) => image.dataUrl));
                    expect(body.input_mode).toBeUndefined();
                    expect(body.resolution).toBeUndefined();
                    expect(body.image_url).toBeUndefined();
                    expect(body.last_frame).toBeUndefined();
                    expect(body.reference_audios).toEqual(frames ? undefined : [audio.url]);
                } else {
                    expect(body.aspect_ratio).toBe("9:16");
                    expect(body.size).toBeUndefined();
                    expect(body.input_mode).toBe(frames ? "first_last" : "reference");
                    expect(body.image_url).toBe(images[0].dataUrl);
                    expect(body.last_frame).toBe(frames ? images[1].dataUrl : undefined);
                    expect(body.reference_image_urls).toEqual(frames ? undefined : [images[1].dataUrl]);
                    expect(body.audio_urls).toEqual(frames ? undefined : [audio.url]);
                    expect(options.headers["X-Expected-Credits"]).toBe("180");
                }
                expect(body.reference_videos).toEqual(frames ? undefined : [video.url]);
                return { data: { id: "mock-minimax" } };
            }) as typeof axios.post;
            expect((await createVideoGenerationTask(cfg, "测试", images, frames ? [] : [video], frames ? [] : [audio], { expectedCredits: 180 })).id).toBe("mock-minimax");
        });
    }
}

test("MiniMax H3 maps all documented size tiers and preserves named tiers in quote requests", async () => {
    for (const [resolution, expected] of [["480p", "480x864"], ["768p", "768x1376"], ["1080p", "1088x1920"], ["2K", "2K"], ["4K", "4K"]]) {
        const body = miniMaxH3VideoBody({ model: "minimax-h3", prompt: "测试", seconds: "5", resolution, aspect_ratio: "9:16" });
        expect(body.size).toBe(expected);
        expect("images" in body).toBe(false);
    }
    expect(parseVideoResolution("4K")).toBe("4K");
    expect(computeVideoSize("4K", "9:16")).toBe("9:16");
    axios.post = (async (_url, body) => {
        expect(body.resolution).toBe("4K");
        return { data: { credits: 180, calculation: "configured price" } };
    }) as typeof axios.post;
    expect((await quoteVideoModel({ ...config, vquality: "4K" }, "minimax-h3")).credits).toBe(180);
});

test("MiniMax H3 follows upstream size exclusivity across models, ratios and duration bounds", () => {
    for (const [ratio, sizes] of Object.entries(sizeContract.sizesByRatio)) {
        for (const [index, resolution] of ["480p", "768p", "1080p", ...sizeContract.namedSizes].entries()) {
            for (const model of models) {
                for (const seconds of [4, 15]) {
                    const body = miniMaxH3VideoBody({ model, prompt: "test", seconds, resolution, aspect_ratio: ratio, pixels: 123, megapixels: 1 });
                    expect(body.size).toBe([...sizes, ...sizeContract.namedSizes][index]);
                    expect(body.seconds).toBe(seconds);
                    for (const field of sizeContract.forbiddenWithSize) expect(field in body).toBe(false);
                }
            }
        }
    }
    expect(isMiniMaxH3NamedSize("minimax-h3", "2K")).toBe(true);
    expect(isMiniMaxH3NamedSize("minimax-h3-fl2v", "4K")).toBe(true);
    expect(isMiniMaxH3NamedSize("minimax-h3", "768")).toBe(false);
    expect(isMiniMaxH3NamedSize("H3video-2k", "2K")).toBe(false);
});

test("MiniMax H3 rejects unsupported modes, reference counts and specs before any HTTP", async () => {
    let requests = 0;
    axios.post = (async () => { requests++; throw new Error("unexpected request"); }) as typeof axios.post;
    const cfg = { ...config, model: "minimax-h3-fl2v", videoModel: "minimax-h3-fl2v", videoInputMode: "first_last" };
    await expect(createVideoGenerationTask(cfg, "测试", images, [video])).rejects.toThrow("不支持视频或音频");
    await expect(createVideoGenerationTask(cfg, "测试", [...images, images[0]])).rejects.toThrow("首帧图片");
    await expect(createVideoGenerationTask({ ...cfg, videoSeconds: "16" }, "测试", images)).rejects.toThrow("时长");
    await expect(createVideoGenerationTask({ ...cfg, vquality: "720" }, "测试", images)).rejects.toThrow("分辨率");
    expect(requests).toBe(0);
});
