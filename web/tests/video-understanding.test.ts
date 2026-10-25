import { afterEach, expect, test } from "bun:test";
import type { PublicManagedCatalog } from "../src/services/api/model-management";

if (!globalThis.localStorage) {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => memory.set(key, value),
        removeItem: (key: string) => memory.delete(key),
    } });
}
const { configForFeature, defaultConfig, managedEffectiveConfig, useConfigStore } = await import("../src/stores/use-config-store");
const { useUserStore } = await import("../src/stores/use-user-store");
const { requestVideoUnderstanding, videoAnalysisAvailable, videoAnalysisConfig, VIDEO_ANALYSIS_FEATURE } = await import("../src/services/api/video-understanding");
const { viralAnalysisMode, viralInput } = await import("../src/pages/video-tool/viral-recreate-request");
const { emptyVideoDraft } = await import("../src/types/video-workbench");

const catalog: PublicManagedCatalog = {
    enabled: true, revision: 41, features: [],
    models: [
        { id: "model_native", label: "视频分析", description: "", capability: "text" },
        { id: "model_script", label: "脚本", description: "", capability: "text" },
    ],
    bindings: [
        { featureId: VIDEO_ANALYSIS_FEATURE, modelId: "model_native", available: true, default: true, order: 0, operations: ["video-understand"], adapter: "text.gemini-video", credits: 7 },
        ...["viral-recreate.script", "viral-recreate.analyze"].map((featureId) => ({ featureId, modelId: "model_script", available: true, default: true, order: 0, operations: ["text"], adapter: "text.openai", credits: 3 })),
    ],
};
const config = managedEffectiveConfig({ ...defaultConfig, channelMode: "remote" }, catalog, { text: "viral-recreate.script" });
const originalFetch = globalThis.fetch, originalReader = globalThis.FileReader;
const originalUser = useUserStore.getState(), originalConfig = useConfigStore.getState();
afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalReader;
    useUserStore.setState(originalUser);
    useConfigStore.setState(originalConfig);
});

test("native video binding is independent of script/image analysis and never inferred from a label", () => {
    expect(videoAnalysisAvailable(config)).toBe(true);
    expect(videoAnalysisConfig(config).textModel).toBe("remote::model_native");
    expect(config.textModel).toBe("remote::model_script");
    expect(configForFeature(config, "viral-recreate.analyze", "text").textModel).toBe("remote::model_script");
    const unsupported = { ...config, managed: { ...catalog, bindings: catalog.bindings.map((b) => ({ ...b, adapter: "text.openai" })) } };
    expect(videoAnalysisAvailable(unsupported)).toBe(false);
    const draft = emptyVideoDraft("viral-recreate");
    expect(viralAnalysisMode(draft, config)).toBe("video");
    expect(viralAnalysisMode(draft, unsupported)).toBe("frames");
    expect(viralAnalysisMode({ ...draft, viralAnalysisMode: "video" }, unsupported)).toBe("video");
    expect(viralAnalysisMode({ ...draft, viralAnalysisMode: "frames" }, config)).toBe("frames");
    expect(viralInput(draft, config).viralAnalysisMode).toBe("video");
    expect(videoAnalysisAvailable({ ...config, channelMode: "local" })).toBe(false);
});

test("video bytes, signed quote and feature go to native analysis without a worker or responses call", async () => {
    const calls: string[] = [];
    const reader = class {
        result = "data:video/mp4;base64,dmlkZW8=";
        onload?: () => void;
        readAsDataURL() { this.onload?.(); }
    };
    globalThis.FileReader = reader as unknown as typeof FileReader;
    useUserStore.setState({ token: "native-test", hydrateUser: async () => {} });
    let submitted = false;
    globalThis.fetch = async (url, init) => {
        const path = String(url);
        calls.push(path);
        if (path === "/api/v1/models/quote") return new Response(JSON.stringify({ code: 0, data: { credits: 7, quoteToken: "native-proof", calculation: "7 点" } }));
        if (path.startsWith("data:")) return new Response("video", { headers: { "Content-Type": "video/mp4" } });
        expect(path).toBe("/api/v1/video-understanding");
        expect(submitted).toBe(true);
        const headers = init?.headers as Record<string, string>;
        expect(headers).toMatchObject({ "X-Model-Feature": VIDEO_ANALYSIS_FEATURE, "X-Model-Revision": "41", "X-Model-Quote": "native-proof", "X-Expected-Credits": "7", Authorization: "Bearer native-test" });
        expect(JSON.parse(String(init?.body))).toEqual({ model: "model_native", prompt: "分析声音和动作", video: { mimeType: "video/mp4", data: "dmlkZW8=" } });
        return new Response(JSON.stringify({ code: 0, data: { text: "00:00 人物转身" } }));
    };
    const text = await requestVideoUnderstanding(config, { url: "data:video/mp4;base64,dmlkZW8=", storageKey: "", mimeType: "video/mp4", bytes: 5, width: 100, height: 100 }, "分析声音和动作", new AbortController().signal, () => { submitted = true; });
    expect(text).toBe("00:00 人物转身");
    expect(calls).toEqual(["/api/v1/models/quote", "data:video/mp4;base64,dmlkZW8=", "/api/v1/video-understanding"]);
});

test("retired video analysis cannot silently fall back or send data", async () => {
    const missing = { ...config, managed: { ...catalog, revision: 42, bindings: [] } };
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("unexpected"); };
    await expect(requestVideoUnderstanding(missing, { url: "data:video/mp4;base64,dmlkZW8=", storageKey: "", mimeType: "video/mp4", bytes: 5, width: 100, height: 100 }, "分析", new AbortController().signal)).rejects.toThrow("没有可用");
    expect(calls).toBe(0);
});
