export type ContentReplacementTarget = "person" | "product" | "background";

const targetNames: Record<ContentReplacementTarget, string> = {
    person: "人物",
    product: "商品",
    background: "背景",
};

export function contentReplacementPrompt(target: ContentReplacementTarget, instructions: string, cleanSubtitles = false) {
    const name = targetNames[target];
    const stability =
        target === "person"
            ? "替换后的人物在整段视频中保持同一身份、脸部、发型、服装、比例和边缘稳定"
            : target === "product"
              ? "替换后的商品在整段视频中保持同一外观、颜色、标识、比例和边缘稳定"
              : "替换后的背景在整段视频中保持连贯，与人物、商品和光线自然衔接";
    return [
        `这是对视频1的局部${name}替换，图片1用于确定新${name}的外观，不是重新创作视频。`,
        target === "person"
            ? "从目标人物第一次出现的第一帧起完成替换，包括开头、转场后重现和结尾；不要先保留原人物再渐变。只替换原片主讲人物，不替换路人；没有主讲人物的镜头保持原画面，不强行加入人物。以图片1的人物身份、脸部、发型和服装为准，保留原片人物的动作、姿势、位置、视线、表情节奏及口型时序。"
            : target === "product"
              ? "从目标商品首次可见的第一帧开始替换，以图片1的形状、配色、材质、包装布局和可见标识为准，不混合新旧商品。保持原商品位置、尺度、运动、旋转方向及与手指的前后遮挡关系；商品被遮住时不穿透手部，重新出现时仍为同一商品。不替换人物或其他商品，不镜像商标，不编造参考图中不可见的包装文字。"
              : "仅替换背景环境，以图片1的场景为准；保留原片人物、脸部、发型、服装、商品及动作，保持前后景遮挡和接触关系，背景随原镜头自然运动。",
        "保持原视频的镜头顺序、构图、景别、时长、剪辑节奏、运镜及音频。不要新增镜头、拉伸画幅或改变播放速度。",
        `除目标${name}及用户明确要求的改动外，保留其他画面内容；不要镜像、改写或重画招牌、商标、价格和环境文字。`,
        cleanSubtitles ? "输入已完成字幕预处理，字幕由后期统一合成；不要生成字幕、标题、水印或新的文字。" : "保留原有字幕的文字、位置和出现时间，不翻译、不改写、不叠加新字幕；不要生成额外文字。",
        target === "product" ? "上述字幕约束仅指画面叠加文字；新商品本身的包装与商标以参考图为准，不把包装文字当作字幕擦除。" : "",
        stability + "。",
        instructions.trim() ? `用户补充要求：${instructions.trim()}` : "",
    ]
        .filter(Boolean)
        .join(" ");
}

