import type { AdminModelChannel, VideoModelProfile } from "@/services/api/admin";
import type { FeatureBinding, ManagedModel, ManagedRoute, ModelManagement } from "@/services/api/model-management";

export type ChannelModelDependency = { routeId: string; enabled: boolean; platformModels: string[]; features: string[] };

export function channelModelDependencies(management: ModelManagement | undefined, channelId: number, modelName: string): ChannelModelDependency[] {
    if (!management) return [];
    return management.routes
        .filter((route) => route.channelId === channelId && route.model === modelName)
        .map((route) => ({
            routeId: route.id,
            enabled: route.enabled,
            platformModels: management.models.filter((entry) => entry.routeIds.includes(route.id)).map((entry) => entry.displayName),
            features: management.bindings.filter((binding) => binding.routeIds.includes(route.id)).map((binding) => binding.featureId),
        }));
}

export const modelAdapterOptions = [
    ["text.openai", "文字 · OpenAI"],
    ["text.gemini-video", "视频理解 · Gemini 原生"],
    ["image.openai", "图片 · OpenAI"],
    ["image.responses", "图片 · Responses"],
    ["audio.openai", "音频 · OpenAI"],
    ["video.openai", "视频 · OpenAI"],
    ["video.relay", "视频 · JSON 中转"],
    ["video.ark", "视频 · 火山多素材"],
    ["video.sparkcine_h3", "视频 · SparkCine H3"],
    ["video.wan30", "视频 · Wan30"],
    ["video.h3-2k", "视频 · H3 2K"],
    ["video.minimax-h3", "视频 · MiniMax H3"],
    ["video.minimax-h3-frames", "视频 · MiniMax H3 首尾帧"],
    ...["text-to-video", "image-to-video", "hailuo-video", "speech", "transcribe", "digital-human", "lipsync", "replace-person", "head-swap", "upscale", "video-edit", "subtitle-remove", "masked-edit", "cutout-replicate", "upscale-replicate"].map(
        (operation) => [`cloud:${operation}`, `专用接口 · ${operation}`],
    ),
].map(([value, label]) => ({ value, label }));

export function modelAdapterOptionsForChannel(channels: AdminModelChannel[], channelId: number, model?: string) {
    const channel = channels.find((entry) => entry.id === channelId);
    if (!channel) return modelAdapterOptions;
    const cloud = channel.protocol === "replicate" || channel.protocol === "wavespeed";
    const cloudAdapterModels: Record<string, string> = {
        "cloud:text-to-video": "wan-video/wan-2.2-t2v-fast",
        "cloud:image-to-video": "wan-video/wan-2.2-i2v-fast",
        "cloud:hailuo-video": "minimax/hailuo-2.3",
        "cloud:speech": "qwen/qwen3-tts",
        "cloud:transcribe": "vaibhavs10/incredibly-fast-whisper",
        "cloud:digital-human": "wan-video/wan-2.2-s2v",
        "cloud:lipsync": "sync/lipsync-2",
        "cloud:replace-person": "wan-video/wan-2.2-animate-replace",
        "cloud:head-swap": "wavespeed-ai/video-head-swap",
        "cloud:upscale": "topazlabs/video-upscale",
        "cloud:video-edit": "wan-video/wan-2.7-videoedit",
        "cloud:subtitle-remove": "wan-video/wan-2.7-videoedit",
        "cloud:masked-edit": "prunaai/vace-14b",
        "cloud:cutout-replicate": "men1scus/birefnet",
        "cloud:upscale-replicate": "nightmareai/real-esrgan",
    };
    return modelAdapterOptions.filter((option) => {
        if (option.value.startsWith("cloud:") !== cloud) return false;
        if (!cloud) return true;
        const expectedModel = cloudAdapterModels[option.value];
        return !!expectedModel && channel.models.includes(expectedModel) && (!model || expectedModel === model);
    });
}

export function adapterRouteDefaults(adapter: string) {
    const capability = adapter.startsWith("cloud:") ? (["speech", "transcribe"].includes(adapter.slice(6)) ? "audio" : adapter.endsWith("-replicate") ? "image" : "video") : adapter.split(".")[0] || "text";
    const operation = adapter === "text.gemini-video" ? "video-understand" : adapter.startsWith("cloud:") ? adapter.slice(6) : capability;
    return { capability, operations: [operation] };
}

