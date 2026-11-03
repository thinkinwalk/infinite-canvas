import { expect, test } from "bun:test";
import { emptyVideoDraft, type VideoDraft, type WorkbenchMedia } from "../src/types/video-workbench";
import { storeExploreInput, storeKeyframeKey, storePlanKey } from "../src/pages/video-tool/store-explore-plan";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => memory.get(key) ?? null,
            setItem: (key: string, value: string) => memory.set(key, value),
            removeItem: (key: string) => memory.delete(key),
        },
    });
}
const { defaultConfig } = await import("../src/stores/use-config-store");
const { storePersonVoiceError, storePersonVoicePrompt, storePersonVoices, storeVoiceFileError, storeVoiceFileFormatError, storeVoiceSampleError } = await import("../src/pages/video-tool/store-person-voice");
const { storeVideoError, storeVideoPrompt } = await import("../src/pages/video-tool/store-explore-request");
const { miniMaxH3VideoBody } = await import("../src/lib/minimax-h3");

const h3 = {
    ...defaultConfig,
    videoModel: "default::minimax-h3",
    videoSeconds: "10",
    vquality: "768",
    size: "768x1376",
    models: [...defaultConfig.models, "default::minimax-h3", "default::wan30-1080p-fast"],
    channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "fixture-key", models: [...channel.models, { name: "minimax-h3", capability: "video" as const }, { name: "wan30-1080p-fast", capability: "video" as const }] })),
};
const wan = {
    ...h3,
    channelMode: "remote" as const,
    videoModel: "remote::wan30-1080p-fast",
    videoModels: { "wan30-1080p-fast": { interface: "relay" as const, maxImages: 10, maxVideos: 5, maxAudios: 5, resolutions: ["1080"], seconds: ["10"], generateAudio: true, inputModes: ["reference"] } },
};
const image = (id: string, person: string): WorkbenchMedia => ({ id, name: `${id}.png`, url: `https://example.test/${id}.png`, storageKey: id, bytes: 1, mimeType: "image/png", kind: "image", role: "model", storePerson: person });
const voice = (patch: Partial<WorkbenchMedia> = {}): WorkbenchMedia => ({
    id: "voice-a",
    name: "person.wav",
    url: "https://example.test/person.wav",
    storageKey: "voice:a",
    bytes: 1024,
    mimeType: "audio/wav",
    durationMs: 5000,
    kind: "audio",
    role: "voice",
    storePerson: "小林",
    ...patch,
});
const draft = (): VideoDraft => ({
    ...emptyVideoDraft("store-explore"),
    script: "新台词方案",
    storeAudioMode: "source",
    media: [image("person", "小林"), voice()],
    storeShots: [{ id: "opening", start: 0, end: 10, visual: "小林展示商品", dialogue: "今天看看这份新品。", materialIds: ["person"] }],
});

test("voice uploads accept only WAV/MP3 within the existing 15 MB reference limit", () => {
    for (const name of ["person.wav", "PERSON.WAV", "person.mp3"]) expect(storeVoiceFileError({ name, size: 15 * 1024 * 1024 })).toBe("");
    for (const name of ["person.m4a", "person.mp4", "person.wav.exe"]) expect(storeVoiceFileError({ name, size: 1024 })).toContain("WAV");
    expect(storeVoiceFileError({ name: "person.wav", size: 0 })).toContain("为空");
    expect(storeVoiceFileError({ name: "person.wav", size: 15 * 1024 * 1024 + 1 })).toContain("15 MB");
});

test("voice uploads verify the audio signature and reject mislabeled formats", async () => {
    const wav = new File([new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69])], "person.wav");
    const mp3 = new File([new Uint8Array([73, 68, 51, 4, 0, 0, 0])], "person.mp3");
    expect(await storeVoiceFileFormatError(wav)).toBe("");
    expect(await storeVoiceFileFormatError(mp3)).toBe("");
    expect(await storeVoiceFileFormatError(new File([new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69])], "wrong.mp3"))).toContain("扩展名");
    expect(await storeVoiceFileFormatError(new File(["not audio"], "person.wav"))).toContain("真实 WAV 或 MP3");
});

test("model-specific duration boundaries reject unreadable audio and are rechecked on model changes", () => {
    for (const durationMs of [2000, 15000]) expect(storeVoiceSampleError(voice({ durationMs }), h3)).toBe("");
    for (const durationMs of [undefined, NaN, Infinity]) expect(storeVoiceSampleError(voice({ durationMs }), h3)).toContain("无法读取");
    for (const durationMs of [1999, 15001]) expect(storeVoiceSampleError(voice({ durationMs }), h3)).toContain("2–15");
    expect(storeVoiceSampleError(voice({ durationMs: 1000 }), wan)).toBe("");
    expect(storeVoiceSampleError(voice({ durationMs: 999 }), wan)).toContain("1–15");
    expect(storeVoiceSampleError(voice({ mimeType: "video/mp4" }), h3)).toContain("WAV");
});

