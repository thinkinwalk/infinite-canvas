import { expect, test } from "bun:test";
import { readTryonDraft, tryonDefaults, tryonInputError, tryonSources, updateTryonValues, type TryonResult } from "../src/pages/cases/tryon-state";

test("try-on requires the selected garment, person, pose and scene", () => {
    expect(tryonInputError(tryonDefaults)).toContain("服装");
    const garment = { ...tryonDefaults, topImageUrl: "top" };
    expect(tryonInputError(garment)).toContain("模特");
    const ready = { ...garment, modelImageUrl: "person" };
    expect(tryonInputError(ready)).toBe("");
    expect(tryonInputError({ ...ready, topImageUrl: "", bottomImageUrl: "bottom" })).toBe("");
    expect(tryonInputError({ ...ready, garmentMode: "one-piece", topImageUrl: "", onePieceImageUrl: "dress" })).toBe("");
    expect(tryonInputError({ ...ready, poseMode: "reference" })).toContain("姿势");
    expect(tryonInputError({ ...ready, sceneMode: "library" })).toContain("场景");
    expect(tryonInputError({ ...ready, garmentMode: "one-piece" })).toContain("服装");
});

test("switching modes removes inactive images and prevents half-body trousers", () => {
    expect(tryonDefaults.framing).toBe("full");
    expect(updateTryonValues(tryonDefaults, { topImageUrl: "top", framing: "half" }).framing).toBe("half");
    expect(updateTryonValues(tryonDefaults, { framing: "original" }).framing).toBe("full");
    const current = { ...tryonDefaults, topImageUrl: "top", bottomImageUrl: "bottom", framing: "half", poseImageUrl: "pose", sceneImageUrl: "scene" };
    const next = updateTryonValues(current, { garmentMode: "one-piece", onePieceImageUrl: "dress" });
    expect(next.topImageUrl).toBe("");
    expect(next.bottomImageUrl).toBe("");
    expect(next.poseImageUrl).toBe("");
    expect(next.sceneImageUrl).toBe("");
    expect(next.framing).toBe("full");
    expect(current.topImageUrl).toBe("top");
    const separates = updateTryonValues(next, { garmentMode: "separates", bottomImageUrl: "pants", framing: "half" });
    expect(separates.onePieceImageUrl).toBe("");
    expect(separates.framing).toBe("full");
});

test("editing parameters preserves the previous result input snapshot", () => {
    const inputs = updateTryonValues(tryonDefaults, { topImageUrl: "top", modelImageUrl: "person" });
    const result: TryonResult = { inputs, urls: ["result"] };
    const edited = updateTryonValues(inputs, { topImageUrl: "new-top", poseMode: "reference", poseImageUrl: "pose" });
    expect(result.inputs.topImageUrl).toBe("top");
    expect(result.inputs.poseImageUrl).toBe("");
    expect(tryonSources(result.inputs)).toEqual([{ label: "模特", url: "person" }, { label: "上装", url: "top" }]);
    expect(tryonSources(edited).map((item) => item.label)).toEqual(["模特", "上装", "姿势参考"]);
    expect(updateTryonValues({ ...edited, prompt: "new instructions" }, result.inputs).prompt).toBe("");
});

test("cloud try-on accepts combined garments, pose, scene and framing instructions", () => {
    const ready = { ...tryonDefaults, modelImageUrl: "person", topImageUrl: "top" };
    expect(tryonInputError(ready)).toBe("");
    const combined = { ...ready, bottomImageUrl: "bottom", poseMode: "reference", poseImageUrl: "pose", sceneMode: "studio", framing: "full", prompt: "衣摆自然垂放" };
    expect(tryonInputError(combined)).toBe("");
    expect(updateTryonValues(ready, combined)).toEqual(combined);
    expect(tryonSources(combined).map((item) => item.label)).toEqual(["模特", "上装", "下装", "姿势参考"]);
    expect(tryonInputError({ ...combined, sceneMode: "library", sceneImageUrl: "scene" })).toBe("");
});

test("draft restoration retains input snapshot and personal pose images", () => {
    const inputs = { ...tryonDefaults, topImageUrl: "original garment", modelImageUrl: "person" };
    const draft = { values: { ...inputs, topImageUrl: "new garment" }, result: { inputs, urls: ["image"] }, poses: [{ id: "pose-1", name: "侧身", image: "pose image" }] };
    const restored = readTryonDraft(structuredClone(draft));
    expect(restored.values.topImageUrl).toBe("new garment");
    expect(restored.values.framing).toBe("full");
    expect(restored.result?.inputs.topImageUrl).toBe("original garment");
    expect(restored.poses[0]).toEqual(draft.poses[0]);
    expect(readTryonDraft(null)).toEqual({ values: tryonDefaults, result: null, poses: [] });
});

test("corrupt drafts are rejected without silently replacing the original data", () => {
    for (const value of [{}, { values: {}, result: {}, poses: [] }, { values: {}, result: null, poses: [{}] }, { values: { image: 123 }, result: null, poses: [] }]) {
        const before = structuredClone(value);
        expect(() => readTryonDraft(value)).toThrow("格式异常");
        expect(value).toEqual(before);
    }
});

test("preset pose selection survives drafts and restoring a result, while changing source clears it", () => {
    const ready = { ...tryonDefaults, topImageUrl: "top", modelImageUrl: "model" };
    expect(tryonInputError({ ...ready, poseMode: "library" })).toContain("常用姿势");
    const preset = updateTryonValues(ready, { poseMode: "library", poseId: "walking", poseImageUrl: "/api/tryon/assets/walking.jpg" });
    expect(tryonInputError(preset)).toBe("");
    const draft = readTryonDraft({ values: preset, result: { inputs: preset, urls: ["result"] }, poses: [] });
    expect(draft.values).toEqual(preset);
    const custom = updateTryonValues(preset, { poseMode: "reference" });
    expect(custom.poseImageUrl).toBe("");
    expect(custom.poseId).toBe("");
    const uploaded = updateTryonValues(custom, { poseImageUrl: "uploaded pose" });
    const library = updateTryonValues(uploaded, { poseMode: "library" });
    expect(library.poseImageUrl).toBe("");
    expect(tryonInputError(library)).toContain("常用姿势");
    expect(updateTryonValues(uploaded, preset)).toEqual(preset);
    const original = updateTryonValues(preset, { poseMode: "original" });
    expect(original.poseImageUrl).toBe("");
    expect(original.poseId).toBe("");
    expect(draft.result?.inputs.poseId).toBe("walking");
});
