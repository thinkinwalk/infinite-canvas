import { expect, test } from "bun:test";
import type { AdminModelChannel } from "../src/services/api/admin";
import type { FeatureBinding, ManagedModel, ManagedRoute } from "../src/services/api/model-management";
import { compatiblePlatformModels, modelAdapterOptionsForChannel, modelMatchesSearch, modelSetupState, unregisteredChannelModels, videoProfileCanActivate, videoProfileWithoutLegacyPricing } from "../src/app/(admin)/admin/models/model-management-options";

const channels: AdminModelChannel[] = [
    { id: 2, name: "Gemini", protocol: "openai", baseUrl: "", apiKey: "", models: ["gemini-video", "gemini-video"], weight: 1, enabled: true, remark: "", allowedGroups: [] },
    { id: 3, name: "Disabled", protocol: "openai", baseUrl: "", apiKey: "", models: ["text-model"], weight: 1, enabled: false, remark: "", allowedGroups: [] },
];
const route: ManagedRoute = { id: "route_video", channelId: 2, model: "gemini-video", adapter: "text.gemini-video", capability: "text", operations: ["video-understand"], enabled: true };
const model: ManagedModel = { id: "model_video", internalName: "Gemini / gemini-video", displayName: "视频分析", displayMode: "alias", description: "", enabled: true, routeIds: [route.id], pricing: { configured: true, free: false, credits: 8 } };
const binding: FeatureBinding = { featureId: "viral-recreate.video-analyze", modelId: model.id, routeIds: [route.id], enabled: true, default: true, order: 0 };

test("unregistered channel models are de-duplicated per channel and real model identity", () => {
    expect(unregisteredChannelModels(channels, [route])).toEqual([{ channelId: 3, channelName: "Disabled", model: "text-model", channelEnabled: false }]);
});

test("model status names the first missing setup step", () => {
    expect(modelSetupState({ ...model, enabled: false }, [route], channels, [binding])).toBe("平台模型停用");
    expect(modelSetupState({ ...model, pricing: { ...model.pricing, configured: false } }, [route], channels, [binding])).toBe("待定价");
    expect(modelSetupState(model, [{ ...route, enabled: false }], channels, [binding])).toBe("接入停用");
    expect(modelSetupState(model, [route], channels, [])).toBe("未绑定功能");
    expect(modelSetupState(model, [route], channels, [binding])).toBe("已配置");
});

test("model search includes the real upstream ID and channel name", () => {
    expect(modelMatchesSearch(model, [route], channels, "gemini-video")).toBe(true);
    expect(modelMatchesSearch(model, [route], channels, "Gemini")).toBe(true);
    expect(modelMatchesSearch(model, [route], channels, "not-found")).toBe(false);
});

test("adapter choices follow the channel protocol and registered cloud model", () => {
    const cloudChannel: AdminModelChannel = {
        id: 4,
        name: "Replicate",
        protocol: "replicate",
        baseUrl: "",
        apiKey: "",
        models: ["wan-video/wan-2.2-t2v-fast", "wan-video/wan-2.7-videoedit"],
        weight: 1,
        enabled: true,
        remark: "",
        allowedGroups: [],
    };
    const openAIAdapters = modelAdapterOptionsForChannel(channels, 2);
    const cloudAdapters = modelAdapterOptionsForChannel([cloudChannel], 4);
    expect(openAIAdapters.some((option) => option.value === "text.openai")).toBe(true);
    expect(openAIAdapters.some((option) => option.value.startsWith("cloud:"))).toBe(false);
    expect(cloudAdapters.map((option) => option.value)).toEqual(["cloud:text-to-video", "cloud:video-edit", "cloud:subtitle-remove"]);
});

test("existing platform model choices require every linked route to share the same identity", () => {
    const secondRoute = { ...route, id: "route_other_channel", channelId: 3, adapter: "text.openai" };
    const splitModel = { ...model, routeIds: [route.id, secondRoute.id] };
    expect(compatiblePlatformModels([model], [route], route)).toEqual([model]);
    expect(compatiblePlatformModels([splitModel], [route, secondRoute], route)).toEqual([]);
});

test("video routes need valid shared specs and at least one usable input mode", () => {
    const profile = {
        displayName: "Wan",
        description: "",
        interface: "relay" as const,
        maxImages: 1,
        maxVideos: 0,
        maxAudios: 0,
        resolutions: ["720"],
        seconds: ["5"],
        generateAudio: false,
        inputModes: ["first_last"],
        firstFrameField: "first_frame",
        lastFrameField: "last_frame",
    };
    expect(videoProfileCanActivate(profile, "video.wan30")).toBe(true);
    expect(videoProfileCanActivate({ ...profile, inputModes: ["first_last"], lastFrameField: "" }, "video.wan30")).toBe(false);
    expect(videoProfileCanActivate({ ...profile, inputModes: ["reference", "first_last"], lastFrameField: "" }, "video.wan30")).toBe(false);
    expect(videoProfileCanActivate({ ...profile, inputModes: ["reference", "reference"] }, "video.wan30")).toBe(false);
    expect(videoProfileCanActivate({ ...profile, inputModes: undefined }, "video.wan30")).toBe(true);
    expect(videoProfileCanActivate({ ...profile, seconds: ["0"] }, "video.wan30")).toBe(false);
    expect(videoProfileWithoutLegacyPricing({ ...profile, billingMode: "duration_resolution", unitCredits: 10, minimumCredits: 20, billingTiers: { "720": 5 } })).toMatchObject({
        resolutions: ["720"],
        seconds: ["5"],
    });
    expect(videoProfileWithoutLegacyPricing({ ...profile, inputModes: undefined })).toMatchObject({ inputModes: ["reference"] });
    expect(videoProfileWithoutLegacyPricing({ ...profile, billingMode: "duration_resolution", unitCredits: 10, minimumCredits: 20, billingTiers: { "720": 5 } })).not.toHaveProperty("billingTiers");
});
