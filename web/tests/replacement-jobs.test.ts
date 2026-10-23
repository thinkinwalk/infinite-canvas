import { afterEach, expect, test } from "bun:test";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { useUserStore } = await import("../src/stores/use-user-store");
const { createReplacementJob, setReplacementAspectRatio, startReplacementJob, retryReplacementPart, listReplacementJobs } = await import("../src/services/api/replacement-jobs");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState({ token: "" }); });

test("planning never starts paid execution and failed requests are not retried", async () => {
    useUserStore.setState({ token: "test" });
    const paths: string[] = [];
    globalThis.fetch = async (url) => { paths.push(String(url)); throw new Error("connection lost"); };
    await expect(createReplacementJob({ id: "fixed", source: "video", image: "image", model: "wan30-720p", resolution: "720", seconds: "15", prompt: "", subtitles: true, subtitleSize: 42, subtitleColor: "#ffffff" })).rejects.toThrow("connection lost");
    expect(paths).toEqual(["/api/v1/replacement-jobs"]);
});

test("start and manual retry send their separately confirmed budgets", async () => {
    useUserStore.setState({ token: "test" });
    const requests: unknown[] = [];
    globalThis.fetch = async (url, options) => {
        requests.push([String(url), JSON.parse(String(options?.body))]);
        return new Response(JSON.stringify({ code: 0, data: {} }));
    };
    const job = { id: "saved-job", credits: 588 } as Parameters<typeof startReplacementJob>[0];
    await startReplacementJob(job);
    await retryReplacementPart(job, 1, 210);
    expect(requests).toEqual([
        ["/api/v1/replacement-jobs/saved-job/start", { expectedCredits: 588 }],
        ["/api/v1/replacement-jobs/saved-job/retry", { part: 1, expectedCredits: 210 }],
    ]);
});

test("logged out clients cannot access server jobs", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("unexpected network"); };
    await expect(listReplacementJobs()).rejects.toThrow("请登录");
    expect(calls).toBe(0);
});

test("continuation explicitly approves the preview that was displayed", async () => {
    useUserStore.setState({ token: "test" });
    const requests: unknown[] = [];
    globalThis.fetch = async (url, options) => {
        requests.push([String(url), JSON.parse(String(options?.body))]);
        return new Response(JSON.stringify({ code: 0, data: {} }));
    };
    const job = { id: "preview-job", credits: 1200, previewResult: "first-preview.mp4" } as Parameters<typeof startReplacementJob>[0];
    await startReplacementJob(job);
    await startReplacementJob(job, true);
    expect(requests).toEqual([
        ["/api/v1/replacement-jobs/preview-job/start", { expectedCredits: 1200 }],
        ["/api/v1/replacement-jobs/preview-job/start", { expectedCredits: 1200, approvePreview: true, previewResult: "first-preview.mp4" }],
    ]);
});

test("selected aspect is included in planning and an existing job is replanned without paid start", async () => {
    useUserStore.setState({ token: "test" });
    const requests: unknown[] = [];
    globalThis.fetch = async (url, options) => {
        requests.push([String(url), JSON.parse(String(options?.body))]);
        return new Response(JSON.stringify({ code: 0, data: {} }));
    };
    await createReplacementJob({ id: "new", source: "video", image: "image", model: "h3-video", resolution: "768", seconds: "15", aspectRatio: "9:16", prompt: "", subtitles: false, subtitleSize: 42, subtitleColor: "#ffffff" });
    await setReplacementAspectRatio("old", "3:4");
    expect(requests).toEqual([
        ["/api/v1/replacement-jobs", { id: "new", source: "video", image: "image", model: "h3-video", resolution: "768", seconds: "15", aspectRatio: "9:16", prompt: "", subtitles: false, subtitleSize: 42, subtitleColor: "#ffffff" }],
        ["/api/v1/replacement-jobs/old/set-aspect-ratio", { aspectRatio: "3:4" }],
    ]);
});
