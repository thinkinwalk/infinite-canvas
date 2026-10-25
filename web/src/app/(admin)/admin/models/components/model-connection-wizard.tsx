import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Drawer, Empty, Flex, Form, Input, InputNumber, Select, Space, Steps, Tag, Typography } from "antd";
import { ArrowLeft, ArrowRight, Check, Link2 } from "lucide-react";
import type { AdminModelChannel } from "@/services/api/admin";
import type { FeatureBinding, ManagedModel, ManagedRoute, ModelFeature } from "@/services/api/model-management";
import { adapterRouteDefaults, compatiblePlatformModels, modelAdapterOptionsForChannel, videoProfileCanActivate } from "../model-management-options";

export type ConnectionWizardSeed = {
    channelId?: number;
    model?: string;
};

export type ConnectionWizardDraft = {
    channelId: number;
    model: string;
    adapter: string;
    capability: string;
    operations: string[];
    version: string;
    platformModelId?: string;
    internalName: string;
    displayName: string;
    displayMode: ManagedModel["displayMode"];
    description: string;
    priceStatus: "unconfigured" | "free" | "fixed";
    credits: number;
    featureIds: string[];
    defaultFeatureIds: string[];
};

type Props = {
    open: boolean;
    channels: AdminModelChannel[];
    models: ManagedModel[];
    routes: ManagedRoute[];
    bindings: FeatureBinding[];
    features: ModelFeature[];
    initial?: ConnectionWizardSeed;
    onCancel: () => void;
    onApply: (draft: ConnectionWizardDraft) => void;
};

const channelName = (channels: AdminModelChannel[], id: number) => channels.find((channel) => channel.id === id)?.name || `渠道 ${id || "未选择"}`;
const routeFor = (routes: ManagedRoute[], channelId: number, model: string) => routes.find((route) => route.channelId === channelId && route.model === model);
function makeDraft(channels: AdminModelChannel[], routes: ManagedRoute[], initial?: ConnectionWizardSeed): ConnectionWizardDraft {
    const channelId = initial?.channelId || channels.find((channel) => channel.enabled)?.id || channels[0]?.id || 0;
    const model = initial?.model || channels.find((channel) => channel.id === channelId)?.models?.[0] || "";
    const route = routeFor(routes, channelId, model);
    const adapter = route?.adapter || modelAdapterOptionsForChannel(channels, channelId, model)[0]?.value || (channels.find((channel) => channel.id === channelId)?.protocol === "openai" ? "text.openai" : "");
    const defaults = adapterRouteDefaults(adapter);
    return {
        channelId,
        model,
        adapter,
        capability: route?.capability || defaults.capability,
        operations: route?.operations || defaults.operations,
        version: route?.version || "",
        internalName: model ? `${channelName(channels, channelId)} / ${model}` : "",
        displayName: model,
        displayMode: "real",
        description: "",
        priceStatus: "unconfigured",
        credits: 0,
        featureIds: [],
        defaultFeatureIds: [],
    };
}

