import { apiGet, apiPost } from "./request";
import type { AdminModelChannel, AdminReplicatePricing, VideoModelProfile } from "./admin";
import { modelOptionName, modelRequestHeaders, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export type ModelFeature = { id: string; module: string; label: string; capability: string; operations: string[] };
export type ManagedRoute = { id: string; channelId: number; model: string; version?: string; adapter: string; capability: string; operations: string[]; enabled: boolean; video?: VideoModelProfile };
export type ManagedPricing = { configured: boolean; free: boolean; credits: number; video?: VideoModelProfile; replicate?: AdminReplicatePricing };
export type ManagedModel = { id: string; internalName: string; displayName: string; displayMode: "alias" | "real" | "both"; description: string; enabled: boolean; routeIds: string[]; pricing: ManagedPricing };
export type FeatureBinding = { featureId: string; modelId: string; routeIds: string[]; enabled: boolean; default: boolean; order: number; resolutions?: string[]; seconds?: string[] };
export type ModelManagement = { enabled: boolean; revision: number; routes: ManagedRoute[]; models: ManagedModel[]; bindings: FeatureBinding[] };
export type PublicManagedCatalog = {
    enabled: boolean; revision: number; features: ModelFeature[];
    models: { id: string; label: string; description: string; capability: string }[];
    bindings: { featureId: string; modelId: string; default: boolean; order: number; available: boolean; reason?: string; operations: string[]; adapter: string; video?: VideoModelProfile; credits: number }[];
};
export const fetchModelManagement = (token: string) => apiGet<{ management: ModelManagement | null; features: ModelFeature[]; channels: AdminModelChannel[] }>("/api/admin/model-management", undefined, token);
export const previewModelManagement = (token: string) => apiPost<{ management: ModelManagement; warnings: string[] }>("/api/admin/model-management/preview", {}, token);
export const saveModelManagement = (token: string, value: ModelManagement) => apiPost<ModelManagement>("/api/admin/model-management", value, token);

type FixedQuote = { credits: number; calculation: string; quoteToken: string };
const fixedQuotes = new Map<string, FixedQuote>();
export async function quoteManagedFixed(config: AiConfig, capability: ModelCapability, count = 1, signal?: AbortSignal) {
    const headers = modelRequestHeaders(config,capability);
    const { token, user } = useUserStore.getState();
    const key = JSON.stringify([token,user?.group,headers,modelOptionName(config.model),count]);
    const cached = fixedQuotes.get(key);
    if (cached) return cached;
    const response = await fetch("/api/v1/models/quote", {method:"POST",headers:{...headers,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({model:modelOptionName(config.model),count}),signal});
    const result = await response.json();
    if (!response.ok || result.code !== 0 || !result.data?.quoteToken) throw new Error(result.msg || "模型报价读取失败");
    fixedQuotes.set(key,result.data);
    return result.data as FixedQuote;
}
export async function managedFixedHeaders(config: AiConfig, capability: ModelCapability, count = 1, signal?: AbortSignal) {
    if (!config.managed?.enabled || config.channelMode !== "remote") return {};
    const quote = await quoteManagedFixed(config,capability,count,signal);
    return {"X-Model-Quote":quote.quoteToken,"X-Expected-Credits":String(quote.credits)};
}