test("no voice preserves the existing video path; only voice-role audio becomes a reference", () => {
    const d = draft();
    const without = { ...d, media: [d.media[0], voice({ role: "music" })] };
    expect(storePersonVoices(without)).toEqual([]);
    expect(storePersonVoiceError(without, h3)).toBe("");
    expect(storeVideoError(without, h3)).toBe("");
    expect(storeVideoPrompt(without, h3)).not.toContain("<Audio");
    expect(storePersonVoices(d).map((sample) => sample.id)).toEqual(["voice-a"]);
});

test("unsupported model and first/last-frame modes cannot silently discard the selected voice", () => {
    expect(storeVideoError(draft(), h3)).toBe("");
    const frames = { ...h3, videoModel: "default::minimax-h3-fl2v" };
    expect(storePersonVoiceError(draft(), frames)).toContain("不支持");
    const noAudio = { ...h3, videoModel: defaultConfig.videoModel };
    expect(storePersonVoiceError(draft(), noAudio)).toContain("不支持");
});

test("mute, narration and disabled audio require an explicit resolution", () => {
    for (const storeAudioMode of ["mute", "narration"] as const) expect(storePersonVoiceError({ ...draft(), storeAudioMode }, h3)).toContain("原片声音");
    expect(storePersonVoiceError(draft(), { ...wan, videoGenerateAudio: "false" })).toContain("开启生成声音");
    expect(storePersonVoiceError(draft(), wan)).toBe("");
});

test("voice identity must match current cast after rename, removal or multiple-person selection", () => {
    const d = draft();
    expect(storePersonVoiceError(d, h3)).toBe("");
    expect(storePersonVoiceError({ ...d, media: [image("person", "小陈"), voice()] }, h3)).toContain("对应");
    expect(storePersonVoiceError({ ...d, media: [image("person", "小林"), image("other", "小陈"), voice({ storePerson: "" })] }, h3)).toContain("对应");
    const multi = { ...d, media: [image("person", "小林"), image("other", "小陈"), voice({ storePerson: "小陈" })], storeShots: d.storeShots!.map((shot) => ({ ...shot, materialIds: ["person", "other"] })) };
    expect(storePersonVoiceError(multi, h3)).toBe("");
    expect(storeVideoPrompt(multi, h3)).toContain("<Audio 1> is the voice-timbre reference for <Picture 2>");
    expect(storeVideoPrompt(multi, wan)).toContain("图2的人物口型同步朗读对应镜头台词；音色参考音频1");
});

test("voice requests require dialogue and distinguish new lines from the reference recording", () => {
    const d = draft(),
        before = JSON.stringify(d);
    expect(storePersonVoiceError({ ...d, storeShots: d.storeShots!.map((shot) => ({ ...shot, dialogue: " " })) }, h3)).toContain("台词");
    const prompt = storeVideoPrompt(d, h3);
    expect(prompt).toContain("今天看看这份新品。");
    expect(prompt).toContain("<Audio 1> is the voice-timbre reference for <Picture 1>");
    expect(prompt).toContain("do not reuse the sample's words");
    expect(storePersonVoicePrompt(draft(), wan, [image("person", "小林")])).toContain("图1的人物口型同步朗读对应镜头台词");
    expect(JSON.stringify(d)).toBe(before);
});

test("voice changes expire saved video input comparisons while leaving keyframe comparisons intact", () => {
    const d = draft();
    for (const media of [d.media.slice(0, 1), [d.media[0], voice({ id: "voice-b", storageKey: "voice:b" })], [d.media[0], voice({ storePerson: "小陈" })]]) {
        expect(storePlanKey({ ...d, media })).not.toBe(storePlanKey(d));
        expect(storeKeyframeKey({ ...d, media })).toBe(storeKeyframeKey(d));
    }
    const snapshot = storeExploreInput(d, h3);
    expect(snapshot.media).toBe(d.media);
    expect(storePersonVoices(snapshot)).toEqual([voice()]);
});

test("audio count and aggregate duration are checked before a video task can be created", () => {
    const d = draft();
    expect(storePersonVoiceError({ ...d, media: [...d.media, voice({ id: "voice-b", durationMs: 11000 })] }, h3)).toContain("总时长");
    expect(storePersonVoiceError({ ...d, media: [d.media[0], ...Array.from({ length: 4 }, (_, index) => voice({ id: `voice-${index}`, durationMs: 2000 }))] }, h3)).toContain("不支持");
});

test("existing H3 adapter forwards canonical audio references with mutually exclusive size fields", () => {
    const result = miniMaxH3VideoBody({ model: "minimax-h3", prompt: storeVideoPrompt(draft(), h3), seconds: "10", resolution: "768p", aspect_ratio: "9:16", image_url: "https://example.test/person.png", audio_urls: ["https://example.test/person.wav"] });
    expect(result.reference_audios).toEqual(["https://example.test/person.wav"]);
    expect(result.size).toBe("768x1376");
    expect(result).not.toHaveProperty("aspect_ratio");
    expect(result).not.toHaveProperty("resolution");
});
