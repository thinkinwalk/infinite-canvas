import { expect, test } from "bun:test";
import { contentReplacementPrompt } from "../src/pages/video-tool/content-replace-prompt";

test("person replacement assigns identity to the photo and motion to the source video", () => {
    const prompt = contentReplacementPrompt("person", "保留手中的商品");
    expect(prompt.startsWith("将视频1中的主讲人物完整替换为图片1中的人物。")).toBe(true);
    expect(prompt).toContain("图片1是新人物身份和外观的唯一依据");
    expect(prompt).toContain("不混合新旧身份");
    expect(prompt).toContain("不带入照片的背景");
    expect(prompt).toContain("口型时序");
    expect(prompt).toContain("不替换路人");
    expect(prompt).toContain("用户补充要求：保留手中的商品");
});

test("retaining subtitles preserves source glyphs and timing for every replacement target", () => {
    for (const target of ["person", "product", "background"] as const) {
        const prompt = contentReplacementPrompt(target, "");
        expect(prompt).toContain("覆盖在被替换对象上的字幕");
        expect(prompt).toContain("汉字、字母、数字、单位和标点");
        expect(prompt).toContain("出现和消失时间");
        expect(prompt).toContain("不要根据语音重新识别或编写字幕");
        expect(prompt).toContain("不把原字替换成形似字、乱码、随机笔画或伪字符");
        expect(prompt).not.toContain("去除原视频画面叠加的全部口播字幕");
    }
});

test("subtitle removal excludes retention rules and keeps real scene and product text", () => {
    for (const target of ["person", "product", "background"] as const) {
        const prompt = contentReplacementPrompt(target, "", true);
        expect(prompt).toContain("去除原视频画面叠加的全部口播字幕");
        expect(prompt).toContain("不生成新字幕");
        expect(prompt).toContain("保留场景中的招牌、商标、商品包装");
        expect(prompt).not.toContain("原样保留");
        expect(prompt).not.toContain("出现和消失时间");
    }
    expect(contentReplacementPrompt("product", "", true)).toContain("不把包装文字当作字幕擦除");
    expect(contentReplacementPrompt("background", "")).toContain("保留原片人物、脸部、发型、服装");
});
