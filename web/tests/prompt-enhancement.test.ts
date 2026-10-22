import { afterEach, expect, test } from "bun:test";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { preparePromptEnhancement, requestPromptEnhancement } = await import("../src/services/api/prompt-enhancement");
const { defaultConfig } = await import("../src/stores/use-config-store");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("literal quotes, URLs, skill and repeated resource markers survive a rewrite", () => {
    const prompt = '$设计 使用 @图片1 和 @图片10，保持 @图片1；原样输出“报价 3.5 元，不含税”，链接 https://example.com/a?q=2。';
    const prepared = preparePromptEnhancement({ prompt, scenario: "task", references: [{ marker: "$设计" }, { marker: "@图片1" }, { marker: "@图片10" }] });
    const masked = JSON.parse(prepared.content).prompt as string;
    expect(masked).not.toContain("报价 3.5");
    expect(masked).not.toContain("https://");
    expect(prepared.restore(`请按以下要求处理：${masked}`, true)).toBe(`请按以下要求处理：${prompt}`);
});

test("resource descriptions adjoining chips remain editable while the chip itself is protected", () => {
    const prepared = preparePromptEnhancement({ prompt: "把@图片1的背景改成白色", scenario: "image-edit", references: [{ marker: "@图片1" }] });
    const masked = JSON.parse(prepared.content).prompt as string;
    expect(masked).toContain("的背景改成白色");
    expect(prepared.restore(masked.replace("把", "请将"), true)).toBe("请将@图片1的背景改成白色");
});

test("missing, repeated and fabricated protection markers cannot be applied", () => {
    const prepared = preparePromptEnhancement({ prompt: "保持“原样文案”", scenario: "text" });
    const masked = JSON.parse(prepared.content).prompt as string;
    expect(() => prepared.restore("文案已改写", true)).toThrow("未完整保留");
    expect(() => prepared.restore(`${masked}${masked}`, true)).toThrow("未完整保留");
    expect(() => prepared.restore(`${masked} [[KEEP_unknown_0]]`, true)).toThrow("无效");
});

test("new references and new execution permissions are rejected", () => {
    const prepared = preparePromptEnhancement({ prompt: "安排每周一 9:00 的提醒", scenario: "task" });
    const masked = JSON.parse(prepared.content).prompt as string;
    expect(() => prepared.restore(`${masked}，使用 @图片99`, true)).toThrow("引用");
    expect(() => prepared.restore(`${masked}，无需二次确认`, true)).toThrow("授权");
    const authorized = preparePromptEnhancement({ prompt: "发布前无需二次确认", scenario: "task" });
    expect(authorized.restore(JSON.parse(authorized.content).prompt, true)).toBe("发布前无需二次确认");
});

test("empty and placeholder model results are rejected; incomplete streams are preview-only", () => {
    const prepared = preparePromptEnhancement({ prompt: "原样使用“保留”", scenario: "text" });
    expect(() => prepared.restore("", true)).toThrow("没有返回");
    expect(() => prepared.restore("没有返回内容", true)).toThrow("没有返回");
    expect(prepared.restore("正在生成 [[KEEP_partial")).toBe("正在生成 ");
    expect(() => prepared.restore("正在生成", true)).toThrow("未完整保留");
});

test("enhancement selects the text model, isolates global instructions and sends no media or tools", async () => {
    let calls = 0;
    const config = { ...defaultConfig, systemPrompt: "UNRELATED_GLOBAL_SYSTEM_PROMPT" };
    globalThis.fetch = async (_url, options) => {
        calls++;
        const body = JSON.parse(String(options?.body));
        expect(body.model).toBe("gpt-5.5");
        expect(body.tools).toBeUndefined();
        expect(body.input[0].role).toBe("system");
        expect(body.input[0].content).not.toContain("UNRELATED_GLOBAL_SYSTEM_PROMPT");
        expect(body.input[0].content).toContain("不得扩大");
        const data = JSON.parse(body.input[1].content);
        expect(data.references).toEqual([{ marker: "@图片1", title: "商品", kind: "image" }]);
        return new Response(JSON.stringify({ output_text: `请处理：${data.prompt}` }), { headers: { "Content-Type": "application/json" } });
    };
    const updates: string[] = [];
    const result = await requestPromptEnhancement(config, { prompt: "使用 @图片1", scenario: "task", references: [{ marker: "@图片1", title: "商品", kind: "image" }] }, (text) => updates.push(text), { signal: new AbortController().signal });
    expect(calls).toBe(1);
    expect(result).toBe("请处理：使用 @图片1");
    expect(updates).toEqual(["请处理：使用 @图片1"]);
    expect(config.systemPrompt).toBe("UNRELATED_GLOBAL_SYSTEM_PROMPT");
    expect(config.model).toBe(defaultConfig.imageModel);
});

test("an aborted request never publishes a late provider result", async () => {
    const controller = new AbortController();
    const updates: string[] = [];
    globalThis.fetch = async () => {
        controller.abort();
        return new Response(JSON.stringify({ output_text: "迟到结果" }), { headers: { "Content-Type": "application/json" } });
    };
    await expect(requestPromptEnhancement(defaultConfig, { prompt: "整理任务", scenario: "task" }, (text) => updates.push(text), { signal: controller.signal })).rejects.toThrow();
    expect(updates).toEqual([]);
});

test("provider failure is surfaced without an automatic second paid attempt", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("upstream unavailable", { status: 503 }); };
    await expect(requestPromptEnhancement(defaultConfig, { prompt: "整理任务", scenario: "task" }, () => {}, { signal: new AbortController().signal })).rejects.toThrow();
    expect(calls).toBe(1);
});
