import { afterEach, expect, test } from "bun:test";
import axios from "axios";
import { contentReplacementPrompt } from "../src/pages/video-tool/content-replace-prompt";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const { createVideoGenerationTask, quoteVideoModel } = await import("../src/services/api/video");
const { defaultConfig, createModelChannel, resolveEffectiveConfig } = await import("../src/stores/use-config-store");
const { contentReplacementModels, sparkCineH3Preset, sparkCineVideoSeconds, sparkCineVideoSpecError, videoProfile, videoReferenceDurationError } = await import("../src/lib/video-capabilities");

const originalPost = axios.post;
afterEach(() => { axios.post = originalPost; });
const profile = sparkCineH3Preset();
const names = ["future-video", "h3-video", "wan30-720p", "unsupported-video", "H3video-2k"];
const config = {
    ...defaultConfig, channelMode: "remote" as const, model: "remote::h3-video", videoModel: "remote::h3-video",
    channels: [createModelChannel({ id: "remote", models: names.map((name) => ({ name, capability: "video" as const })) })],
    vquality: "720", videoSeconds: "5", size: "16:9",
    videoModels: Object.fromEntries(names.map((name) => [name, { ...profile, contentReplacement: name !== "unsupported-video" }])),
};

test("replacement models use configured capabilities, accept future names and keep Wan30 first", () => {
    expect(contentReplacementModels(config)).toEqual(["remote::wan30-720p", "remote::future-video", "remote::h3-video", "remote::H3video-2k"]);
    for (const restricted of [{ maxVideos: 0 }, { maxImages: 0 }, { contentReplacement: false }, { interface: "unavailable" as const }, { inputModes: ["first_last"], firstFrameField: "image", lastFrameField: "last" }]) {
        for (const name of ["h3-video", "H3video-2k"]) {
            const next = { ...config, videoModels: { ...config.videoModels, [name]: { ...profile, ...restricted } } };
            expect(contentReplacementModels(next)).not.toContain(`remote::${name}`);
        }
    }
});

test("SparkCine validates reference duration and output combinations independently of other H3 providers", () => {
    for (const durationMs of [undefined, 0, 1999, 15001, NaN, Infinity]) expect(videoReferenceDurationError("h3-video", [{ durationMs }], config)).toContain("参考视频");
    for (const durationMs of [2000, 5000, 15000]) expect(videoReferenceDurationError("h3-video", [{ durationMs }], config)).toBe("");
    expect(videoReferenceDurationError("h3-video", [{ durationMs: 15001 }])).toBe("");
    expect(sparkCineVideoSeconds(profile, "960", "16:9").at(-1)).toBe("15");
    expect(sparkCineVideoSeconds(profile, "768", "21:9").at(-1)).toBe("20");
    expect(sparkCineVideoSeconds(profile, "720", "16:9").at(-1)).toBe("30");
    expect(sparkCineVideoSpecError(profile, "720", "1:1", "5")).toContain("720P");
    expect(sparkCineVideoSpecError(profile, "1080", "16:9", "16")).toContain("时长");
});

test("SparkCine sends nine images, one video and three audios through the platform JSON gateway", async () => {
    const images = Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `${i}.png`, type: "image/png", dataUrl: `https://cdn.example/${i}.png` }));
    const videos = [{ id: "v", name: "v.mp4", type: "video/mp4", url: "https://platform.example/api/media/references/v.mp4", durationMs: 5000 }];
    const audios = Array.from({ length: 3 }, (_, i) => ({ id: String(i), name: `${i}.mp3`, type: "audio/mpeg", url: `https://cdn.example/${i}.mp3` }));
    let requests = 0;
    axios.post = (async (url, body, options) => {
        requests++;
        expect(url).toBe("/api/v1/videos");
        expect(body).not.toBeInstanceOf(FormData);
        expect(body.reference_videos).toEqual([videos[0].url]);
        expect(body.audio_urls).toEqual(audios.map((audio) => audio.url));
        expect([body.image_url, ...body.reference_image_urls]).toEqual(images.map((image) => image.dataUrl));
        expect(body.seconds).toBe("5");
        expect(options.headers["X-Expected-Credits"]).toBe("30");
        return { data: { task_id: "mock-sparkcine-task" } };
    }) as typeof axios.post;
    expect((await createVideoGenerationTask(config, "参考人物和动作", images, videos, audios, { expectedCredits: 30 })).id).toBe("mock-sparkcine-task");
    await expect(createVideoGenerationTask(config, "测试", [...images, images[0]], videos)).rejects.toThrow("数量超限");
    await expect(createVideoGenerationTask(config, "测试", [], [{ ...videos[0], durationMs: 15001 }])).rejects.toThrow("参考视频");
    await expect(quoteVideoModel({ ...config, vquality: "1080", videoSeconds: "16" }, config.videoModel)).rejects.toThrow("时长");
    expect(requests).toBe(1);
});

test("H3 content replacement submits the replacement portrait separately from the source video", async () => {
    const portrait = { id: "new-person", name: "portrait.png", type: "image/png", dataUrl: "https://cdn.example/new-person.png" };
    const source = { id: "source", name: "source.mp4", type: "video/mp4", url: "https://platform.example/api/media/references/source.mp4", durationMs: 5000 };
    const prompt = contentReplacementPrompt("person", "");
    axios.post = (async (url, body) => {
        expect(url).toBe("/api/v1/videos");
        expect(body.model).toBe("h3-video");
        expect(body.input_mode).toBe("reference");
        expect(body.image_url).toBe(portrait.dataUrl);
        expect(body.reference_image_urls).toBeUndefined();
        expect(body.reference_videos).toEqual([source.url]);
        expect(body.prompt).toContain(prompt);
        return { data: { task_id: "replacement-task" } };
    }) as typeof axios.post;
    expect((await createVideoGenerationTask(config, prompt, [portrait], [source])).id).toBe("replacement-task");
});

test("a refreshed public catalog enables H3 on the ordinary model list without changing local channels", () => {
    const local = createModelChannel({ id: "local-test", baseUrl: "https://local.example/v1", apiKey: "test-only", models: [{ name: "local-video", capability: "video" }] });
    const base = { ...defaultConfig, channels: [local] };
    const settings = (enabled: boolean) => ({ modelChannel: {
        models: [{ model: "h3-video", label: "MiniMax H3 Video", protocol: "openai", capabilities: ["video"] }],
        availableModels: ["h3-video"], modelCosts: [], defaultModel: "", defaultImageModel: "", defaultVideoModel: "", defaultTextModel: "", systemPrompt: "", allowCustomChannel: true,
        videoModels: { "h3-video": { ...profile, contentReplacement: enabled } },
    } });
    const before = resolveEffectiveConfig({ ...base, channelMode: "remote" }, settings(false));
    const after = resolveEffectiveConfig({ ...base, channelMode: "remote" }, settings(true));
    expect(contentReplacementModels(before)).not.toContain("remote::h3-video");
    expect(contentReplacementModels(after)).toContain("remote::h3-video");
    expect(videoProfile(after, "remote::h3-video").maxImages).toBe(9);
    expect(base.channels).toEqual([local]);
    expect(resolveEffectiveConfig({ ...base, channelMode: "local" }, settings(true)).channels.some((channel) => channel.id === "local-test")).toBe(true);
});
