export type TryonValues = Record<string, string | string[]>;
export type TryonResult = { urls: string[]; inputs: TryonValues };
export type TryonPose = { id: string; name: string; image: string };
export type TryonDraft = { values: TryonValues; result: TryonResult | null; poses: TryonPose[] };

export const tryonDefaults = {
    modelSource: "library",
    modelImageUrl: "",
    garmentMode: "separates",
    topImageUrl: "",
    bottomImageUrl: "",
    onePieceImageUrl: "",
    poseMode: "original",
    poseId: "",
    poseImageUrl: "",
    sceneMode: "original",
    sceneImageUrl: "",
    framing: "full",
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
    if (next.poseMode === "original") next.poseImageUrl = "";
    if (next.poseMode !== "library" || !next.poseImageUrl) next.poseId = "";
    if (next.sceneMode !== "library") next.sceneImageUrl = "";
    if (next.framing !== "half" || next.garmentMode === "one-piece" || next.bottomImageUrl) next.framing = "full";
    return next;
}

export function tryonInputError(values: TryonValues): string {
    if (values.garmentMode === "one-piece" ? !values.onePieceImageUrl : !values.topImageUrl && !values.bottomImageUrl) return "请先上传服装图片";
    if (!values.modelImageUrl) return "请选择或上传模特照片";
    if (values.poseMode === "reference" && !values.poseImageUrl) return "请上传姿势参考照片";
    if (values.poseMode === "library" && (!values.poseId || !values.poseImageUrl)) return "请选择常用姿势";
    if (values.sceneMode === "library" && !values.sceneImageUrl) return "请选择场景";
    return "";
}

export function readTryonDraft(value: unknown): TryonDraft {
    if (value == null) return { values: { ...tryonDefaults }, result: null, poses: [] };
    const isValues = (input: unknown): input is TryonValues => Boolean(input && typeof input === "object" && !Array.isArray(input) && Object.values(input).every((item) => typeof item === "string" || Array.isArray(item) && item.every((part) => typeof part === "string")));
    const draft = value as TryonDraft;
    if (!isValues(draft.values) || !Array.isArray(draft.poses) || draft.poses.some((pose) => !pose || typeof pose.id !== "string" || typeof pose.name !== "string" || typeof pose.image !== "string") ||
        draft.result !== null && (!draft.result || !isValues(draft.result.inputs) || !Array.isArray(draft.result.urls) || draft.result.urls.some((url) => typeof url !== "string"))) {
        throw new Error("本机试衣草稿格式异常，已保留原数据");
    }
    return { values: updateTryonValues(draft.values, {}), result: draft.result, poses: draft.poses };
}

export function tryonSources(values: TryonValues): Array<{ label: string; url: string }> {
    return [
        ["modelImageUrl", "模特"], ["topImageUrl", "上装"], ["bottomImageUrl", "下装"],
        ["onePieceImageUrl", "连体装"], ["poseImageUrl", "姿势参考"], ["sceneImageUrl", "场景"],
    ].flatMap(([key, label]) => typeof values[key] === "string" && values[key] ? [{ label, url: values[key] as string }] : []);
}