export function compatiblePlatformModels(models: ManagedModel[], routes: ManagedRoute[], identity: Pick<ManagedRoute, "model" | "adapter" | "version">) {
    return models.filter(
        (entry) =>
            entry.routeIds.length > 0 &&
            entry.routeIds.every((id) => {
                const route = routes.find((item) => item.id === id);
                return route?.model === identity.model && route.adapter === identity.adapter && (route.version || "") === (identity.version || "");
            }),
    );
}

export function videoProfileCanActivate(profile: VideoModelProfile | undefined, adapter: string) {
    if (!profile || !adapter.startsWith("video.")) return false;
    const adapterName = adapter.slice(6);
    const expectedInterface = adapterName === "wan30" || adapterName === "h3-2k" || adapterName.startsWith("minimax-h3") ? "relay" : adapterName;
    const validField = (value?: string) => {
        const reserved = new Set(["model", "prompt", "seconds", "duration", "resolution", "content", "input_mode", "mode", "reference_image_urls", "reference_videos", "audio_urls"]);
        return !!value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !reserved.has(value);
    };
    const modes = profile.inputModes ?? ["reference"];
    const validModes = modes.filter(
        (mode) =>
            mode === "reference" ||
            (mode === "first_frame_only" && validField(profile.firstFrameField)) ||
            (mode === "first_last" && validField(profile.firstFrameField) && validField(profile.lastFrameField) && profile.firstFrameField !== profile.lastFrameField),
    );
    const hasValidMode = modes.length > 0 && validModes.length === modes.length && new Set(modes).size === modes.length;
    return (
        profile.interface === expectedInterface &&
        profile.resolutions.length > 0 &&
        profile.seconds.length > 0 &&
        profile.seconds.every((seconds) => Number.isFinite(Number(seconds)) && Number(seconds) > 0) &&
        profile.maxImages >= 0 &&
        profile.maxVideos >= 0 &&
        profile.maxAudios >= 0 &&
        hasValidMode
    );
}

export function videoProfileWithoutLegacyPricing(profile: VideoModelProfile | undefined) {
    if (!profile) return undefined;
    const { billingMode, unitCredits, minimumCredits, billingTiers, ...capabilities } = profile;
    return { ...capabilities, inputModes: capabilities.inputModes?.length ? [...new Set(capabilities.inputModes)] : ["reference"] };
}

export function unregisteredChannelModels(channels: AdminModelChannel[], routes: ManagedRoute[]) {
    const registered = new Set(routes.map((route) => `${route.channelId}\u0000${route.model}`));
    return channels.flatMap((channel) =>
        [...new Set(channel.models || [])].filter((model) => model && !registered.has(`${channel.id}\u0000${model}`)).map((model) => ({ channelId: channel.id, channelName: channel.name, model, channelEnabled: channel.enabled })),
    );
}

export function modelSetupState(entry: ManagedModel, routes: ManagedRoute[], channels: AdminModelChannel[], bindings: FeatureBinding[]) {
    if (!entry.pricing.configured) return "待定价";
    const linkedRoutes = routes.filter((route) => entry.routeIds.includes(route.id));
    if (!linkedRoutes.length) return "未配置接入";
    const activeChannels = linkedRoutes.filter((route) => channels.some((channel) => channel.id === route.channelId && channel.enabled));
    if (!activeChannels.length) return "渠道停用";
    const activeRoutes = activeChannels.filter((route) => route.enabled);
    if (!activeRoutes.length) return "接入停用";
    if (!entry.enabled) return "平台模型停用";
    if (!bindings.some((binding) => binding.modelId === entry.id && binding.enabled && binding.routeIds.some((id) => activeRoutes.some((route) => route.id === id)))) return "未绑定功能";
    return "已配置";
}

export function modelMatchesSearch(entry: ManagedModel, routes: ManagedRoute[], channels: AdminModelChannel[], keyword: string) {
    const query = keyword.trim().toLowerCase();
    if (!query) return true;
    if (`${entry.displayName} ${entry.internalName} ${entry.id} ${entry.description}`.toLowerCase().includes(query)) return true;
    return routes.some((route) => entry.routeIds.includes(route.id) && `${route.model} ${channels.find((channel) => channel.id === route.channelId)?.name || ""}`.toLowerCase().includes(query));
}
