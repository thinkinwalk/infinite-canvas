import { afterEach, expect, test } from "bun:test";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { requestImageQuestion } = await import("../src/services/api/image");
const { defaultConfig } = await import("../src/stores/use-config-store");
const config = { ...defaultConfig, model: defaultConfig.textModel };
const messages = [{ role: "user" as const, content: "撰写保温杯视频提示词" }];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("HTTP 200 JSON business errors reach the caller instead of becoming empty text", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1, msg: "登录已失效，请重新登录" }), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    const updates: string[] = [];
    await expect(requestImageQuestion(config, messages, (text) => updates.push(text))).rejects.toThrow("登录已失效，请重新登录");
    expect(updates).toEqual([]);
});

test("JSON text responses populate the prompt when the upstream does not stream", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "镜头缓慢环绕保温杯。" }] }] }), { headers: { "Content-Type": "application/json" } });
    const updates: string[] = [];
    expect(await requestImageQuestion(config, messages, (text) => updates.push(text))).toBe("镜头缓慢环绕保温杯。");
    expect(updates).toEqual(["镜头缓慢环绕保温杯。"]);
});

test("SSE responses continue to provide incremental text and a complete final prompt", async () => {
    const events = [
        { type: "response.output_text.delta", delta: "镜头缓慢" },
        { type: "response.output_text.delta", delta: "环绕保温杯。" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(events);
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 47));
        controller.enqueue(bytes.slice(47));
        controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
    const updates: string[] = [];
    expect(await requestImageQuestion(config, messages, (text) => updates.push(text))).toBe("镜头缓慢环绕保温杯。");
    expect(updates).toEqual(["镜头缓慢", "镜头缓慢环绕保温杯。"]);
});
