import { expect, test } from "bun:test";
import type { ModelManagement } from "../src/services/api/model-management";
import { channelModelDependencies, removeChannelModelRoutes } from "../src/app/(admin)/admin/models/model-management-options";

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

test("removing channel routes preserves alternate access and disables orphaned models and bindings", () => {
    const withAlternateRoute: ModelManagement = {
        ...management,
        routes: [...management.routes, { id: "route_alternate", channelId: 16, model: "grok-imagine-video", adapter: "video.relay", capability: "video", operations: ["video"], enabled: true }],
        models: [
            { ...management.models[0], routeIds: ["route_grok", "route_alternate"] },
            { id: "model_orphan", internalName: "", displayName: "孤立模型", displayMode: "alias", description: "", enabled: true, routeIds: ["route_grok"], pricing: { configured: true, free: false, credits: 10 } },
        ],
        bindings: [
            { ...management.bindings[0], routeIds: ["route_grok", "route_alternate"] },
            { featureId: "video.edit", modelId: "model_orphan", routeIds: ["route_grok"], enabled: true, default: false, order: 1 },
        ],
    };

    const result = removeChannelModelRoutes(withAlternateRoute, ["route_grok"]);

    expect(result.routes.map((route) => route.id)).toEqual(["route_other", "route_alternate"]);
    expect(result.models[0]).toMatchObject({ routeIds: ["route_alternate"], enabled: true });
    expect(result.models[1]).toMatchObject({ routeIds: [], enabled: false });
    expect(result.bindings[0]).toMatchObject({ routeIds: ["route_alternate"], enabled: true, default: true });
    expect(result.bindings[1]).toMatchObject({ routeIds: [], enabled: false, default: false });
    expect(withAlternateRoute.routes).toHaveLength(3);
    expect(removeChannelModelRoutes(withAlternateRoute, [])).toBe(withAlternateRoute);
});
