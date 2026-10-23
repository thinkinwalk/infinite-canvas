import { ModelPicker } from "@/components/model-picker";
import { configForFeature, useConfigStore, useEffectiveConfig, type ModelCapability } from "@/stores/use-config-store";

export function FeatureModelPicker({ capability, featureId }: { capability: ModelCapability; featureId?: string }) {
    const config = useEffectiveConfig();
    if (!config.managed?.enabled || config.channelMode !== "remote") return null;
    const id = featureId || config.featureIds?.[capability] || "";
    const scoped = configForFeature(config,id,capability);
    return <ModelPicker config={scoped} capability={capability} value={scoped[`${capability}Model`]} fullWidth onChange={(value) => useConfigStore.setState((state) => ({featureModels:{...state.featureModels,[id]:value}}))} />;
}
