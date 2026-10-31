import { expect, test } from "bun:test";
import type { ModelManagement } from "../src/services/api/model-management";
import { channelModelDependencies } from "../src/app/(admin)/admin/models/model-management-options";

const management: ModelManagement = {
    enabled: true,
    revision: 3,
    routes: [
        { id: "route_grok", channelId: 14, model: "grok-imagine-video", adapter: "video.relay", capability: "video", operations: ["video"], enabled: true },
        { id: "route_other", channelId: 15, model: "grok-imagine-video", adapter: "video.relay", capability: "video", operations: ["video"], enabled: false },
    ],
    models: [
        { id: "model_video", internalName: "", displayName: "Grok 视频", displayMode: "alias", description: "", enabled: true, routeIds: ["route_grok"], pricing: { configured: true, free: false, credits: 10 } },
    ],
    bindings: [
        { featureId: "video.generate", modelId: "model_video", routeIds: ["route_grok"], enabled: true, default: true, order: 0 },
    ],
};

test("channel model dependencies are scoped to the exact channel and real model", () => {
    expect(channelModelDependencies(management, 14, "grok-imagine-video")).toEqual([
        { routeId: "route_grok", enabled: true, platformModels: ["Grok 视频"], features: ["video.generate"] },
    ]);
    expect(channelModelDependencies(management, 14, "retired-model")).toEqual([]);
    expect(channelModelDependencies(undefined, 14, "grok-imagine-video")).toEqual([]);
});
