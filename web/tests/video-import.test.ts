import { afterEach, expect, test } from "bun:test";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { importVideoURL } = await import("../src/services/api/video-import");
const { useUserStore } = await import("../src/stores/use-user-store");
const originalFetch = globalThis.fetch;
const source = { platform: "wxchannels", title: "中文视频 / 标题", author: "作者", sourceUrl: "https://weixin.qq.com/sph/test" };
const encoded = Buffer.from(JSON.stringify(source)).toString("base64");
afterEach(() => {
    globalThis.fetch = originalFetch;
    useUserStore.setState({ token: "" });
});
const signIn = () => useUserStore.setState({ token: "test-session" });
const signal = () => new AbortController().signal;

test("requires a session before contacting the service", async () => {
    useUserStore.setState({ token: "" });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(); }) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, signal())).rejects.toThrow("请登录");
    expect(calls).toBe(0);
});

test("sends only share text and session, decodes Chinese metadata and returns a file", async () => {
    signIn();
    const controller = new AbortController();
    globalThis.fetch = (async (url, init) => {
        expect(url).toBe("/api/v1/video/import-url");
        expect(init?.signal).toBe(controller.signal);
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-session" });
        expect(JSON.parse(String(init?.body))).toEqual({ url: `分享 ${source.sourceUrl}` });
        return new Response("video-bytes", { headers: { "Content-Type": "video/mp4", "X-Video-Import": encoded } });
    }) as typeof fetch;
    const result = await importVideoURL(`分享 ${source.sourceUrl}`, controller.signal);
    expect(result.source).toEqual(source);
    expect(result.file.name).toBe("中文视频   标题.mp4");
    expect(result.file.type).toBe("video/mp4");
    expect(await result.file.text()).toBe("video-bytes");
});

test("surfaces JSON failures even when the API returns HTTP 200", async () => {
    signIn();
    globalThis.fetch = (async () => Response.json({ code: 1, msg: "解析凭证失效" })) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, signal())).rejects.toThrow("解析凭证失效");
});

test("reports an older backend without confusing its HTML response for video", async () => {
    signIn();
    globalThis.fetch = (async () => new Response("<html>404</html>", { status: 404 })) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, signal())).rejects.toThrow("更新后端");
});

test("rejects malformed provenance and empty videos", async () => {
    signIn();
    for (const metadata of ["", "not-base64", Buffer.from('{"platform":"other"}').toString("base64")]) {
        globalThis.fetch = (async () => new Response("bytes", { headers: { "Content-Type": "video/mp4", "X-Video-Import": metadata } })) as typeof fetch;
        await expect(importVideoURL(source.sourceUrl, signal())).rejects.toThrow("来源信息不完整");
    }
    globalThis.fetch = (async () => new Response("", { headers: { "Content-Type": "video/mp4", "X-Video-Import": encoded } })) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, signal())).rejects.toThrow("视频为空");
});

test("keeps cancellation distinguishable from a network failure", async () => {
    signIn();
    const controller = new AbortController();
    globalThis.fetch = (async () => { controller.abort(); throw new TypeError("network"); }) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    globalThis.fetch = (async () => { throw new TypeError("network"); }) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, signal())).rejects.toThrow("连接失败");
});

test("does not return a file when canceled while reading the video", async () => {
    signIn();
    const controller = new AbortController();
    globalThis.fetch = (async () => {
        const response = new Response("video", { headers: { "Content-Type": "video/mp4", "X-Video-Import": encoded } });
        response.blob = async () => { controller.abort(); return new Blob(["video"]); };
        return response;
    }) as typeof fetch;
    await expect(importVideoURL(source.sourceUrl, controller.signal)).rejects.toHaveProperty("name", "AbortError");
});
