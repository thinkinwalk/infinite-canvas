import { expect, test } from "bun:test";
import type { AdminPublicSettings } from "../src/services/api/admin";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { createModelChannel, defaultConfig, resolveEffectiveConfig } = await import("../src/stores/use-config-store");

const hailuo = "replicate::minimax/hailuo-2.3";
const settings: AdminPublicSettings = {
    modelChannel: {
        availableModels: ["plain-text", "ordinary-video"], modelCosts: [], defaultModel: "plain-text", defaultTextModel: "plain-text", defaultImageModel: "", defaultVideoModel: "ordinary-video", systemPrompt: "", allowCustomChannel: true,
        models: [
            { model: "minimax/hailuo-2.3", label: "Hailuo", protocol: "replicate", capabilities: ["video"] },
            { model: "qwen/qwen3-tts", label: "配音", protocol: "replicate", capabilities: ["audio"] },
            { model: "wan-video/wan-2.7-videoedit", label: "编辑", protocol: "replicate", capabilities: ["video-processing"] },
            { model: "ordinary-video", label: "video", protocol: "openai", capabilities: ["video"] },
        ],
    },
    adminContact: { qq: "", note: "" }, auth: { allowRegister: true, linuxDo: { enabled: false } },
};

test("public model directory adds generation models without mixing processing or audio into video selection", () => {
    const config = resolveEffectiveConfig({ ...defaultConfig, channelMode: "remote", videoModel: hailuo }, settings);
    expect(config.videoModel).toBe(hailuo);
    expect(config.channels.find((item) => item.id === "replicate")?.models.map((item) => item.name)).toEqual(["minimax/hailuo-2.3"]);
    expect(config.channels.find((item) => item.id === "remote")?.models.some((item) => item.name === "minimax/hailuo-2.3")).toBe(false);
});

test("catalog refresh removes a disabled model and repairs an existing selection", () => {
    const current = resolveEffectiveConfig({ ...defaultConfig, channelMode: "remote", videoModel: hailuo }, settings);
    const next = resolveEffectiveConfig(current, { ...settings, modelChannel: { ...settings.modelChannel, models: [] } });
    expect(next.channels.some((item) => item.id === "replicate")).toBe(false);
    expect(next.models.includes(hailuo)).toBe(false);
    expect(next.videoModel).toBe("remote::ordinary-video");
});

test("local channel selection survives an updated platform catalog", () => {
    const channel = createModelChannel({ id: "local", baseUrl: "https://local.example", apiKey: "local-key", models: [{ name: "my-video", capability: "video" }] });
    const current = { ...defaultConfig, channelMode: "local" as const, channels: [channel], videoModel: "local::my-video" };
    const next = resolveEffectiveConfig(current, settings);
    expect(next.channelMode).toBe("local");
    expect(next.videoModel).toBe("local::my-video");
    expect(next.models.includes(hailuo)).toBe(true);
});

test("missing public settings preserve local models and remove unavailable platform models", () => {
    const channel = createModelChannel({ id: "local", baseUrl: "https://local.example", apiKey: "local-key", models: [{ name: "my-video", capability: "video" }] });
    const current = resolveEffectiveConfig({ ...defaultConfig, channelMode: "local", channels: [channel], videoModel: "local::my-video" }, settings);
    const next = resolveEffectiveConfig(current, null);
    expect(next.channelMode).toBe("local");
    expect(next.videoModel).toBe("local::my-video");
    expect(next.channels.find((item) => item.id === "local")).toEqual(channel);
    expect(next.channels.some((item) => item.id === "replicate")).toBe(false);
    expect(next.models).toEqual(["local::my-video"]);
});

test("video quotes identify the protocol even when providers use the same model name", async () => {
    const axios = (await import("axios")).default;
    const { quoteVideoModel } = await import("../src/services/api/video");
    const previous = axios.defaults.adapter;
    const protocols: string[] = [];
    axios.defaults.adapter = async (config) => {
        protocols.push(JSON.parse(String(config.data)).protocol);
        return { data: { code: 0, data: { credits: 10 } }, status: 200, statusText: "OK", headers: {}, config };
    };
    try {
        const config = { ...defaultConfig, channels: ["replicate", "remote"].map((id) => createModelChannel({ id, models: [{ name: "minimax/hailuo-2.3", capability: "video" }] })) };
        await quoteVideoModel(config, "replicate::minimax/hailuo-2.3");
        await quoteVideoModel(config, "remote::minimax/hailuo-2.3");
        expect(protocols).toEqual(["replicate", "openai"]);
    } finally {
        axios.defaults.adapter = previous;
    }
});
