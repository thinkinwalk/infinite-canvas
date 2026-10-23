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
    const subtitleRule = cleanSubtitles
        ? "与此同时，去除原视频画面叠加的全部口播字幕，包括每次出现和切换的字幕，补全被字幕遮挡的衣服或背景，不生成新字幕、标题、水印或额外文字。保留场景中的招牌、商标、商品包装和其他真实环境文字。"
        : "原视频的字幕作为独立画面叠加层原样保留，包括覆盖在被替换对象上的字幕。逐帧保持全部汉字、字母、数字、单位和标点，以及字体、字号、颜色、描边、换行、位置、出现和消失时间，与原视频一致。不要根据语音重新识别或编写字幕，不翻译、不改写、不纠错；看不清的文字不要猜测或补写，不把原字替换成形似字、乱码、随机笔画或伪字符，不新增字幕、标题、水印或额外文字。";
    const stabilityWithSubtitle = cleanSubtitles && target === "person"
        ? stability + "，手部自然，去字幕区域连续稳定无残字"
        : stability;
    return [
        target === "person"
            ? "将视频1中的主讲人物完整替换为图片1中的人物。图片1是新人物身份和外观的唯一依据，视频1提供动作、镜头和时间轴。"
            : `这是对视频1的局部${name}替换，图片1用于确定新${name}的外观，不是重新创作视频。`,
        target === "person"
            ? "从主讲人物首次可见的第一帧到最后一帧，脸部五官、脸型、发型、服装和配饰均以图片1为准；原人物的脸、发型、服装和眼镜等配饰不作为新人物外观依据，不混合新旧身份，不只美化原人物，不先保留原人物再渐变。图片1只用于人物外观，不带入照片的背景、座椅、构图或静态姿势。新人物执行视频1中原主讲人物的动作、姿势、位置、视线、表情节奏及口型时序。只替换主讲人物，不替换路人；无人镜头保持原画面，不加入人物；转场或遮挡后仍为图片1中的同一人物。"
            : target === "product"
              ? "从目标商品首次可见的第一帧开始替换，以图片1的形状、配色、材质、包装布局和可见标识为准，不混合新旧商品。保持原商品位置、尺度、运动、旋转方向及与手指的前后遮挡关系；商品被遮住时不穿透手部，重新出现时仍为同一商品。不替换人物或其他商品，不镜像商标，不编造参考图中不可见的包装文字。"
              : "仅替换背景环境，以图片1的场景为准；保留原片人物、脸部、发型、服装、商品及动作，保持前后景遮挡和接触关系，背景随原镜头自然运动。",
        "保持原视频的镜头顺序、构图、景别、时长、剪辑节奏、运镜及音频。不要新增镜头、拉伸画幅或改变播放速度。",
        `除目标${name}及用户明确要求的改动外，保留其他画面内容；不要镜像、改写或重画招牌、商标、价格和环境文字。`,
        subtitleRule,
        target === "product" ? "上述字幕约束仅指画面叠加文字；新商品本身的包装与商标以参考图为准，不把包装文字当作字幕擦除。" : "",
        stabilityWithSubtitle + "。",
        instructions.trim() ? `用户补充要求：${instructions.trim()}` : "",
    ]
        .filter(Boolean)
        .join(" ");
}

