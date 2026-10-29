export type TryonValues = Record<string, string | string[]>;
export type TryonResult = { urls: string[]; inputs: TryonValues };
export type TryonPose = { id: string; name: string; image: string };
export type TryonDraft = { values: TryonValues; poses: TryonPose[] };

export const tryonDisplayPoses = [
    { id: "front", name: "正面站立", purpose: "展示正面版型" },
    { id: "side", name: "自然侧身", purpose: "展示侧面与轮廓" },
    { id: "back", name: "背面站立", purpose: "展示背面设计" },
    { id: "walking", name: "自然迈步", purpose: "展示整体穿着状态" },
];

export function tryonPoseLabel(values: TryonValues): string {
    if (values.poseMode === "preset") return tryonDisplayPoses.find((pose) => pose.id === values.poseId)?.name || "请选择展示姿势";
    if (values.poseMode === "reference") return "自定义姿势";
    if (values.poseMode === "library") return "参考图姿势";
    return "沿用照片姿势";
}

export const tryonDefaults = {
    modelSource: "library",
    modelImageUrl: "",
    garmentMode: "separates",
    topImageUrl: "",
    bottomImageUrl: "",
    onePieceImageUrl: "",
    poseMode: "preset",
    poseId: "front",
    poseImageUrl: "",
    posePrompt: "",
    sceneMode: "original",
    sceneImageUrl: "",
    prompt: "",
};

export function updateTryonValues(current: TryonValues, changes: TryonValues): TryonValues {
    const next: TryonValues = { ...tryonDefaults, ...current, ...changes };
    if (next.garmentMode === "one-piece") {
        next.topImageUrl = "";
        next.bottomImageUrl = "";
    } else {
        next.onePieceImageUrl = "";
    }
    if (changes.poseMode !== undefined && changes.poseMode !== current.poseMode && changes.poseImageUrl === undefined) next.poseImageUrl = "";
    if (next.poseMode === "original" || next.poseMode === "preset") next.poseImageUrl = "";
    if (next.poseMode !== "reference") next.posePrompt = "";
    if (next.poseMode !== "preset" && (next.poseMode !== "library" || !next.poseImageUrl)) next.poseId = "";
    if (next.sceneMode !== "library") next.sceneImageUrl = "";
    delete next.framing;
    return next;
}

export function tryonInputError(values: TryonValues): string {
    if (values.garmentMode === "one-piece" ? !values.onePieceImageUrl : !values.topImageUrl && !values.bottomImageUrl) return "请先上传服装图片";
    if (!values.modelImageUrl) return "请选择或上传模特照片";
    if (values.poseMode === "preset" && !tryonDisplayPoses.some((pose) => pose.id === values.poseId)) return "请选择展示姿势";
    if (values.poseMode === "reference" && !values.poseImageUrl && !String(values.posePrompt || "").trim()) return "请描述自定义姿势或上传参考照片";
    if (values.poseMode === "library" && (!values.poseId || !values.poseImageUrl)) return "请选择常用姿势";
    if (values.sceneMode === "library" && !values.sceneImageUrl) return "请选择场景";
    return "";
}

export function readTryonDraft(value: unknown): TryonDraft {
    if (value == null) return { values: { ...tryonDefaults }, poses: [] };
    const isValues = (input: unknown): input is TryonValues => Boolean(input && typeof input === "object" && !Array.isArray(input) && Object.values(input).every((item) => typeof item === "string" || Array.isArray(item) && item.every((part) => typeof part === "string")));
    const draft = value as TryonDraft;
    if (!isValues(draft.values) || !Array.isArray(draft.poses) || draft.poses.some((pose) => !pose || typeof pose.id !== "string" || typeof pose.name !== "string" || typeof pose.image !== "string")) {
        throw new Error("本机试衣草稿格式异常，已保留原数据");
    }
    return { values: updateTryonValues(draft.values, {}), poses: draft.poses };
}

export function tryonSources(values: TryonValues): Array<{ label: string; url: string }> {
    return [
        ["modelImageUrl", "模特"], ["topImageUrl", "上装"], ["bottomImageUrl", "下装"],
        ["onePieceImageUrl", "连体装"], ["poseImageUrl", "姿势参考"], ["sceneImageUrl", "场景"],
    ].flatMap(([key, label]) => typeof values[key] === "string" && values[key] ? [{ label, url: values[key] as string }] : []);
}
