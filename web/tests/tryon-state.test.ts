import { expect, test } from "bun:test";
import { readTryonDraft, tryonDefaults, tryonDisplayPoses, tryonInputError, tryonPoseLabel, tryonSources, updateTryonValues, type TryonResult } from "../src/pages/cases/tryon-state";

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

test("switching modes removes inactive images and standalone framing", () => {
    expect(tryonDefaults).not.toHaveProperty("framing");
    const current = { ...tryonDefaults, topImageUrl: "top", bottomImageUrl: "bottom", framing: "half", poseImageUrl: "pose", sceneImageUrl: "scene" };
    const next = updateTryonValues(current, { garmentMode: "one-piece", onePieceImageUrl: "dress" });
    expect(next.topImageUrl).toBe("");
    expect(next.bottomImageUrl).toBe("");
    expect(next.poseImageUrl).toBe("");
    expect(next.sceneImageUrl).toBe("");
    expect(next).not.toHaveProperty("framing");
    expect(current.topImageUrl).toBe("top");
    const separates = updateTryonValues(next, { garmentMode: "separates", bottomImageUrl: "pants", framing: "half" });
    expect(separates.onePieceImageUrl).toBe("");
    expect(separates).not.toHaveProperty("framing");
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
    const combined = { ...ready, bottomImageUrl: "bottom", poseMode: "reference", poseId: "", poseImageUrl: "pose", sceneMode: "studio", prompt: "全身构图，衣摆自然垂放" };
    expect(tryonInputError(combined)).toBe("");
    expect(updateTryonValues(ready, combined)).toEqual(combined);
    expect(tryonSources(combined).map((item) => item.label)).toEqual(["模特", "上装", "下装", "姿势参考"]);
    expect(tryonInputError({ ...combined, sceneMode: "library", sceneImageUrl: "scene" })).toBe("");
});

test("draft restoration retains inputs and personal poses without restoring previous results", () => {
    const inputs = { ...tryonDefaults, topImageUrl: "original garment", modelImageUrl: "person" };
    const draft = { values: { ...inputs, topImageUrl: "new garment" }, result: { inputs, urls: ["image"] }, poses: [{ id: "pose-1", name: "侧身", image: "pose image" }] };
    const restored = readTryonDraft(structuredClone(draft));
    expect(restored.values.topImageUrl).toBe("new garment");
    expect(restored.values).not.toHaveProperty("framing");
    expect(restored).not.toHaveProperty("result");
    expect(restored.poses[0]).toEqual(draft.poses[0]);
    expect(readTryonDraft(null)).toEqual({ values: tryonDefaults, poses: [] });
    expect(readTryonDraft(restored)).toEqual(restored);
    expect(draft.result.inputs.topImageUrl).toBe("original garment");
});

test("corrupt drafts are rejected without silently replacing the original data", () => {
    for (const value of [{}, { values: {}, poses: null }, { values: {}, poses: [{}] }, { values: { image: 123 }, poses: [] }]) {
        const before = structuredClone(value);
        expect(() => readTryonDraft(value)).toThrow("格式异常");
        expect(value).toEqual(before);
    }
});

test("preset pose selection survives drafts, while changing source clears it", () => {
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
    expect(draft).not.toHaveProperty("result");
});

test("four display poses default to front and clear inactive custom inputs", () => {
    expect(tryonDisplayPoses.map((pose) => pose.id)).toEqual(["front", "side", "back", "walking"]);
    const ready = { ...tryonDefaults, topImageUrl: "top", modelImageUrl: "person" };
    expect(ready.poseMode).toBe("preset");
    expect(tryonPoseLabel(ready)).toBe("正面站立");
    for (const pose of tryonDisplayPoses) {
        const selected = updateTryonValues(ready, { poseMode: "preset", poseId: pose.id, poseImageUrl: "stale", posePrompt: "stale text" });
        expect(tryonInputError(selected)).toBe("");
        expect(selected.poseImageUrl).toBe("");
        expect(selected.posePrompt).toBe("");
        expect(tryonPoseLabel(selected)).toBe(pose.name);
        expect(readTryonDraft({ values: selected, poses: [] }).values).toEqual(selected);
    }
    expect(tryonInputError({ ...ready, poseId: "unknown" })).toContain("展示姿势");
});

test("custom poses accept text or image and preserve requirements in drafts", () => {
    const ready = { ...tryonDefaults, topImageUrl: "top", modelImageUrl: "person" };
    const custom = updateTryonValues(ready, { poseMode: "reference", posePrompt: "单手轻扶腰部" });
    expect(tryonInputError(custom)).toBe("");
    expect(custom.poseId).toBe("");
    expect(tryonPoseLabel(custom)).toBe("自定义姿势");
    expect(readTryonDraft({ values: custom, poses: [] }).values).toEqual(custom);
    expect(tryonInputError({ ...custom, posePrompt: " \n " })).toContain("描述");
    expect(tryonInputError({ ...custom, posePrompt: "", poseImageUrl: "pose" })).toBe("");
    const original = updateTryonValues(custom, { poseMode: "original" });
    expect(original.posePrompt).toBe("");
    expect(original.poseId).toBe("");
    expect(tryonPoseLabel(original)).toBe("沿用照片姿势");
    expect(custom.posePrompt).toBe("单手轻扶腰部");
});