export function ModelConnectionWizard({ open, channels, models, routes, bindings, features, initial, onCancel, onApply }: Props) {
    const [step, setStep] = useState(0);
    const [draft, setDraft] = useState(() => makeDraft(channels, routes, initial));
    const [nameTouched, setNameTouched] = useState(false);
    const existingRoute = routeFor(routes, draft.channelId, draft.model);
    const existingModels = useMemo(() => compatiblePlatformModels(models, routes, draft), [draft.adapter, draft.model, draft.version, models, routes]);
    const selectedExistingModel = models.find((entry) => entry.id === draft.platformModelId);
    const compatibleFeatures = features.filter((feature) => feature.capability === draft.capability && draft.operations.some((operation) => feature.operations.includes(operation)));
    const selectedChannel = channels.find((channel) => channel.id === draft.channelId);
    const requiresCloudPricing = draft.adapter.startsWith("cloud:") && !draft.adapter.endsWith("-replicate");
    const videoProfile = existingRoute?.video || selectedChannel?.videoModels?.[draft.model];
    const videoProfileReady = videoProfileCanActivate(videoProfile, draft.adapter);
    const routeWillBeEnabled = existingRoute?.enabled ?? Boolean(selectedChannel?.enabled && (draft.capability !== "video" || draft.adapter.startsWith("cloud:") || videoProfileReady));
    const modelCanBeEnabled = selectedExistingModel ? selectedExistingModel.enabled && selectedExistingModel.pricing.configured : draft.priceStatus !== "unconfigured" && !(requiresCloudPricing && draft.priceStatus === "fixed");
    const canSetDefault = (featureId: string) => {
        if (!modelCanBeEnabled) return false;
        const previousBinding = selectedExistingModel && bindings.find((binding) => binding.modelId === selectedExistingModel.id && binding.featureId === featureId);
        const hasActivePreviousRoute = previousBinding?.routeIds.some((id) => {
            const route = routes.find((entry) => entry.id === id);
            return route?.enabled && channels.some((channel) => channel.id === route.channelId && channel.enabled);
        });
        return Boolean(hasActivePreviousRoute || (routeWillBeEnabled && selectedChannel?.enabled));
    };

    useEffect(() => {
        if (!open) return;
        const next = makeDraft(channels, routes, initial);
        setStep(0);
        setDraft(next);
        setNameTouched(false);
    }, [open, initial?.channelId, initial?.model]);

    const patch = (value: Partial<ConnectionWizardDraft>) => setDraft((current) => ({ ...current, ...value }));
    const chooseChannel = (channelId: number) => {
        const model = channels.find((channel) => channel.id === channelId)?.models?.[0] || "";
        const route = routeFor(routes, channelId, model);
        const adapter = route?.adapter || modelAdapterOptionsForChannel(channels, channelId, model)[0]?.value || (channels.find((channel) => channel.id === channelId)?.protocol === "openai" ? "text.openai" : "");
        const defaults = adapterRouteDefaults(adapter);
        patch({
            channelId,
            model,
            adapter,
            capability: route?.capability || defaults.capability,
            operations: route?.operations || defaults.operations,
            version: route?.version || "",
            platformModelId: undefined,
            featureIds: [],
            defaultFeatureIds: [],
            displayName: model,
            internalName: model ? `${channelName(channels, channelId)} / ${model}` : "",
        });
        setNameTouched(false);
    };
    const chooseModel = (model: string) => {
        const route = routeFor(routes, draft.channelId, model);
        const cloudChannel = selectedChannel?.protocol === "replicate" || selectedChannel?.protocol === "wavespeed";
        const adapter = route?.adapter || (cloudChannel ? modelAdapterOptionsForChannel(channels, draft.channelId, model)[0]?.value || "" : draft.adapter);
        const defaults = adapterRouteDefaults(adapter);
        const nextName = nameTouched ? draft.displayName : model;
        patch({
            model,
            adapter: route?.adapter || adapter,
            capability: route?.capability || defaults.capability,
            operations: route?.operations || defaults.operations,
            version: route?.version || "",
            platformModelId: undefined,
            featureIds: [],
            defaultFeatureIds: [],
            displayName: nextName,
            internalName: `${channelName(channels, draft.channelId)} / ${model}`,
            ...(adapter.startsWith("cloud:") && !adapter.endsWith("-replicate") && draft.priceStatus === "fixed" ? { priceStatus: "unconfigured" as const } : {}),
        });
    };
    const chooseAdapter = (adapter: string) => {
        const defaults = adapterRouteDefaults(adapter);
        const requiresCloudPricing = adapter.startsWith("cloud:") && !adapter.endsWith("-replicate");
        patch({
            adapter,
            capability: defaults.capability,
            operations: defaults.operations,
            version: "",
            platformModelId: undefined,
            featureIds: [],
            defaultFeatureIds: [],
            ...(requiresCloudPricing && draft.priceStatus === "fixed" ? { priceStatus: "unconfigured" as const } : {}),
        });
    };
    const chooseFeatures = (featureIds: string[]) => {
        const eligible = featureIds.filter(canSetDefault);
        const previousDefaults = selectedExistingModel ? bindings.filter((binding) => binding.modelId === selectedExistingModel.id && binding.default && featureIds.includes(binding.featureId)).map((binding) => binding.featureId) : [];
        const defaults = [...new Set([...draft.defaultFeatureIds.filter((id) => eligible.includes(id)), ...previousDefaults.filter((id) => eligible.includes(id))])];
        patch({ featureIds, defaultFeatureIds: defaults.length ? defaults : eligible.length === 1 ? eligible : [] });
    };
    const choosePriceStatus = (priceStatus: ConnectionWizardDraft["priceStatus"]) =>
        patch({
            priceStatus,
            defaultFeatureIds: priceStatus === "unconfigured" || (requiresCloudPricing && priceStatus === "fixed") ? [] : draft.defaultFeatureIds.filter(canSetDefault),
        });
    const next = () => {
        if (step === 0 && (!draft.channelId || !draft.model || !draft.adapter)) return;
        if (step === 1 && !draft.platformModelId && draft.priceStatus === "fixed" && draft.credits <= 0) return;
        setStep((current) => Math.min(2, current + 1));
    };
    const finish = () => {
        if (draft.defaultFeatureIds.some((id) => !draft.featureIds.includes(id) || !canSetDefault(id))) return;
        onApply(draft);
    };

    return (
        <Drawer
            open={open}
            width="min(720px, 100vw)"
            title="接入模型向导"
            onClose={onCancel}
            extra={<Tag color="blue">只修改草稿，最后统一保存</Tag>}
            footer={
                <Flex justify="space-between" gap={8} wrap>
                    <Button icon={<ArrowLeft size={15} />} disabled={!step} onClick={() => setStep((current) => current - 1)}>
                        上一步
                    </Button>
                    <Space>
                        <Button onClick={onCancel}>取消</Button>
                        {step < 2 ? (
                            <Button
                                type="primary"
                                icon={<ArrowRight size={15} />}
                                onClick={next}
                                disabled={(step === 0 && (!draft.channelId || !draft.model || !draft.adapter)) || (step === 1 && !draft.platformModelId && draft.priceStatus === "fixed" && draft.credits <= 0)}
                            >
                                下一步
                            </Button>
                        ) : (
                            <Button type="primary" icon={<Check size={15} />} onClick={finish}>
                                加入模型管理草稿
                            </Button>
                        )}
                    </Space>
                </Flex>
            }
        >
            <Space direction="vertical" size={18} className="w-full">
                <Steps current={step} items={[{ title: "选择渠道模型" }, { title: "平台展示与价格" }, { title: "分配功能" }]} />
                {step === 0 && (
                    <Space direction="vertical" size={14} className="w-full">
                        <Alert type="info" showIcon message="渠道只提供上游连接和真实模型 ID；完成向导后，模型才会进入平台目录。" description="已有渠道模型可以直接关联现有平台模型；同一个真实模型在不同渠道的接入也会在这里集中管理。" />
                        {draft.channelId && !channels.find((channel) => channel.id === draft.channelId)?.models?.length && (
                            <Alert type="warning" showIcon message="该渠道还没有登记模型" description="先到“系统设置 → 渠道可用模型”添加或拉取真实模型 ID，保存渠道后再回来接入。" />
                        )}
                        <Form layout="vertical">
                            <Form.Item label="渠道" required>
                                <Select
                                    showSearch
                                    optionFilterProp="label"
                                    value={draft.channelId || undefined}
                                    onChange={chooseChannel}
                                    options={channels.map((channel) => ({ value: channel.id, label: `${channel.name || `渠道 ${channel.id}`} · ${channel.enabled ? "已启用" : "已停用"}`, disabled: !channel.id }))}
                                    placeholder="选择已保存的渠道"
                                />
                            </Form.Item>
                            <Form.Item
                                label="上游真实模型 ID"
                                required
                                extra={draft.channelId ? `${channelName(channels, draft.channelId)} 当前登记了 ${channels.find((channel) => channel.id === draft.channelId)?.models?.length || 0} 个模型` : "请先选择渠道"}
                            >
                                <Select
                                    showSearch
                                    optionFilterProp="label"
                                    value={draft.model || undefined}
                                    onChange={chooseModel}
                                    options={(channels.find((channel) => channel.id === draft.channelId)?.models || []).map((model) => ({ value: model, label: model }))}
                                    placeholder="选择渠道中已登记的模型"
                                />
                            </Form.Item>
                            <Form.Item label="调用适配器" required extra="适配器决定请求格式和可绑定的功能，不根据模型名称自动猜测。">
                                <Select showSearch optionFilterProp="label" disabled={!!existingRoute} value={draft.adapter || undefined} onChange={chooseAdapter} options={modelAdapterOptionsForChannel(channels, draft.channelId, draft.model)} />
                            </Form.Item>
                            <Flex gap={8} wrap>
                                <Tag>能力：{draft.capability}</Tag>
                                <Tag>操作：{draft.operations.join("、")}</Tag>
                                {existingRoute && <Tag color="green">渠道模型已登记，将复用该接入</Tag>}
                            </Flex>
                            {draft.capability === "video" && !draft.adapter.startsWith("cloud:") && !videoProfileReady && (
                                <Alert type="warning" showIcon message="视频规格尚未配置，接入将保持停用" description="先完成模型草稿，再到“渠道模型”视图编辑接入，配置清晰度、时长和输入方式后启用。" />
                            )}
                        </Form>
                    </Space>
                )}
                {step === 1 && (
                    <Space direction="vertical" size={14} className="w-full">
                        <Form layout="vertical">
                            <Form.Item label="平台模型关系">
                                <Select
                                    value={draft.platformModelId || "__new__"}
                                    onChange={(value) => patch({ platformModelId: value === "__new__" ? undefined : value, featureIds: [], defaultFeatureIds: [] })}
                                    options={[{ value: "__new__", label: "新建平台模型" }, ...existingModels.map((entry) => ({ value: entry.id, label: `${entry.displayName} · ${entry.internalName || entry.id}` }))]}
                                />
                            </Form.Item>
                            {selectedExistingModel ? (
                                <Alert type="success" showIcon icon={<Link2 size={16} />} message={`将关联现有平台模型：${selectedExistingModel.displayName}`} description="展示名、价格和启用状态沿用现有平台模型；本向导只增加渠道接入，避免重复创建。" />
                            ) : (
                                <Space direction="vertical" className="w-full">
                                    <Form.Item label="前台名称" required>
                                        <Input
                                            value={draft.displayName}
                                            onChange={(event) => {
                                                setNameTouched(true);
                                                patch({ displayName: event.target.value });
                                            }}
                                            placeholder="例如：Gemini 视频分析"
                                        />
                                    </Form.Item>
                                    <Flex gap={12} wrap>
                                        <Form.Item label="展示方式" className="min-w-[200px] flex-1">
                                            <Select
                                                value={draft.displayMode}
                                                onChange={(displayMode) => patch({ displayMode })}
                                                options={[
                                                    { value: "alias", label: "仅显示别名" },
                                                    { value: "real", label: "显示真实 ID" },
                                                    { value: "both", label: "别名与真实 ID" },
                                                ]}
                                            />
                                        </Form.Item>
                                        <Form.Item label="内部名称" className="min-w-[240px] flex-1">
                                            <Input value={draft.internalName} onChange={(event) => patch({ internalName: event.target.value })} />
                                        </Form.Item>
                                    </Flex>
                                    <Form.Item label="用途说明">
                                        <Input.TextArea rows={2} value={draft.description} onChange={(event) => patch({ description: event.target.value })} placeholder="说明模型适合哪些任务" />
                                    </Form.Item>
                                    <Form.Item
                                        label="价格状态"
                                        extra={requiresCloudPricing ? "专用云模型需配置对应计费单位或规格；向导不会套用固定点数，请先登记为待定价或明确免费。" : "待定价的模型会自动保持停用，不会出现在普通用户目录，也不会产生收费。"}
                                    >
                                        <Select
                                            value={draft.priceStatus}
                                            onChange={choosePriceStatus}
                                            options={[{ value: "unconfigured", label: "待定价" }, { value: "free", label: "明确免费" }, ...(!requiresCloudPricing ? [{ value: "fixed", label: "固定点数 / 次" }] : [])]}
                                        />
                                    </Form.Item>
                                    {draft.priceStatus === "fixed" && !requiresCloudPricing && (
                                        <Form.Item label="每次点数" required>
                                            <InputNumber min={1} precision={0} className="w-full" value={draft.credits || undefined} onChange={(credits) => patch({ credits: credits || 0 })} />
                                        </Form.Item>
                                    )}
                                </Space>
                            )}
                        </Form>
                    </Space>
                )}
                {step === 2 && (
                    <Space direction="vertical" size={14} className="w-full">
                        {!compatibleFeatures.length ? (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前适配器没有可直接绑定的功能步骤，仍可先登记模型，稍后在功能绑定中配置。" />
                        ) : (
                            <Form layout="vertical">
                                <Form.Item label="允许使用的功能" extra="只展示与当前能力和操作匹配的功能；不选择也可以先保存模型。">
                                    <Select
                                        mode="multiple"
                                        showSearch
                                        optionFilterProp="label"
                                        value={draft.featureIds}
                                        onChange={chooseFeatures}
                                        options={compatibleFeatures.map((feature) => ({ value: feature.id, label: `${feature.module} · ${feature.label}` }))}
                                        placeholder="选择功能步骤"
                                    />
                                </Form.Item>
                                <Form.Item label="设为默认功能" extra="默认项会替换对应功能当前的默认模型；模型、渠道或接入停用时不能设为默认。">
                                    <Select
                                        mode="multiple"
                                        disabled={!draft.featureIds.some(canSetDefault)}
                                        value={draft.defaultFeatureIds}
                                        onChange={(defaultFeatureIds) => patch({ defaultFeatureIds: defaultFeatureIds.filter(canSetDefault) })}
                                        options={compatibleFeatures.filter((feature) => draft.featureIds.includes(feature.id) && canSetDefault(feature.id)).map((feature) => ({ value: feature.id, label: `${feature.module} · ${feature.label}` }))}
                                        placeholder="可选，不设置也能先登记"
                                    />
                                </Form.Item>
                                {requiresCloudPricing && draft.priceStatus === "unconfigured" && (
                                    <Alert type="info" showIcon message="专用云模型已保持停用" description="完成接入草稿后，在平台模型编辑中按实际计费方式填写单价或规格，再启用模型和功能绑定。" />
                                )}
                                {draft.featureIds.length > 0 && (
                                    <Typography.Text type="secondary">
                                        将登记 {draft.featureIds.length} 个功能绑定，其中 {draft.featureIds.filter(canSetDefault).length} 个可启用
                                        {draft.defaultFeatureIds.length ? `，并设置 ${draft.defaultFeatureIds.length} 个默认项` : ""}。
                                    </Typography.Text>
                                )}
                            </Form>
                        )}
                    </Space>
                )}
            </Space>
        </Drawer>
    );
}
