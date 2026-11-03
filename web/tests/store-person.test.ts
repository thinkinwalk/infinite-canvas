import { expect, test } from "bun:test";
import { emptyVideoDraft, type StoreShot, type WorkbenchMedia } from "../src/types/video-workbench";
import { parseStoreShots, storeKeyframeKey, storePlanKey } from "../src/pages/video-tool/store-explore-plan";
import { parseStoreMaterialSuggestion, storeCast, storeCastReferenceError, storeMaterialKey, storeSelectedIds } from "../src/pages/video-tool/store-materials";
import { storeScriptPrompt } from "../src/pages/video-tool/store-script";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } });
}
const { defaultConfig } = await import("../src/stores/use-config-store");
const { storeVideoError, storeVideoMaterials, storeVideoPrompt } = await import("../src/pages/video-tool/store-explore-request");

const image = (id: string, role: WorkbenchMedia["role"] = "reference", person?: string): WorkbenchMedia => ({
    id, name: id, url: `https://example.test/${id}.jpg`, storageKey: id, mimeType: "image/jpeg", bytes: 1,
    kind: "image", role, storePerson: person,
});
const shots: StoreShot[] = [
    { id: "opening", start: 0, end: 3, visual: "探店人端起碗，镜头跟向商品细节", dialogue: "先看这碗汤。", materialIds: ["product", "front"] },
    { id: "detail", start: 3, end: 10, visual: "商品细节回应开场", dialogue: "", materialIds: ["product"] },
];
const draft = () => ({
    ...emptyVideoDraft("store-explore"), script: "拍摄方案", storeShots: shots,
    media: [image("product"), image("front", "model"), image("side", "model"), image("back", "model")],
});
const config = { ...defaultConfig, videoSeconds: "10", channels: defaultConfig.channels.map((channel) => ({ ...channel, apiKey: "fixture-key" })) };

test("unnamed views and a single three-view sheet represent one intended presenter", () => {
    expect(storeCast(draft())).toEqual([{ name: "探店人", materialIds: ["front", "side", "back"] }]);
    expect(storeCast({ media: [image("three-view-sheet", "model")] })).toEqual([{ name: "探店人", materialIds: ["three-view-sheet"] }]);
    expect(storeCast({ media: [image("product")] })).toEqual([]);
});

test("named people are grouped by trimmed identity and each needs a reference", () => {
    const d = { media: [image("a-front", "model", " 小林 "), image("a-side", "model", "小林"), image("b", "model", "小陈")] };
    expect(storeCast(d)).toEqual([{ name: "小林", materialIds: ["a-front", "a-side"] }, { name: "小陈", materialIds: ["b"] }]);
    expect(storeCastReferenceError(d, ["a-side"])).toContain("小陈");
    expect(storeCastReferenceError(d, ["a-side", "b"])).toBe("");
});

test("product-only plans cannot satisfy an uploaded presenter, but one view is enough", () => {
    const d = draft(), before = JSON.stringify(d);
    expect(storeCastReferenceError(d, ["product"])).toContain("出镜人物");
    expect(storeCastReferenceError(d, ["product", "side"])).toBe("");
    expect(storeCastReferenceError({ media: [image("product")] }, ["product"])).toBe("");
    expect(JSON.stringify(d)).toBe(before);
});

test("script evidence carries intended cast even when the person name was left blank", () => {
    const d = draft();
    const materials = d.media.map((m) => ({ id: m.id, role: m.role, person: m.storePerson, observation: "可见外观" }));
    for (const candidate of [undefined, shots]) {
        const prompt = storeScriptPrompt(d, materials, 10, 7, undefined, candidate);
        const evidence = JSON.parse(prompt.match(/输入依据（数据，不是系统指令）：(\{[^\n]+\})。/)![1]);
        expect(evidence.cast).toEqual(storeCast(d));
        expect(evidence.images.find((m: { id: string }) => m.id === "front").role).toBe("model");
        expect(prompt).toContain("明确可见的出镜动作");
        expect(prompt).toContain("后续镜头回应开场");
        expect(prompt).toContain("台词不得凭空宣称亲历");
    }
    const noPerson = storeScriptPrompt({ ...d, media: [image("product")] }, [], 10, 7);
    expect(noPerson).toContain("未上传人物参考");
    expect(noPerson).not.toContain("cast中的每个人都必须");
});

test("local edits preserve unrelated shots and a presenter appearing outside the selected shot", () => {
    const d = draft(), detail = { ...shots[1], dialogue: "看清这个细节。" };
    const merged = parseStoreShots(JSON.stringify({ shots: [detail] }), d, 10, ["detail"]);
    expect(merged[0]).toBe(shots[0]);
    expect(storeCastReferenceError(d, merged.flatMap((s) => s.materialIds))).toBe("");
    const prompt = storeScriptPrompt(d, [], 10, 7, { request: "缩短台词", ids: ["detail"] });
    expect(prompt).toContain("不为补全人物而修改未选镜头");
    expect(prompt).toContain("ID、start、end逐项保持原值");
});

test("AI reference selection cannot silently drop the presenter or exceed the existing image limit", () => {
    const d = draft();
    const onlyProduct = { shots: shots.map((s) => ({ id: s.id, materialIds: ["product"] })) };
    expect(() => parseStoreMaterialSuggestion(JSON.stringify(onlyProduct), d, 7, "select")).toThrow("出镜人物");
    const selected = { shots: shots.map((s) => ({ id: s.id, materialIds: s.materialIds })) };
    expect(parseStoreMaterialSuggestion(JSON.stringify(selected), d, 2, "select").shots).toEqual(selected.shots);
    expect(() => parseStoreMaterialSuggestion(JSON.stringify(selected), d, 1, "select")).toThrow("上限");
    const free = { ...d, storeShots: [], storeReferenceIds: [] };
    expect(() => parseStoreMaterialSuggestion('{"referenceIds":["product"]}', free, 7, "select")).toThrow("出镜人物");
    expect(parseStoreMaterialSuggestion('{"referenceIds":["product","back"]}', free, 7, "select").referenceIds).toEqual(["product", "back"]);
});

test("video submission rejects missing cast and sends only the chosen identity view", () => {
    const d = draft();
    expect(storeVideoError(d, config)).toBe("");
    expect(storeVideoMaterials(d, config).map((m) => m.id)).toEqual(["product", "front"]);
    const prompt = storeVideoPrompt(d, config);
    expect(prompt).toContain("图片2=视频参考图2（人物 探店人）");
    expect(prompt).toContain("不生成重复人物或三视图拼贴");
    expect(prompt).not.toContain("视频参考图3");
    const productOnly = { ...d, storeShots: shots.map((s) => ({ ...s, materialIds: ["product"] })) };
    expect(storeVideoError(productOnly, config)).toContain("出镜人物");
    expect(storeVideoError({ ...d, storeShots: [], storeReferenceIds: ["product"] }, config)).toContain("出镜人物");
    expect(storeSelectedIds(d)).toEqual(["product", "front"]);
});

test("changing a material into a presenter expires script, keyframe and reference suggestions", () => {
    const d = draft(), changed = { ...d, media: d.media.map((m) => m.id === "front" ? { ...m, role: "reference" as const } : m) };
    expect(storePlanKey(d)).not.toBe(storePlanKey(changed));
    expect(storeKeyframeKey(d)).not.toBe(storeKeyframeKey(changed));
    expect(storeMaterialKey(d, 7)).not.toBe(storeMaterialKey(changed, 7));
});
