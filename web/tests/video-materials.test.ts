import { expect, test } from "bun:test";
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) } });
const { materialMentionError, remapMaterialMentions } = await import("../src/lib/video-capabilities");

test("reordering references preserves the intended asset for each mention", () => {
    const before = [{ id: "product", label: "图片1" }, { id: "style", label: "图片2" }];
    const after = [{ id: "style", label: "图片1" }, { id: "product", label: "图片2" }];
    expect(remapMaterialMentions("@图片1是商品，@图片2是风格", before, after)).toBe("@图片2是商品，@图片1是风格");
});

test("removing a referenced asset flags it instead of silently using another asset", () => {
    const before = [{ id: "product", label: "图片1" }, { id: "style", label: "图片2" }];
    const after = [{ id: "style", label: "图片1" }];
    const prompt = remapMaterialMentions("@图片1是商品，@图片2是风格", before, after);
    expect(prompt).toContain("@已移除素材（图片1）");
    expect(prompt).toContain("@图片1是风格");
    expect(materialMentionError(prompt, after)).toContain("已移除");
});

test("nonexistent references block submission", () => {
    expect(materialMentionError("参考 @视频1", [{ id: "image", label: "图片1" }])).toContain("不存在");
    expect(materialMentionError("参考 @图片1", [{ id: "image", label: "图片1" }])).toBe("");
});
