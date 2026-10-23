import { afterEach, beforeEach, expect, mock, test } from "bun:test";

let incompatible: Blob | undefined;
let sequence = 0;
let saved: any;
const stored: { blob: Blob; key: string }[] = [];
const calls: { path: string; init?: RequestInit }[] = [];
const media = (storageKey: string) => ({ storageKey, url: `blob:${storageKey}`, bytes: 8, mimeType: "video/mp4" });
mock.module("../src/services/file-storage", () => ({
    getMediaBlob: async () => new Blob(["original"], { type: "video/mp4" }),
    readPlayableVideoMeta: async (blob: Blob) => {
        if (blob === incompatible) throw new Error("unsupported codec");
        return { width: 720, height: 1280, durationMs: 1000 };
    },
    uploadMediaFile: async (blob: Blob) => {
        const key = `media:${++sequence}`;
        stored.push({ blob, key });
        return media(key);
    },
}));
mock.module("../src/services/image-storage", () => ({ uploadImage: async () => ({}), imageToDataUrl: async () => "" }));
mock.module("../src/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ token: "session" }) } }));
mock.module("../src/services/api/video", () => ({ VIDEO_ACTIVE_POLL_INTERVAL_MS: 0 }));
mock.module("../src/services/video-reference-retention", () => ({
    trackTemporaryVideo: async (file: object) => ({ ...file, referenceId: "reference-id" }),
    registerTemporaryReferenceCopy: async (_id: string, file: object) => ({ ...file, referenceId: "reference-id" }),
    temporaryReferenceHeaders: async (file: { referenceId?: string }) => file.referenceId ? { "X-Video-Reference-ID": file.referenceId } : {},
    readVideoReferenceRetention: async () => saved,
    updateVideoReferenceRetention: async () => {},
    saveAnalysisReference: async (_id: string, sourceKey: string, analysis: object) => { saved = { analysisSourceKey: sourceKey, analysis }; },
}));
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://localhost" }, setTimeout } });
const { analysisReferenceVideo, storeTemporaryWorkbenchVideo } = await import("../src/services/api/video-worker");
const originalFetch = globalThis.fetch;
const worker = { url: "/api/v1/video-worker", token: "" };
beforeEach(() => {
    sequence = 0;
    stored.length = 0;
    calls.length = 0;
    saved = undefined;
    incompatible = undefined;
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
        if (String(url).startsWith("blob:")) return new Response(incompatible);
        const path = new URL(String(url)).pathname.replace("/api/v1/video-worker/", "");
        calls.push({ path, init });
        if (path === "health") return Response.json({ capabilities: [{ name: "compose", available: true }, { name: "analysis-proxy", available: true }] });
        if (path === "media" && init?.method === "POST") return Response.json({ id: "source.mp4" });
        if (path === "jobs" && init?.method === "POST") return Response.json({ id: "job", status: "running" });
        if (path === "jobs/job") return Response.json({ id: "job", status: "completed", result: { file: "copy.mp4" } });
        if (path === "media/copy.mp4/temporary") return Response.json({ id: "copy.mp4" });
        if (path === "media/copy.mp4") return new Response(new Blob(["compatible"], { type: "video/mp4" }), { headers: { "X-Video-Reference-ID": "reference-id" } });
        throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

test("codec conversion preserves the raw original and enrolls both worker input and compatibility output", async () => {
    const original = incompatible = new Blob(["raw-original"], { type: "video/mp4" });
    const file = await storeTemporaryWorkbenchVideo(worker, original, "reference.mp4", { compatible: true });
    expect(stored).toHaveLength(2);
    expect(stored[0].blob).toBe(original);
    expect(await stored[0].blob.text()).toBe("raw-original");
    expect(await stored[1].blob.text()).toBe("compatible");
    expect(file.storageKey).toBe(stored[1].key);
    expect(file.referenceId).toBe("reference-id");
    const upload = calls.find((call) => call.path === "media")!;
    expect(upload.init?.headers).toMatchObject({ "X-Video-Reference-ID": "reference-id" });
    expect(JSON.parse(String(calls.find((call) => call.path === "jobs")?.init?.body)).options).toEqual({ referenceCompatibility: true });
    expect(calls.some((call) => call.path.endsWith("/temporary"))).toBe(true);
});

test("playable imports keep a single original and do not create worker jobs", async () => {
    const original = new Blob(["playable"], { type: "video/mp4" });
    const file = await storeTemporaryWorkbenchVideo(worker, original, "reference.mp4", { compatible: true });
    expect(stored).toHaveLength(1);
    expect(file.storageKey).toBe(stored[0].key);
    expect(calls).toHaveLength(0);
});

test("analysis reuses only a proxy for the exact source, regenerating it after a trim", async () => {
    saved = { analysisSourceKey: "media:original", analysis: media("media:cached-proxy") };
    const original = { ...media("media:original"), referenceId: "reference-id" };
    expect((await analysisReferenceVideo(worker, original, new AbortController().signal)).storageKey).toBe("media:cached-proxy");
    expect(calls).toHaveLength(0);
    await analysisReferenceVideo(worker, { ...original, storageKey: "media:trim" }, new AbortController().signal);
    expect(saved.analysisSourceKey).toBe("media:trim");
    expect(JSON.parse(String(calls.find((call) => call.path === "jobs")?.init?.body)).operation).toBe("analysis-proxy");
});
