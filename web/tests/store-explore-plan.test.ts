import { expect, test } from "bun:test";
import { emptyVideoDraft, type StoreShot, type WorkbenchMedia } from "../src/types/video-workbench";
import { parseStoreShots, renderStoreShots, storeCaptionError, storeExploreInput, storeFreeScriptError, storePlanError, storePlanKey, storeSpeechKey, storeSubtitleSource } from "../src/pages/video-tool/store-explore-plan";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } });
}

const image = (id: string): WorkbenchMedia => ({ id, name: id, url: `https://example.test/${id}.jpg`, storageKey: id, bytes: 1, mimeType: "image/jpeg", kind: "image", role: "reference" });
const shots: StoreShot[] = [
    { id: "opening", start: 0, end: 2, materialIds: ["store"], visual: "门头", dialogue: "欢迎" },
    { id: "product", start: 2, end: 10, materialIds: ["product"], visual: "商品", dialogue: "看看新品" },
];
const draft = () => ({ ...emptyVideoDraft("store-explore"), media: [image("store"), image("product")], storeShots: shots, script: "原稿" });
test("internal shots may be shorter than model minimum; duration must match exactly", () => {
    expect(storePlanError(shots, ["store", "product"], 10)).toBe("");
    expect(storePlanError(shots, ["store", "product"], 6)).toContain("不一致");
    expect(storePlanError([{ ...shots[0], end: NaN }], ["store"], 10)).toContain("时间");
});
test("material IDs survive reordering and deletion is detected rather than rebound", () => {
    const d = draft();
    expect(parseStoreShots(JSON.stringify({ shots }), { ...d, media: [...d.media].reverse() }, 10)).toEqual(shots);
    expect(storePlanError(shots, ["product"], 10)).toContain("已移除");
    expect(() => parseStoreShots(JSON.stringify({ shots }), { ...d, media: [image("product")] }, 10)).toThrow("引用");
});
test("scoped edit preserves every unselected field and rejects extra or missing IDs", () => {
    const d = draft(), next = { ...shots[0], dialogue: "进来看看" };
    const merged = parseStoreShots(JSON.stringify({ shots: [next] }), d, 10, ["opening"]);
    expect(merged[0]).toEqual(next);
    expect(merged[1]).toBe(shots[1]);
    expect(() => parseStoreShots(JSON.stringify({ shots }), d, 10, ["opening"])).toThrow("范围");
    expect(() => parseStoreShots(JSON.stringify({ shots: [{ ...next, id: "other" }] }), d, 10, ["opening"])).toThrow("范围");
});
test("schema errors, duplicate IDs, discontinuities and invalid JSON retain the original draft", () => {
    const d = draft(), before = JSON.stringify(d);
    for (const raw of ["not json", '{"shots":[]}', JSON.stringify({ shots: [{ ...shots[0], start: "0" }] }), JSON.stringify({ shots: [shots[0], { ...shots[1], id: shots[0].id }] }), JSON.stringify({ shots: [shots[0], { ...shots[1], start: 3 }] })]) {
        expect(() => parseStoreShots(raw, d, 10)).toThrow();
        expect(JSON.stringify(d)).toBe(before);
    }
});
test("candidate base changes on manual edits; rendering uses current stable material names", () => {
    const d = draft();
    expect(storePlanKey(d)).not.toBe(storePlanKey({ ...d, script: "人工稿" }));
    expect(renderStoreShots(shots, { media: [...d.media].reverse() })).toContain("素材：store");
    expect(storeSpeechKey({ narration: "你好", voice: "alloy" }, "model-a")).not.toBe(storeSpeechKey({ narration: "你好", voice: "alloy" }, "model-b"));
});
test("captions follow actual chosen audio and edits require confirmation after source change", () => {
    const d = { ...draft(), addSubtitles: true, storeAudioMode: "narration" as const, speech: image("voice-a"), subtitles: [{ start: 0, end: 2, text: "欢迎" }], storeSubtitleSource: "voice-a" };
    expect(storeSubtitleSource(d)).toBe("voice-a");
    expect(storeCaptionError(d, 10)).toBe("");
    expect(storeCaptionError({ ...d, speech: image("voice-b") }, 10)).toContain("来源");
    expect(storeCaptionError({ ...d, subtitles: [{ start: 0, end: 11, text: "太长" }] }, 10)).toContain("无效");
    expect(storeCaptionError({ ...d, addSubtitles: false, subtitles: [{ start: -1, end: 11, text: "" }] }, 10)).toBe("");
});
test("old free scripts and independent postproduction media are retained in snapshots", () => {
    const d = { ...draft(), storeShots: undefined, video: image("original"), speech: image("voice"), final: image("final") };
    const input = storeExploreInput(d, { channelMode: "remote", baseUrl: "" } as never);
    expect(input.script).toBe("原稿");
    expect(input.video).toBe(d.video);
    expect(input.speech).toBe(d.speech);
    expect(input.final).toBe(d.final);
    expect(emptyVideoDraft("store-explore").addSubtitles).toBe(false);
    expect(emptyVideoDraft("digital-human").addSubtitles).toBe(true);
});
test("free scripts reject only explicit conflicting duration or aspect ratio", () => {
    expect(storeFreeScriptError("视频时长：15秒。画幅：9:16", 10, "9:16")).toContain("15");
    expect(storeFreeScriptError("视频时长：10秒。画幅：9:16", 10, "16:9")).toContain("画幅");
    expect(storeFreeScriptError("商品特写，开场2秒", 10, "16:9")).toBe("");
});
test("final prompt excludes superseded analysis and requests and maps only submitted pictures", async () => {
    const {storeVideoPrompt} = await import("../src/pages/video-tool/store-explore-request");
    const {defaultConfig} = await import("../src/stores/use-config-store");
    const {REPLICATE_VIDEO_MODEL} = await import("../src/services/api/replicate");
    const d = {...draft(), analysis:"废弃观察", instructions:"旧要求总时长60秒", storeFirstFrameId:"store"};
    const prompt = storeVideoPrompt(d,{...defaultConfig,videoModel:REPLICATE_VIDEO_MODEL,videoInputMode:"first",videoSeconds:"10",size:"1280x720"});
    expect(prompt).not.toContain("废弃观察");
    expect(prompt).not.toContain("旧要求");
    expect(prompt).toContain("生成首帧");
    expect(prompt).toContain("无直接图片输入");
});
