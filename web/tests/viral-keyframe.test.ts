import { expect, test } from "bun:test";
import type { VideoDraft, WorkbenchMedia } from "../src/types/video-workbench";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } });
}
const { emptyVideoDraft } = await import("../src/types/video-workbench");
const { defaultConfig } = await import("../src/stores/use-config-store");
const { viralKeyframeError, viralKeyframeInputKey, viralKeyframeMaterials, viralKeyframePrompt } = await import("../src/pages/video-tool/viral-keyframe");
const { viralInput, viralSource, viralVideoMaterials, viralVideoPrompt } = await import("../src/pages/video-tool/viral-recreate-request");
const file = (id: string, role: WorkbenchMedia["role"]): WorkbenchMedia => ({ id, role, name: `${id}.png`, kind: "image", storageKey: id, url: `blob:${id}`, mimeType: "image/png", bytes: 20 });
const draft = (): VideoDraft => ({
    ...emptyVideoDraft("viral-recreate"), script: "人物转身，裙摆打开", instructions: "换成楼宇与指定人物", viralFacts: "辉科胜邦",
    viralSettings: { ...defaultConfig, size: "864x1536", videoSeconds: "5", vquality: "720" },
    media: [file("building", "background"), file("woman", "model"), file("product", "product"), file("candidate", "first-frame")],
    viralFirstFrameId: "candidate",
});

test("keyframe composition sends role images and only the explicitly selected current pose", () => {
    const d = draft();
    expect(viralKeyframeMaterials(d).map((m) => m.id)).toEqual(["building", "woman", "product"]);
    d.media.push({ ...file("reference", "reference"), kind: "video", mimeType: "video/mp4" });
    d.frames = [file("sample", "first-frame")];
    d.viralFrameSource = viralSource(d);
    d.viralKeyframeReferenceId = "frame:sample";
    expect(viralKeyframeMaterials(d).map((m) => m.id)).toEqual(["building", "woman", "product", "frame:sample"]);
    expect(viralKeyframePrompt(d)).toContain("图1=场景");
    expect(viralKeyframePrompt(d)).toContain("图2=人物");
    expect(viralKeyframePrompt(d)).toContain("开场姿势参考");
    expect(viralKeyframePrompt(d)).toContain("全身、裙摆与背面属于生成补全");
    d.viralFrameSource = "old-reference";
    expect(viralKeyframeMaterials(d).some((m) => m.id.startsWith("frame:"))).toBe(false);
});

test("keyframe confirmation survives blob URL restoration and excludes unrelated analysis switches", () => {
    const d = draft(), key = viralKeyframeInputKey(d);
    const restored = { ...d, media: d.media.map((m) => ({ ...m, url: "blob:restored" })), viralAnalysisMode: "frames" as const, frameCount: 10 };
    expect(viralKeyframeInputKey(restored)).toBe(key);
    d.viralKeyframe = { id: "candidate", inputKey: key, confirmed: true };
    expect(viralKeyframeError(d)).toBe("");
    expect(viralKeyframeError({ ...restored, viralKeyframe: d.viralKeyframe })).toBe("");
});

test("script, role, scene, pose, visual requirements and aspect changes require explicit reconfirmation", () => {
    const d = draft();
    d.viralKeyframe = { id: "candidate", inputKey: viralKeyframeInputKey(d), confirmed: true };
    const changes: Partial<VideoDraft>[] = [
        { script: "修改开场动作" }, { instructions: "改变场景" }, { viralFacts: "另一楼宇" },
        { media: d.media.filter((m) => m.role !== "model") },
        { media: d.media.map((m) => m.role === "background" ? { ...m, role: "product" } : m) },
        { viralKeyframeReferenceId: "frame:another" }, { viralKeyframePrompt: "完整裙摆入镜" },
        { viralSettings: { ...d.viralSettings!, size: "1536x864" } },
    ];
    for (const change of changes) expect(viralKeyframeError({ ...d, ...change })).toContain("重新确认");
    expect(viralKeyframeError({ ...d, viralKeyframe: { ...d.viralKeyframe, confirmed: false } })).toContain("确认");
    expect(viralKeyframeError({ ...d, viralFirstFrameId: "missing" })).toContain("失效");
    expect(viralKeyframeError({ ...d, viralFirstFrameId: undefined })).toBe("");
});

test("reference mode includes scene and selected keyframe, never every old candidate", () => {
    const d = draft();
    d.media.push(file("old-candidate", "first-frame"));
    const cfg = { ...defaultConfig, channelMode: "remote" as const, videoModel: "qa", videoInputMode: "reference", videoModels: { qa: { interface: "relay" as const, maxImages: 9, maxVideos: 1, maxAudios: 0, inputModes: ["reference" as const], resolutions: ["720"], seconds: ["5"] } } };
    expect(viralVideoMaterials(d, cfg).map((m) => m.id)).toEqual(["building", "woman", "product", "candidate"]);
    const prompt = viralVideoPrompt(d, cfg);
    expect(prompt).toContain("场景图提供环境与建筑");
    expect(prompt).toContain("没有向视频模型发送原视频");
});

test("first-frame mode sends only the selected composed frame and optional tail", () => {
    const d = draft();
    const cfg = { ...defaultConfig, channelMode: "remote" as const, videoModel: "qa", videoInputMode: "first_frame_only", videoModels: { qa: { interface: "relay" as const, maxImages: 1, maxVideos: 0, maxAudios: 0, inputModes: ["first_frame_only" as const], firstFrameField: "image_url", resolutions: ["720"], seconds: ["5"] } } };
    expect(viralVideoMaterials(d, cfg).map((m) => m.id)).toEqual(["candidate"]);
    expect(viralVideoPrompt(d, cfg)).toContain("不要把未发送的素材当作视觉输入");
});

test("history snapshots retain composition prompt, pose and explicit confirmation", () => {
    const d = draft();
    d.viralKeyframePrompt = "人物全身入镜";
    d.viralKeyframeReferenceId = "frame:pose";
    d.viralKeyframe = { id: "candidate", inputKey: viralKeyframeInputKey(d), confirmed: true, model: "image-edit" };
    const saved = viralInput(d, defaultConfig);
    expect(saved.viralKeyframe).toEqual(d.viralKeyframe);
    expect(saved.viralKeyframePrompt).toBe(d.viralKeyframePrompt);
    expect(saved.viralKeyframeReferenceId).toBe(d.viralKeyframeReferenceId);
});
