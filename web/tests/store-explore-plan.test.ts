import { expect, test } from "bun:test";
import { emptyVideoDraft, type StoreShot, type WorkbenchMedia } from "../src/types/video-workbench";
import { pruneStoreMediaReferences, storeSelectedMaterialError, storeUnlinkedMaterialIds } from "../src/pages/video-tool/store-materials";
import { parseStoreFeedbackResult, parseStoreShots, renderStoreShots, storeCaptionError, storeExploreInput, storeFreeScriptError, storePlanError, storePlanKey, storeSpeechKey, storeSubtitleSource } from "../src/pages/video-tool/store-explore-plan";

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
    expect(storePlanError(shots, ["product"], 10)).toContain("未关联到当前项目");
    expect(() => parseStoreShots(JSON.stringify({ shots }), { ...d, media: [image("product")] }, 10)).toThrow("引用");
});
test("stale material references distinguish project links from removed project assets", () => {
    const d = draft();
    expect(storeSelectedMaterialError({ ...d, storeShots: [{ ...shots[0], materialIds: ["not-linked"] }] })).toContain("素材库原文件不会被删除");
    expect(storeUnlinkedMaterialIds({ ...d, storeShots: [{ ...shots[0], materialIds: ["not-linked", "another-unlinked"] }] })).toEqual(["not-linked", "another-unlinked"]);
    const unavailable = { ...d.media[0], kind: "audio" as const, role: "voice" as const };
    expect(storeSelectedMaterialError({ ...d, media: [unavailable], storeShots: [{ ...shots[0], materialIds: [unavailable.id] }] })).toContain("仍在项目中");
    expect(storeSelectedMaterialError({ ...d, storeShots: shots })).toBe("");
});
test("scoped edit preserves every unselected field and rejects extra or missing IDs", () => {
    const d = draft(), next = { ...shots[0], dialogue: "进来看看" };
    const merged = parseStoreShots(JSON.stringify({ shots: [next] }), d, 10, ["opening"]);
    expect(merged[0]).toEqual(next);
    expect(merged[1]).toBe(shots[1]);
    expect(() => parseStoreShots(JSON.stringify({ shots }), d, 10, ["opening"])).toThrow("范围");
    expect(() => parseStoreShots(JSON.stringify({ shots: [{ ...next, id: "other" }] }), d, 10, ["opening"])).toThrow("范围");
});
test("video feedback merges only validated affected shots and preserves the original timeline", () => {
    const d = draft();
    const result = parseStoreFeedbackResult(JSON.stringify({
        understanding: "开场商品没有清晰呈现，调整镜头画面表现。",
        affectedShotIds: ["opening"],
        shots: [{ ...shots[0], visual: "近景展示真实商品" }],
    }), d, 10);
    expect(result.affectedShotIds).toEqual(["opening"]);
    expect(result.shots[0].visual).toBe("近景展示真实商品");
    expect(result.shots[1]).toBe(shots[1]);
    for (const raw of [
        JSON.stringify({ understanding: "问题", affectedShotIds: ["missing"], shots: [{ ...shots[0], id: "missing" }] }),
        JSON.stringify({ understanding: "问题", affectedShotIds: ["opening"], shots: [{ ...shots[0], end: 3 }] }),
        JSON.stringify({ understanding: "问题", affectedShotIds: ["opening"], shots: [{ ...shots[0], materialIds: ["missing"] }] }),
        JSON.stringify({ understanding: "问题", affectedShotIds: ["opening"], shots: [{ ...shots[0] }] }),
    ]) expect(() => parseStoreFeedbackResult(raw, d, 10)).toThrow();
    expect(() => parseStoreFeedbackResult(JSON.stringify({
        understanding: "问题",
        affectedShotIds: ["opening", "product"],
        shots: [{ ...shots[0], visual: "改过的镜头" }, shots[1]],
    }), d, 10, ["opening"])).toThrow("范围");
});
test("continued local revisions use the pending candidate without changing the approved draft", async () => {
    const { storeScriptPrompt } = await import("../src/pages/video-tool/store-script");
    const d = draft(), candidate = [{ ...shots[0], dialogue: "候选开场" }, shots[1]];
    const pending = { ...d, storeScriptSuggestion: renderStoreShots(candidate, d), storeShotSuggestion: candidate };
    const source = { ...pending, script: pending.storeScriptSuggestion, storeShots: candidate };
    const prompt = storeScriptPrompt(source, [], 10, 7, { request: "再自然一点", ids: ["opening"] });
    expect(prompt).toContain("候选开场");
    expect(prompt).toContain("再自然一点");
    const nextShots = parseStoreShots(JSON.stringify({ shots: [{ ...candidate[0], dialogue: "更自然的开场" }] }), source, 10, ["opening"]);
    expect(nextShots[0].dialogue).toBe("更自然的开场");
    expect(nextShots[1]).toBe(candidate[1]);
    expect(d.script).toBe("原稿");
    expect(d.storeShots).toEqual(shots);
});
test("whole-plan revision mode is explicit and conversation turns persist in task snapshots", async () => {
    const { storeScriptPrompt } = await import("../src/pages/video-tool/store-script");
    const d = { ...draft(), storeScriptTurns: [{ id: "turn-1", request: "加强开头", scope: "整稿改写", before: "旧稿", after: "新稿", status: "accepted" as const, createdAt: 1 }] };
    expect(storeScriptPrompt(d, [], 10, 7, { request: "整体加快", rewrite: true })).toContain("用户已明确选择整稿改写");
    const input = storeExploreInput(d, { channelMode: "remote", baseUrl: "" } as never);
    expect(input.storeScriptTurns).toEqual(d.storeScriptTurns);
});
test("feedback source and selected timestamp are persisted with the project and prompt", async () => {
    const { storeScriptPrompt } = await import("../src/pages/video-tool/store-script");
    const d = { ...draft(), video: image("generated-video"), storeFeedbackSourceRecordId: "record-1" };
    const input = storeExploreInput(d, { channelMode: "remote", baseUrl: "" } as never);
    expect(input.storeFeedbackSourceRecordId).toBe("record-1");
    const textOnly = storeScriptPrompt(d, [], 10, 7, { request: "画面太暗", feedbackVideoRecordId: "record-1" });
    expect(textOnly).toContain("本轮未附成片画面");
    const withFrame = storeScriptPrompt(d, [], 10, 7, { request: "画面太暗", feedbackVideoRecordId: "record-1", feedbackTimeSeconds: 3.5 });
    expect(withFrame).toContain("3.50 秒处的取样画面");
    expect(storePlanKey(d)).not.toBe(storePlanKey({ ...d, storeFeedbackSourceRecordId: "record-2" }));
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
test("removing a material prunes every reference that pointed at it", () => {
    const d = {
        ...draft(),
        storeReferenceIds: ["store", "product"],
        storeFirstFrameId: "store",
        storeLastFrameId: "gone",
        storeMaterialSuggestion: { shots: [{ id: "opening", materialIds: ["gone", "store"] }], referenceIds: ["gone"], base: "", mode: "fill" as const },
        storePlanVersions: [{ id: "v1", script: "", shots: [{ ...shots[0], materialIds: ["gone"] }], referenceIds: ["gone", "product"], createdAt: 1 }],
    };
    const pruned = pruneStoreMediaReferences(d, [image("product")]);
    expect(pruned.storeShots?.[0].materialIds).toEqual([]);
    expect(pruned.storeShots?.[1].materialIds).toEqual(["product"]);
    expect(pruned.storeReferenceIds).toEqual(["product"]);
    expect(pruned.storeFirstFrameId).toBeUndefined();
    expect(pruned.storeLastFrameId).toBeUndefined();
    expect(pruned.storeMaterialSuggestion?.shots[0].materialIds).toEqual([]);
    expect(pruned.storeMaterialSuggestion?.referenceIds).toEqual([]);
    expect(pruned.storePlanVersions?.[0].shots[0].materialIds).toEqual([]);
    expect(pruned.storePlanVersions?.[0].referenceIds).toEqual(["product"]);
    // 收口后不再存在失效引用，可以直接通过选中素材校验
    expect(storeUnlinkedMaterialIds({ ...d, ...pruned, media: [image("product")] })).toEqual([]);
});
