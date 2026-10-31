"use client";

import { useEffect, useState, type Key } from "react";
import { Alert, App, Button, Checkbox, Drawer, Flex, Form, Input, InputNumber, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import { nanoid } from "nanoid";
import { useSearchParams } from "react-router-dom";
import { fetchModelManagement, previewModelManagement, saveModelManagement, type FeatureBinding, type ManagedModel, type ManagedRoute, type ModelFeature, type ModelManagement } from "@/services/api/model-management";
import type { AdminModelChannel } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";
import { useConfigStore } from "@/stores/use-config-store";
import { JsonInput, jsonObjectRules } from "./json-input";
import { FeatureBindingsDrawer } from "./components/feature-bindings-drawer";
import { ModelConnectionWizard, type ConnectionWizardDraft, type ConnectionWizardSeed } from "./components/model-connection-wizard";
import { ModelRemovalWizard } from "./components/model-removal-wizard";
import {
    adapterRouteDefaults,
    modelAdapterOptions,
    modelAdapterOptionsForChannel,
    modelMatchesSearch,
    modelSetupState,
    removeChannelModelRoutes,
    unregisteredChannelModels,
    videoProfileCanActivate,
    videoProfileWithoutLegacyPricing,
} from "./model-management-options";

const empty: ModelManagement = { enabled: false, revision: 0, routes: [], models: [], bindings: [] };
const capabilityOptions = [{ value: "all", label: "全部" }, { value: "text", label: "文字" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" },
];
const featureModule = (feature: ModelFeature) => feature.module.split(" · ")[0];

export default function ModelManagementPage() {
    const token = useUserStore((s) => s.token);
    const { message, modal } = App.useApp();
    const [searchParams, setSearchParams] = useSearchParams();
    const [value, setValue] = useState<ModelManagement>(empty);
    const [baseline, setBaseline] = useState<ModelManagement>(empty);
    const [features, setFeatures] = useState<ModelFeature[]>([]);
    const [channels, setChannels] = useState<AdminModelChannel[]>([]);
    const [loading, setLoading] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [keyword, setKeyword] = useState("");
    const [activeView, setActiveView] = useState("models");
    const [page, setPage] = useState(1);
    const [module, setModule] = useState<string>();
    const [capabilityFilter, setCapabilityFilter] = useState<string>();
    const [channelFilter, setChannelFilter] = useState<number>();
    const [adapterFilter, setAdapterFilter] = useState<string>();
    const [protocolFilter, setProtocolFilter] = useState<string>();
    const [statusFilter, setStatusFilter] = useState<string>();
    const [selectedFeature, setSelectedFeature] = useState("");
    const [editingModel, setEditingModel] = useState<ManagedModel | null>(null);
    const [editingRoute, setEditingRoute] = useState<ManagedRoute | null>(null);
    const [bindingModelId, setBindingModelId] = useState("");
    const [viewingRoutesId, setViewingRoutesId] = useState("");
    const [modelForm] = Form.useForm<ManagedModel>();
    const [routeForm] = Form.useForm<ManagedRoute>();
    const [selectedModels, setSelectedModels] = useState<Key[]>([]);
    const [bulkFeatures, setBulkFeatures] = useState<string[]>([]);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [priceMode, setPriceMode] = useState("fixed");
    const [priceStatus, setPriceStatus] = useState<"unconfigured" | "free" | "fixed">("unconfigured");
    const [wizardOpen, setWizardOpen] = useState(false);
    const [wizardSeed, setWizardSeed] = useState<ConnectionWizardSeed>();
    const [removalTarget, setRemovalTarget] = useState<{ channelId: number; model: string }>();
    const [guidedQuery, setGuidedQuery] = useState("");
    const routeLabel = (route: ManagedRoute) => `${channels.find((c) => c.id === route.channelId)?.name || route.channelId} / ${route.model}`;
    const load = async () => {
        setLoading(true);
        setLoaded(false);
        setLoadError("");
        try {
            const result = await fetchModelManagement(token);
            setValue(result.management || empty);
            setBaseline(result.management || empty);
            setFeatures(result.features);
            setChannels(result.channels);
            setWarnings([]);
            setLoaded(true);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : "读取失败");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void load();
    }, [token]);
    useEffect(() => {
        if (!loaded) return;
        const channelId = Number(searchParams.get("channelId"));
        const model = searchParams.get("model") || "";
        const queryKey = searchParams.toString();
        if (!channelId || guidedQuery === queryKey) return;
        setChannelFilter(channelId);
        setActiveView("models");
        setKeyword(model);
        if (searchParams.get("intent") === "remove") {
            setRemovalTarget({ channelId, model });
            setWizardOpen(false);
            setWizardSeed(undefined);
        } else {
            setWizardSeed({ channelId, model });
            setWizardOpen(true);
        }
        setGuidedQuery(queryKey);
        setSearchParams({}, { replace: true });
    }, [guidedQuery, loaded, searchParams, setSearchParams]);
    useEffect(() => {
        setSelectedModels([]);
        setPage(1);
    }, [capabilityFilter, keyword, module, channelFilter, adapterFilter, protocolFilter, statusFilter, activeView, selectedFeature]);
    const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
    useEffect(() => {
        const protect = (event: BeforeUnloadEvent) => {
            if (dirty) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", protect);
        return () => window.removeEventListener("beforeunload", protect);
    }, [dirty]);
    const replaceDraft = (action: () => void) => (dirty ? modal.confirm({ title: "替换未保存草稿", content: "当前修改尚未保存，继续将替换当前草稿。", onOk: action }) : action());
    const editModel = (entry: ManagedModel) => {
        modelForm.resetFields();
        setEditingModel(structuredClone(entry));
        modelForm.setFieldsValue(structuredClone(entry));
        setPriceMode(entry.pricing.replicate ? "cloud" : entry.pricing.video ? "duration_resolution" : "fixed");
        setPriceStatus(!entry.pricing.configured ? "unconfigured" : entry.pricing.free ? "free" : "fixed");
    };
    const editRoute = (route: ManagedRoute) => {
        routeForm.resetFields();
        setEditingRoute(structuredClone(route));
        routeForm.setFieldsValue(structuredClone(route));
    };
    const modelDeleteReason = (entry: ManagedModel) => (entry.enabled || baseline.models.some((old) => old.id === entry.id && old.enabled) ? "请先停用模型并保存配置" : "");
    const routeDeleteReason = (route: ManagedRoute) => {
        if (route.enabled || baseline.routes.some((old) => old.id === route.id && old.enabled)) return "请先停用接入并保存配置";
        const entry = value.models.find((entry) => entry.routeIds.includes(route.id));
        if (entry) return `仍被平台模型 ${entry.displayName} 引用，请先解除接入关系或删除该平台模型`;
        if (value.bindings.some((binding) => binding.routeIds.includes(route.id))) return "仍有功能绑定引用，请先解除绑定";
        return "";
    };
    const deleteModel = (entry: ManagedModel) => {
        if (modelDeleteReason(entry)) return;
        modal.confirm({
            title: `删除平台模型 ${entry.displayName}`,
            content: `将从草稿移除模型及其 ${value.bindings.filter((binding) => binding.modelId === entry.id).length} 项功能绑定，保留渠道接入。保存配置时会检查历史任务和计费引用，有引用则拒绝删除。`,
            okText: "从草稿删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => {
                setValue((current) => ({ ...current, models: current.models.filter((model) => model.id !== entry.id), bindings: current.bindings.filter((binding) => binding.modelId !== entry.id) }));
                setSelectedModels((current) => current.filter((id) => id !== entry.id));
                setPage(1);
            },
        });
    };
    const deleteRoute = (route: ManagedRoute) => {
        if (routeDeleteReason(route)) return;
        modal.confirm({
            title: `删除渠道模型 ${route.model}`,
            content: "将从草稿移除此接入，保留所属渠道及密钥。保存配置时会检查历史任务和计费引用，有引用则拒绝删除。",
            okText: "从草稿删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => {
                setValue((current) => ({ ...current, routes: current.routes.filter((entry) => entry.id !== route.id) }));
                setPage(1);
            },
        });
    };
    const bulkBind = (enabled: boolean) =>
        setValue((current) => {
            const bindings = [...current.bindings];
            for (const entry of current.models.filter((m) => selectedModels.includes(m.id)))
                for (const id of bulkFeatures) {
                    const feature = features.find((f) => f.id === id);
                    const routes = current.routes.filter((r) => entry.routeIds.includes(r.id) && r.capability === feature?.capability && r.operations.some((op) => feature.operations.includes(op)));
                    if (!routes.length) continue;
                    const index = bindings.findIndex((b) => b.featureId === id && b.modelId === entry.id);
                    const old = bindings[index] || { featureId: id, modelId: entry.id, routeIds: routes.map((r) => r.id), order: bindings.length, default: false, enabled: false };
                    const next = { ...old, enabled, default: enabled && old.default };
                    if (index >= 0) bindings[index] = next;
                    else bindings.push(next);
                }
            return { ...current, bindings };
        });
    const patchBinding = (entry: ManagedModel, patch: Partial<FeatureBinding>) =>
        setValue((current) => {
            let bindings = [...current.bindings];
            const index = bindings.findIndex((b) => b.featureId === selectedFeature && b.modelId === entry.id);
            const old = index >= 0 ? bindings[index] : { featureId: selectedFeature, modelId: entry.id, routeIds: entry.routeIds, enabled: false, default: false, order: bindings.length };
            const next = { ...old, ...patch };
            if (!next.enabled) next.default = false;
            if (next.default) bindings = bindings.map((b) => (b.featureId === selectedFeature ? { ...b, default: false } : b));
            if (index >= 0) bindings[index] = next;
            else bindings.push(next);
            return { ...current, bindings };
        });
    const save = (nextValue: ModelManagement = value, onSaved?: () => void) => {
        if (!loaded || loading) return;
        const changedModels = nextValue.models.filter((entry) => JSON.stringify(entry) !== JSON.stringify(baseline.models.find((old) => old.id === entry.id)));
        const changedRoutes = nextValue.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(baseline.routes.find((old) => old.id === route.id)));
        const deletedModels = baseline.models.filter((entry) => !nextValue.models.some((model) => model.id === entry.id));
        const deletedRoutes = baseline.routes.filter((route) => !nextValue.routes.some((entry) => entry.id === route.id));
        const affected = new Set(
            nextValue.bindings
                .filter(
                    (b) =>
                        JSON.stringify(b) !== JSON.stringify(baseline.bindings.find((old) => old.featureId === b.featureId && old.modelId === b.modelId)) ||
                        changedModels.some((m) => m.id === b.modelId) ||
                        changedRoutes.some((r) => b.routeIds.includes(r.id)),
                )
                .map((b) => b.featureId),
        );
        for (const binding of baseline.bindings) if (!nextValue.bindings.some((entry) => entry.featureId === binding.featureId && entry.modelId === binding.modelId)) affected.add(binding.featureId);
        const priceChanges = changedModels.filter((entry) => JSON.stringify(entry.pricing) !== JSON.stringify(baseline.models.find((old) => old.id === entry.id)?.pricing));
        const defaults = [...affected].filter((id) => nextValue.bindings.find((b) => b.featureId === id && b.default)?.modelId !== baseline.bindings.find((b) => b.featureId === id && b.default)?.modelId);
        const modelName = (id?: string) => nextValue.models.find((m) => m.id === id)?.displayName || baseline.models.find((m) => m.id === id)?.displayName || "无";
        modal.confirm({
            title: "保存模型配置",
            width: 640,
            content: (
                <Space direction="vertical" className="max-h-[65vh] w-full overflow-auto break-words">
                    <span>
                        平台模型变更 {changedModels.length} 项，删除 {deletedModels.length} 项；渠道模型变更 {changedRoutes.length} 项，删除 {deletedRoutes.length} 项；涉及功能步骤 {affected.size} 项。
                    </span>
                    {deletedModels.map((entry) => (
                        <div key={`delete-${entry.id}`}>删除平台模型：{entry.displayName}</div>
                    ))}
                    {deletedRoutes.map((route) => (
                        <div key={`delete-${route.id}`}>删除渠道模型：{routeLabel(route)}</div>
                    ))}
                    <span>{nextValue.enabled ? "保存后新报价与新生成使用此配置；未提交报价需重新确认。" : "统一模型目录尚未启用，现有入口继续使用原配置。"}</span>
                    <Typography.Text type="secondary">
                        {[...affected]
                            .map((id) => {
                                const f = features.find((f) => f.id === id);
                                return f ? `${f.module} · ${f.label}` : id;
                            })
                            .join("、")}
                    </Typography.Text>
                    {defaults.map((id) => (
                        <div key={id}>
                            默认模型：{features.find((f) => f.id === id)?.label}，{modelName(baseline.bindings.find((b) => b.featureId === id && b.default)?.modelId)} → {modelName(nextValue.bindings.find((b) => b.featureId === id && b.default)?.modelId)}
                        </div>
                    ))}
                    {changedModels
                        .filter((entry) => JSON.stringify(entry.routeIds) !== JSON.stringify(baseline.models.find((m) => m.id === entry.id)?.routeIds))
                        .map((entry) => (
                            <div key={`routes-${entry.id}`}>
                                {entry.displayName} · 允许接入：
                                {entry.routeIds
                                    .map((id) => nextValue.routes.find((r) => r.id === id))
                                    .filter((r): r is ManagedRoute => !!r)
                                    .map(routeLabel)
                                    .join("；") || "无"}
                            </div>
                        ))}
                    {priceChanges.map((entry) => (
                        <div key={entry.id}>
                            {entry.displayName} · 报价变化
                            <pre className="whitespace-pre-wrap text-xs">
                                {JSON.stringify(baseline.models.find((old) => old.id === entry.id)?.pricing || {}, null, 2)}
                                {"\n→\n"}
                                {JSON.stringify(entry.pricing, null, 2)}
                            </pre>
                        </div>
                    ))}
                </Space>
            ),
            onOk: async () => {
                try {
                    const saved = await saveModelManagement(token, nextValue);
                    setValue(saved);
                    setBaseline(saved);
                    message.success("模型配置已保存");
                    window.localStorage.setItem("platform-model-catalog-revision", String(saved.revision));
                    window.dispatchEvent(new Event("platform-model-catalog-changed"));
                    void useConfigStore.getState().loadPublicSettings();
                    onSaved?.();
                } catch (e) {
                    message.error(e instanceof Error ? e.message : "保存失败");
                }
            },
        });
    };
    const targetRemovalRoutes = (target: { channelId: number; model: string }) => value.routes.filter((route) => route.channelId === target.channelId && route.model === target.model);
    const disableRemovalRoutes = () => {
        if (!removalTarget) return;
        const routeIds = new Set(targetRemovalRoutes(removalTarget).map((route) => route.id));
        const nextValue = {
            ...value,
            routes: value.routes.map((route) => (routeIds.has(route.id) ? { ...route, enabled: false } : route)),
        };
        save(nextValue);
    };
    const removeTargetRoutes = () => {
        if (!removalTarget) return;
        const routeIds = targetRemovalRoutes(removalTarget).map((route) => route.id);
        save(removeChannelModelRoutes(value, routeIds), () => {
            setRemovalTarget(undefined);
            message.info("目录接入已移除。请返回渠道编辑器，再保存移除上游模型 ID。");
        });
    };
    const availableFeatures = features.filter((entry) => !capabilityFilter || entry.capability === capabilityFilter);
    const matchingFeatures = availableFeatures.filter((entry) => !module || featureModule(entry) === module);
    const feature = matchingFeatures.find((entry) => entry.id === selectedFeature);
    const moduleBindings = value.bindings.filter((binding) => binding.enabled && matchingFeatures.some((entry) => entry.id === binding.featureId));
    const routeMatchesFilters = (route: ManagedRoute) =>
        (!capabilityFilter || route.capability === capabilityFilter) &&
        (channelFilter === undefined || route.channelId === channelFilter) &&
        (!adapterFilter || route.adapter === adapterFilter) &&
        (!protocolFilter || channels.some((channel) => channel.id === route.channelId && channel.protocol === protocolFilter));
    const matchingModels = value.models.filter((entry) => {
        if (!modelMatchesSearch(entry, value.routes, channels, keyword)) return false;
        if (statusFilter !== undefined && String(entry.enabled) !== statusFilter) return false;
        return value.routes.some((route) => entry.routeIds.includes(route.id) && routeMatchesFilters(route)) || (!entry.routeIds.length && !capabilityFilter && channelFilter === undefined && !adapterFilter && !protocolFilter);
    });
    const platformModels = matchingModels.filter(
        (entry) => !module || moduleBindings.some((binding) => binding.modelId === entry.id && value.routes.some((route) => entry.routeIds.includes(route.id) && binding.routeIds.includes(route.id) && routeMatchesFilters(route))),
    );
    const matchingRoutes = value.routes.filter(
        (route) =>
            (!keyword || routeLabel(route).toLowerCase().includes(keyword.toLowerCase())) &&
            routeMatchesFilters(route) &&
            (statusFilter === undefined || String(route.enabled) === statusFilter) &&
            (!module || moduleBindings.some((binding) => binding.routeIds.includes(route.id) && value.models.some((entry) => entry.id === binding.modelId && entry.routeIds.includes(route.id)))),
    );
    const bindModelFeatures = (entry: ManagedModel, ids: string[]) =>
        setValue((current) => ({
            ...current,
            bindings: [
                ...current.bindings.filter((b) => b.modelId !== entry.id || !ids.includes(b.featureId)).map((b) => (b.modelId === entry.id ? { ...b, enabled: false, default: false } : b)),
                ...ids.map((id, index) => {
                    const old = current.bindings.find((b) => b.modelId === entry.id && b.featureId === id);
                    const feature = features.find((f) => f.id === id);
                    return {
                        ...old,
                        featureId: id,
                        modelId: entry.id,
                        routeIds: old?.routeIds || current.routes.filter((r) => entry.routeIds.includes(r.id) && r.capability === feature?.capability && r.operations.some((op) => feature.operations.includes(op))).map((r) => r.id),
                        enabled: true,
                        default: old?.default || false,
                        order: old?.order ?? index,
                    };
                }),
            ],
        }));
    const pendingModels = unregisteredChannelModels(channels, value.routes);
    const availability = (entry: ManagedModel) => modelSetupState(entry, value.routes, channels, value.bindings);
    const availabilityColor = (state: string) => (state === "已配置" ? "success" : state === "待定价" ? "warning" : state === "平台模型停用" ? "default" : "error");
    const openConnectionWizard = (seed?: ConnectionWizardSeed) => {
        setWizardSeed(seed);
        setWizardOpen(true);
    };
    const applyConnectionWizard = (draft: ConnectionWizardDraft) => {
        const channel = channels.find((entry) => entry.id === draft.channelId);
        if (!channel) {
            message.error("找不到所选渠道，请刷新后重试");
            return;
        }
        const existingRoute = value.routes.find((route) => route.channelId === draft.channelId && route.model === draft.model);
        const videoProfile = draft.capability === "video" && !draft.adapter.startsWith("cloud:") ? existingRoute?.video || channel.videoModels?.[draft.model] : undefined;
        const videoProfileReady = videoProfileCanActivate(videoProfile, draft.adapter);
        const routeVideoProfile = existingRoute ? videoProfile : videoProfileWithoutLegacyPricing(videoProfile);
        const route = existingRoute || {
            id: `route_${nanoid().replaceAll("-", "_")}`,
            channelId: draft.channelId,
            model: draft.model,
            adapter: draft.adapter,
            capability: draft.capability,
            operations: draft.operations,
            version: draft.version || undefined,
            enabled: channel.enabled && (draft.capability !== "video" || draft.adapter.startsWith("cloud:") || videoProfileReady),
            ...(routeVideoProfile ? { video: routeVideoProfile } : {}),
        };
        const routes = existingRoute ? value.routes : [...value.routes, route];
        const selectedExisting = draft.platformModelId ? value.models.find((entry) => entry.id === draft.platformModelId) : undefined;
        const pricing = draft.priceStatus === "unconfigured" ? { configured: false, free: false, credits: 0 } : { configured: true, free: draft.priceStatus === "free", credits: draft.priceStatus === "fixed" ? draft.credits : 0 };
        const platformModel = selectedExisting || {
            id: `model_${nanoid().replaceAll("-", "_")}`,
            internalName: draft.internalName || `${channel.name} / ${draft.model}`,
            displayName: draft.displayName || draft.model,
            displayMode: draft.displayMode,
            description: draft.description,
            enabled: pricing.configured && route.enabled,
            routeIds: [],
            pricing,
        };
        const models = value.models.some((entry) => entry.id === platformModel.id)
            ? value.models.map((entry) => (entry.id === platformModel.id ? { ...entry, routeIds: [...new Set([...entry.routeIds, route.id])] } : entry))
            : [...value.models, { ...platformModel, routeIds: [route.id] }];
        let bindings = [...value.bindings];
        for (const featureId of draft.featureIds) {
            const feature = features.find((entry) => entry.id === featureId);
            if (!feature) continue;
            const index = bindings.findIndex((binding) => binding.featureId === featureId && binding.modelId === platformModel.id);
            const old = index >= 0 ? bindings[index] : undefined;
            const bindingRouteIds = [...new Set([...(old?.routeIds || []), route.id])];
            const routeAvailable = bindingRouteIds.some((id) => {
                const candidate = routes.find((entry) => entry.id === id) || route;
                return candidate.enabled && channels.some((item) => item.id === candidate.channelId && item.enabled);
            });
            const isDefault = draft.defaultFeatureIds.includes(featureId) && platformModel.enabled && routeAvailable;
            if (isDefault) bindings = bindings.map((binding) => (binding.featureId === featureId ? { ...binding, default: false } : binding));
            const next = {
                ...old,
                featureId,
                modelId: platformModel.id,
                routeIds: bindingRouteIds,
                enabled: platformModel.enabled && routeAvailable,
                default: isDefault,
                order: old?.order ?? bindings.length,
            };
            if (index >= 0) bindings[index] = next;
            else bindings.push(next);
        }
        setValue({ ...value, routes, models, bindings });
        setWizardOpen(false);
        setWizardSeed(undefined);
        setActiveView("models");
        setKeyword(platformModel.displayName || draft.model);
        message.success(selectedExisting ? "已关联渠道到现有平台模型，修改已加入草稿" : "已加入模型管理草稿，请检查状态后保存配置");
    };
    const modules = [...new Set(availableFeatures.map(featureModule))];
    const categories = capabilityOptions.map((option) => ({
        ...option,
        count: value.models.filter((entry) => option.value === "all" || value.routes.some((route) => entry.routeIds.includes(route.id) && route.capability === option.value)).length,
    }));
    const changeCapability = (next: string) => {
        const capability = next === "all" ? undefined : next;
        setCapabilityFilter(capability);
        if (module && !features.some((entry) => featureModule(entry) === module && (!capability || entry.capability === capability))) setModule(undefined);
        if (capability && feature?.capability !== capability) setSelectedFeature("");
        setSelectedModels([]);
        setBulkFeatures([]);
    };
    const resetFilters = () => {
        setCapabilityFilter(undefined);
        setKeyword("");
        setModule(undefined);
        setChannelFilter(undefined);
        setAdapterFilter(undefined);
        setProtocolFilter(undefined);
        setStatusFilter(undefined);
        setSelectedFeature("");
        setSelectedModels([]);
        setBulkFeatures([]);
    };
    const applyModelDraft = async () => {
        await modelForm.validateFields();
        const entry = modelForm.getFieldsValue(true) as ManagedModel;
        if (priceStatus === "fixed" && priceMode === "fixed" && (!entry.pricing?.credits || entry.pricing.credits <= 0)) {
            message.error("请输入正数固定点数");
            return;
        }
        const pricing = {
            ...entry.pricing,
            configured: priceStatus !== "unconfigured",
            free: priceStatus === "free",
            credits: priceStatus === "fixed" && priceMode === "fixed" ? entry.pricing.credits || 0 : 0,
        };
        if (priceMode !== "cloud") pricing.replicate = undefined;
        if (priceMode !== "duration_resolution") pricing.video = undefined;
        if (priceStatus === "free") {
            pricing.video = undefined;
            pricing.replicate = undefined;
        }
        if (priceStatus === "unconfigured") {
            pricing.free = false;
            pricing.credits = 0;
            pricing.video = undefined;
            pricing.replicate = undefined;
        }
        const next = { ...entry, enabled: priceStatus === "unconfigured" ? false : entry.enabled, pricing };
        setValue({
            ...value,
            models: [...value.models.filter((model) => model.id !== entry.id), next],
            bindings: value.bindings.map((binding) => (binding.modelId === entry.id && (!next.enabled || !pricing.configured) ? { ...binding, default: false } : binding)),
        });
        setEditingModel(null);
    };
    const filtered = !!(capabilityFilter || keyword || module || channelFilter !== undefined || adapterFilter || protocolFilter || statusFilter !== undefined || selectedFeature);
    const bindingModel = value.models.find((entry) => entry.id === bindingModelId);
    const viewingRoutesModel = value.models.find((entry) => entry.id === viewingRoutesId);
    return (
        <div className="flex flex-col gap-3 p-4 sm:p-6">
            <Flex gap={12} wrap align="center" justify="space-between">
                <Space wrap>
                    <Typography.Title level={4} style={{ margin: 0 }}>
                        模型管理
                    </Typography.Title>
                    <Tag>版本 {value.revision}</Tag>
                    <Switch disabled={!loaded || loading} checked={value.enabled} checkedChildren="已启用" unCheckedChildren="未启用" onChange={(enabled) => setValue({ ...value, enabled })} />
                </Space>
                <Space wrap>
                    <Button icon={<ReloadOutlined />} onClick={() => replaceDraft(() => void load())} loading={loading}>
                        重新加载
                    </Button>
                    <Button
                        disabled={!loaded || loading}
                        onClick={() =>
                            replaceDraft(async () => {
                                try {
                                    const result = await previewModelManagement(token);
                                    setValue(result.management);
                                    setWarnings(result.warnings);
                                    message.success("已生成转换草稿，核对后保存生效");
                                } catch (e) {
                                    message.error(e instanceof Error ? e.message : "预览失败");
                                }
                            })
                        }
                    >
                        转换现有配置预览
                    </Button>
                    <Button disabled={!loaded || loading} type="primary" icon={<SaveOutlined />} onClick={() => save()}>
                        保存配置
                    </Button>
                </Space>
            </Flex>
            {loadError && <Alert type="error" showIcon title="模型配置读取失败" description={`${loadError}。请确认后端运行当前版本后重新加载，读取成功前不能编辑或保存。`} />}
            {loaded && (
                <>
                    {warnings.length > 0 && (
                        <Alert
                            type="warning"
                            showIcon
                            title="转换预览"
                            description={
                                <div className="max-h-40 overflow-auto">
                                    {warnings.map((warning, index) => (
                                        <div key={index}>{warning}</div>
                                    ))}
                                </div>
                            }
                        />
                    )}
                    <div role="group" aria-label="模型能力分类">
                        <Segmented
                            block
                            name="model-capability"
                            value={capabilityFilter || "all"}
                            onChange={changeCapability}
                            className="w-full sm:!w-fit"
                            options={categories.map(({ value, label, count }) => ({
                                value,
                                tooltip: `${label}平台模型：${count} 个`,
                                label: (
                                    <span className="flex flex-col items-center py-1 leading-5 sm:flex-row sm:gap-2 sm:py-0">
                                        <span>{label}</span>
                                        <span className="text-xs tabular-nums">{count}</span>
                                    </span>
                                ),
                            }))}
                        />
                    </div>
                    <Flex gap={12} wrap align="center">
                        <Input.Search aria-label="搜索模型" placeholder="搜索名称、内部名称、编号" value={keyword} onChange={(e) => setKeyword(e.target.value)} allowClear className="min-w-0 flex-1 sm:flex-none" style={{ width: 416, maxWidth: "100%" }} />
                        <Tooltip title="重置筛选">
                            <Button aria-label="重置筛选" icon={<UndoOutlined />} disabled={!filtered} onClick={resetFilters}>
                                <span className="hidden sm:inline">重置筛选</span>
                            </Button>
                        </Tooltip>
                    </Flex>
                    <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
                        <Select
                            aria-label="适用模块"
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            placeholder="适用模块"
                            className="w-full sm:w-[200px]"
                            value={module}
                            onChange={(next) => {
                                setModule(next);
                                setSelectedFeature("");
                                setBulkFeatures([]);
                            }}
                            options={modules.map((name) => ({ value: name, label: name }))}
                        />
                        <Select aria-label="接入渠道" allowClear placeholder="接入渠道" className="w-full sm:w-[180px]" value={channelFilter} onChange={setChannelFilter} options={channels.map((c) => ({ value: c.id, label: c.name }))} />
                        <Select
                            aria-label="启用状态"
                            allowClear
                            placeholder="启用状态"
                            className="w-full sm:w-[140px]"
                            value={statusFilter}
                            onChange={setStatusFilter}
                            options={[
                                { value: "true", label: "启用" },
                                { value: "false", label: "停用" },
                            ]}
                        />
                        <Select
                            aria-label="调用协议"
                            allowClear
                            placeholder="调用协议"
                            className="w-full sm:w-[160px]"
                            value={protocolFilter}
                            onChange={setProtocolFilter}
                            options={[...new Set(channels.map((c) => c.protocol))].map((value) => ({ value, label: value }))}
                        />
                        <Select aria-label="调用适配器" allowClear showSearch optionFilterProp="label" placeholder="调用适配器" className="w-full sm:w-[240px]" value={adapterFilter} onChange={setAdapterFilter} options={modelAdapterOptions} />
                    </div>
                    {activeView === "models" && (
                        <Flex gap={8} wrap>
                            <Select
                                mode="multiple"
                                maxTagCount={1}
                                aria-label="批量功能"
                                placeholder="批量选择功能步骤"
                                style={{ width: 320, maxWidth: "100%" }}
                                value={bulkFeatures}
                                onChange={setBulkFeatures}
                                options={matchingFeatures.map((f) => ({ value: f.id, label: `${f.module} · ${f.label}` }))}
                            />
                            <Button disabled={!selectedModels.length || !bulkFeatures.length} onClick={() => bulkBind(true)}>
                                批量绑定
                            </Button>
                            <Button disabled={!selectedModels.length || !bulkFeatures.length} onClick={() => bulkBind(false)}>
                                批量解绑
                            </Button>
                        </Flex>
                    )}
                    <Tabs
                        activeKey={activeView}
                        onChange={setActiveView}
                        items={[
                            {
                                key: "models",
                                label: `平台模型 (${platformModels.length})`,
                                children: (
                                    <>
                                        {pendingModels.length > 0 && (
                                            <section className="mb-4 border-b border-[var(--ant-color-border-secondary)] pb-4">
                                                <Flex gap={12} wrap align="center" justify="space-between" className="mb-2">
                                                    <Space wrap>
                                                        <Typography.Text strong>待接入渠道模型</Typography.Text>
                                                        <Tag color="warning">{pendingModels.length}</Tag>
                                                        <Typography.Text type="secondary">渠道里的真实模型不会自动进入平台目录</Typography.Text>
                                                    </Space>
                                                    <Button size="small" icon={<PlusOutlined />} onClick={() => openConnectionWizard()}>
                                                        接入模型
                                                    </Button>
                                                </Flex>
                                                <Table
                                                    size="small"
                                                    rowKey={(entry) => `${entry.channelId}:${entry.model}`}
                                                    pagination={{ pageSize: 5, size: "small", hideOnSinglePage: true }}
                                                    dataSource={pendingModels.filter((entry) => !keyword || `${entry.channelName} ${entry.model}`.toLowerCase().includes(keyword.trim().toLowerCase()))}
                                                    columns={[
                                                        {
                                                            title: "渠道",
                                                            dataIndex: "channelName",
                                                            width: 180,
                                                            render: (name, entry) => (
                                                                <Space wrap>
                                                                    {name || `渠道 ${entry.channelId}`}
                                                                    {!entry.channelEnabled && <Tag>渠道停用</Tag>}
                                                                </Space>
                                                            ),
                                                        },
                                                        { title: "真实模型 ID", dataIndex: "model" },
                                                        { title: "后续配置", render: () => <Typography.Text type="secondary">适配器 · 价格 · 功能绑定</Typography.Text> },
                                                        {
                                                            title: "操作",
                                                            width: 110,
                                                            render: (_, entry) => (
                                                                <Button type="link" onClick={() => openConnectionWizard({ channelId: entry.channelId, model: entry.model })}>
                                                                    接入
                                                                </Button>
                                                            ),
                                                        },
                                                    ]}
                                                />
                                                {pendingModels.filter((entry) => !keyword || `${entry.channelName} ${entry.model}`.toLowerCase().includes(keyword.trim().toLowerCase())).length === 0 && keyword && (
                                                    <Typography.Text type="secondary">没有匹配的待接入模型</Typography.Text>
                                                )}
                                            </section>
                                        )}
                                        <Space wrap className="mb-3">
                                            <Button type="primary" icon={<PlusOutlined />} onClick={() => openConnectionWizard()}>
                                                接入模型
                                            </Button>
                                            <Button
                                                onClick={() =>
                                                    editModel({
                                                        id: `model_${nanoid().replaceAll("-", "_")}`,
                                                        internalName: "",
                                                        displayName: "",
                                                        displayMode: "alias",
                                                        description: "",
                                                        enabled: false,
                                                        routeIds: [],
                                                        pricing: { configured: false, free: false, credits: 0 },
                                                    })
                                                }
                                            >
                                                高级：单独新增平台模型
                                            </Button>
                                            <Button
                                                disabled={!selectedModels.length}
                                                onClick={() =>
                                                    setValue({
                                                        ...value,
                                                        models: value.models.map((m) => (selectedModels.includes(m.id) ? { ...m, enabled: false } : m)),
                                                        bindings: value.bindings.map((b) => (selectedModels.includes(b.modelId) ? { ...b, default: false } : b)),
                                                    })
                                                }
                                            >
                                                批量停用
                                            </Button>
                                        </Space>
                                        <Table
                                            rowKey="id"
                                            dataSource={platformModels}
                                            pagination={{ current: page, onChange: setPage }}
                                            scroll={{ x: 1170 }}
                                            rowSelection={{ columnWidth: 48, selectedRowKeys: selectedModels, onChange: setSelectedModels }}
                                            columns={[
                                                {
                                                    title: "前台名称",
                                                    width: 150,
                                                    dataIndex: "displayName",
                                                    render: (name, entry) => (
                                                        <div className="min-w-0">
                                                            <div className="truncate" title={name}>
                                                                {name}
                                                            </div>
                                                            <Typography.Text type="secondary" ellipsis title={entry.internalName} style={{ display: "block" }}>
                                                                {entry.internalName}
                                                            </Typography.Text>
                                                        </div>
                                                    ),
                                                },
                                                { title: "展示方式", width: 130, dataIndex: "displayMode", render: (mode) => ({ alias: "仅别名", real: "真实 ID", both: "别名与真实 ID" })[mode as "alias"] },
                                                {
                                                    title: "接入渠道",
                                                    width: 160,
                                                    render: (_, entry) => {
                                                        const routes = value.routes.filter((route) => entry.routeIds.includes(route.id));
                                                        const enabled = routes.filter((route) => route.enabled && channels.some((channel) => channel.id === route.channelId && channel.enabled)).length;
                                                        return (
                                                            <div>
                                                                <Button type="link" className="!px-0" icon={<EyeOutlined />} aria-label={`${entry.displayName} · 查看接入渠道`} onClick={() => setViewingRoutesId(entry.id)}>
                                                                    {routes.length} 个接入
                                                                </Button>
                                                                <Typography.Text type="secondary" style={{ display: "block" }}>
                                                                    启用 {enabled} 个
                                                                </Typography.Text>
                                                            </div>
                                                        );
                                                    },
                                                },
                                                {
                                                    title: "价格",
                                                    width: 110,
                                                    render: (_, entry) =>
                                                        !entry.pricing.configured ? (
                                                            <Tag color="warning">待定价</Tag>
                                                        ) : entry.pricing.free ? (
                                                            "免费"
                                                        ) : entry.pricing.video ? (
                                                            "按秒/规格"
                                                        ) : entry.pricing.replicate ? (
                                                            entry.pricing.replicate.billingMode
                                                        ) : (
                                                            `${entry.pricing.credits} 点/次`
                                                        ),
                                                },
                                                {
                                                    title: "配置状态",
                                                    width: 160,
                                                    render: (_, entry) => {
                                                        const state = availability(entry);
                                                        return <Tag color={availabilityColor(state)}>{state}</Tag>;
                                                    },
                                                },
                                                {
                                                    title: "适用功能",
                                                    width: 160,
                                                    render: (_, entry) => (
                                                        <Button type="link" className="!px-0" icon={<EditOutlined />} aria-label={`${entry.displayName} · 管理适用功能`} onClick={() => setBindingModelId(entry.id)}>
                                                            已绑定 {value.bindings.filter((binding) => binding.modelId === entry.id && binding.enabled).length} 项
                                                        </Button>
                                                    ),
                                                },
                                                {
                                                    title: "启用",
                                                    width: 80,
                                                    render: (_, entry) => (
                                                        <Switch
                                                            checked={entry.enabled}
                                                            onChange={(enabled) =>
                                                                setValue({
                                                                    ...value,
                                                                    models: value.models.map((m) => (m.id === entry.id ? { ...m, enabled } : m)),
                                                                    bindings: value.bindings.map((b) => (b.modelId === entry.id && !enabled ? { ...b, default: false } : b)),
                                                                })
                                                            }
                                                        />
                                                    ),
                                                },
                                                {
                                                    title: "操作",
                                                    width: 152,
                                                    fixed: "right",
                                                    render: (_, entry) => (
                                                        <Space>
                                                            <Tooltip title="编辑模型">
                                                                <Button icon={<EditOutlined />} aria-label="编辑模型" onClick={() => editModel(entry)} />
                                                            </Tooltip>
                                                            <Tooltip title="复制模型">
                                                                <Button
                                                                    icon={<CopyOutlined />}
                                                                    aria-label="复制模型"
                                                                    onClick={() => editModel({ ...structuredClone(entry), id: `model_${nanoid().replaceAll("-", "_")}`, displayName: `${entry.displayName} 副本`, enabled: false })}
                                                                />
                                                            </Tooltip>
                                                            <Tooltip title={modelDeleteReason(entry) || "删除模型"}>
                                                                <span>
                                                                    <Button danger icon={<DeleteOutlined />} aria-label={`删除模型 ${entry.displayName}`} disabled={!!modelDeleteReason(entry)} onClick={() => deleteModel(entry)} />
                                                                </span>
                                                            </Tooltip>
                                                        </Space>
                                                    ),
                                                },
                                            ]}
                                        />
                                    </>
                                ),
                            },
                            {
                                key: "features",
                                label: "功能绑定",
                                children: (
                                    <>
                                        <Select
                                            aria-label="功能步骤"
                                            showSearch
                                            optionFilterProp="label"
                                            placeholder="选择功能步骤"
                                            value={selectedFeature || undefined}
                                            onChange={setSelectedFeature}
                                            style={{ width: 400, maxWidth: "100%" }}
                                            className="mb-4"
                                            options={matchingFeatures.map((f) => ({ value: f.id, label: `${f.module} · ${f.label}` }))}
                                        />
                                        {feature && (
                                            <Table
                                                rowKey="id"
                                                pagination={{ current: page, onChange: setPage }}
                                                scroll={{ x: 1050 }}
                                                dataSource={matchingModels.filter((m) =>
                                                    value.routes.some((r) => m.routeIds.includes(r.id) && routeMatchesFilters(r) && r.capability === feature.capability && r.operations.some((op) => feature.operations.includes(op))),
                                                )}
                                                columns={[
                                                    { title: "平台模型", dataIndex: "displayName" },
                                                    {
                                                        title: "用户可选",
                                                        render: (_, entry) => <Switch checked={value.bindings.some((b) => b.featureId === selectedFeature && b.modelId === entry.id && b.enabled)} onChange={(enabled) => patchBinding(entry, { enabled })} />,
                                                    },
                                                    {
                                                        title: "默认模型",
                                                        render: (_, entry) => (
                                                            <Checkbox
                                                                checked={value.bindings.some((b) => b.featureId === selectedFeature && b.modelId === entry.id && b.default)}
                                                                disabled={!entry.enabled || !value.bindings.some((b) => b.featureId === selectedFeature && b.modelId === entry.id && b.enabled)}
                                                                onChange={(e) => patchBinding(entry, { default: e.target.checked })}
                                                            />
                                                        ),
                                                    },
                                                    {
                                                        title: "展示顺序",
                                                        render: (_, entry) => (
                                                            <InputNumber min={0} value={value.bindings.find((b) => b.featureId === selectedFeature && b.modelId === entry.id)?.order || 0} onChange={(order) => patchBinding(entry, { order: order || 0 })} />
                                                        ),
                                                    },
                                                    {
                                                        title: "允许接入",
                                                        render: (_, entry) => (
                                                            <Select
                                                                mode="multiple"
                                                                maxTagCount={1}
                                                                style={{ width: 220 }}
                                                                value={value.bindings.find((b) => b.featureId === selectedFeature && b.modelId === entry.id)?.routeIds || entry.routeIds}
                                                                options={value.routes.filter((r) => entry.routeIds.includes(r.id)).map((r) => ({ value: r.id, label: routeLabel(r) }))}
                                                                onChange={(routeIds) => patchBinding(entry, { routeIds })}
                                                            />
                                                        ),
                                                    },
                                                    {
                                                        title: "输出规格子集",
                                                        render: (_, entry) => {
                                                            const binding = value.bindings.find((b) => b.featureId === selectedFeature && b.modelId === entry.id);
                                                            const route = value.routes.find((r) => entry.routeIds.includes(r.id));
                                                            return route?.video ? (
                                                                <Space direction="vertical">
                                                                    <Select
                                                                        mode="multiple"
                                                                        placeholder="全部清晰度"
                                                                        style={{ minWidth: 150 }}
                                                                        value={binding?.resolutions}
                                                                        options={route.video.resolutions.map((v) => ({ value: v, label: v }))}
                                                                        onChange={(resolutions) => patchBinding(entry, { resolutions })}
                                                                    />
                                                                    <Select
                                                                        mode="multiple"
                                                                        placeholder="全部时长"
                                                                        style={{ minWidth: 150 }}
                                                                        value={binding?.seconds}
                                                                        options={route.video.seconds.map((v) => ({ value: v, label: `${v}秒` }))}
                                                                        onChange={(seconds) => patchBinding(entry, { seconds })}
                                                                    />
                                                                </Space>
                                                            ) : null;
                                                        },
                                                    },
                                                ]}
                                            />
                                        )}
                                    </>
                                ),
                            },
                            {
                                key: "routes",
                                label: `渠道模型 (${matchingRoutes.length})`,
                                children: (
                                    <>
                                        <Space wrap className="mb-3">
                                            <Button href="/admin/settings">渠道与密钥设置</Button>
                                            <Button type="primary" icon={<PlusOutlined />} onClick={() => openConnectionWizard({ channelId: channels.find((channel) => channel.enabled)?.id || channels[0]?.id })}>
                                                接入模型
                                            </Button>
                                            <Button
                                                onClick={() => {
                                                    const channelId = channelFilter || channels.find((channel) => channel.enabled)?.id || channels[0]?.id || 0;
                                                    const route = { id: `route_${nanoid().replaceAll("-", "_")}`, channelId, model: "", adapter: "text.openai", capability: "text", operations: ["text"], enabled: false };
                                                    editRoute(route);
                                                }}
                                            >
                                                高级：单独新增渠道模型
                                            </Button>
                                        </Space>
                                        <Table
                                            rowKey="id"
                                            pagination={{ current: page, onChange: setPage }}
                                            scroll={{ x: 800 }}
                                            dataSource={matchingRoutes}
                                            columns={[
                                                { title: "渠道 / 真实模型", render: (_, route) => routeLabel(route) },
                                                { title: "适配器", dataIndex: "adapter" },
                                                { title: "类型", dataIndex: "capability", render: (capability) => capabilityOptions.find((option) => option.value === capability)?.label || capability },
                                                { title: "状态", render: (_, route) => (route.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
                                                {
                                                    title: "操作",
                                                    width: 140,
                                                    render: (_, route) => (
                                                        <Space>
                                                            <Button icon={<EditOutlined />} onClick={() => editRoute(route)}>
                                                                编辑
                                                            </Button>
                                                            <Tooltip title={routeDeleteReason(route) || "删除接入"}>
                                                                <span>
                                                                    <Button danger icon={<DeleteOutlined />} aria-label={`删除接入 ${route.model}`} disabled={!!routeDeleteReason(route)} onClick={() => deleteRoute(route)} />
                                                                </span>
                                                            </Tooltip>
                                                        </Space>
                                                    ),
                                                },
                                            ]}
                                        />
                                    </>
                                ),
                            },
                        ]}
                    />
                    {bindingModel && (
                        <FeatureBindingsDrawer
                            key={bindingModel.id}
                            name={bindingModel.displayName}
                            features={features.filter((feature) =>
                                value.routes.some((route) => bindingModel.routeIds.includes(route.id) && route.capability === feature.capability && route.operations.some((operation) => feature.operations.includes(operation))),
                            )}
                            selectedIds={value.bindings.filter((binding) => binding.modelId === bindingModel.id && binding.enabled).map((binding) => binding.featureId)}
                            onApply={(ids) => {
                                const current = value.bindings.filter((binding) => binding.modelId === bindingModel.id && binding.enabled).map((binding) => binding.featureId);
                                if (ids.length !== current.length || ids.some((id) => !current.includes(id))) bindModelFeatures(bindingModel, ids);
                                setBindingModelId("");
                            }}
                            onClose={() => setBindingModelId("")}
                        />
                    )}
                    <Drawer width="min(720px, 100vw)" title={<span className="break-words">接入渠道 · {viewingRoutesModel?.displayName}</span>} open={!!viewingRoutesModel} onClose={() => setViewingRoutesId("")}>
                        <Table
                            size="small"
                            rowKey="id"
                            pagination={false}
                            scroll={{ x: 560 }}
                            dataSource={value.routes.filter((route) => viewingRoutesModel?.routeIds.includes(route.id))}
                            columns={[
                                { title: "渠道", width: 150, render: (_, route) => channels.find((channel) => channel.id === route.channelId)?.name || route.channelId },
                                { title: "真实模型", dataIndex: "model", width: 180 },
                                { title: "适配器", dataIndex: "adapter", width: 140 },
                                {
                                    title: "状态",
                                    width: 100,
                                    render: (_, route) => (!route.enabled ? <Tag>接入停用</Tag> : !channels.some((channel) => channel.id === route.channelId && channel.enabled) ? <Tag>渠道停用</Tag> : <Tag color="success">启用</Tag>),
                                },
                            ]}
                        />
                    </Drawer>
                    <Drawer
                        forceRender
                        width="min(640px, 100vw)"
                        title="平台模型"
                        open={!!editingModel}
                        onClose={() => setEditingModel(null)}
                        extra={
                            <Button type="primary" onClick={() => void applyModelDraft()}>
                                应用到草稿
                            </Button>
                        }
                    >
                        <Form name="managed-model" form={modelForm} layout="vertical">
                            <Form.Item name="id" hidden>
                                <Input />
                            </Form.Item>
                            <Form.Item name="internalName" label="内部名称">
                                <Input />
                            </Form.Item>
                            <Form.Item name="displayName" label="前台名称" rules={[{ required: true }]}>
                                <Input />
                            </Form.Item>
                            <Form.Item name="displayMode" label="展示方式">
                                <Select
                                    options={[
                                        { value: "alias", label: "仅别名" },
                                        { value: "real", label: "真实模型 ID" },
                                        { value: "both", label: "别名与真实模型 ID" },
                                    ]}
                                />
                            </Form.Item>
                            <Form.Item name="description" label="用途说明">
                                <Input.TextArea rows={2} />
                            </Form.Item>
                            <Form.Item name="routeIds" label="渠道模型">
                                <Select mode="multiple" options={value.routes.map((r) => ({ value: r.id, label: routeLabel(r) }))} />
                            </Form.Item>
                            <Form.Item name="enabled" label="启用" valuePropName="checked">
                                <Switch disabled={priceStatus === "unconfigured"} />
                            </Form.Item>
                            <Form.Item label="价格状态">
                                <Select
                                    value={priceStatus}
                                    onChange={(status) => {
                                        setPriceStatus(status);
                                        if (status === "unconfigured") modelForm.setFieldValue("enabled", false);
                                    }}
                                    options={[
                                        { value: "unconfigured", label: "待定价" },
                                        { value: "free", label: "明确免费" },
                                        { value: "fixed", label: "已配置收费" },
                                    ]}
                                />
                            </Form.Item>
                            <Form.Item label="计费方式">
                                <Select
                                    value={priceMode}
                                    onChange={setPriceMode}
                                    options={[
                                        { value: "fixed", label: "固定点数 / 次" },
                                        { value: "duration_resolution", label: "通用视频 · 时长与规格" },
                                        { value: "cloud", label: "专用模型计费" },
                                    ]}
                                />
                            </Form.Item>
                            {priceMode === "fixed" && priceStatus === "fixed" && (
                                <Form.Item name={["pricing", "credits"]} label="固定点数">
                                    <InputNumber min={1} precision={0} />
                                </Form.Item>
                            )}
                            {priceMode === "duration_resolution" && (
                                <>
                                    <Form.Item name={["pricing", "video", "billingMode"]} initialValue="duration_resolution" hidden>
                                        <Input />
                                    </Form.Item>
                                    <Form.Item name={["pricing", "video", "minimumCredits"]} label="最低点数">
                                        <InputNumber min={0} />
                                    </Form.Item>
                                    <Form.Item name={["pricing", "video", "billingTiers"]} label="各分辨率点数 / 秒" rules={jsonObjectRules}>
                                        <JsonInput rows={4} />
                                    </Form.Item>
                                </>
                            )}
                            {priceMode === "cloud" && (
                                <>
                                    <Form.Item name={["pricing", "replicate", "billingMode"]} label="计费单位">
                                        <Select options={["fixed", "input_characters", "input_seconds", "output_seconds", "duration_resolution", "runtime_seconds", "output_count"].map((v) => ({ value: v, label: v }))} />
                                    </Form.Item>
                                    {["unitCredits", "minimumCredits", "defaultUnits", "blockSeconds"].map((field) => (
                                        <Form.Item key={field} name={["pricing", "replicate", field]} label={{ unitCredits: "单价", minimumCredits: "最低点数", defaultUnits: "现有备用计费单位", blockSeconds: "现有每档秒数" }[field]}>
                                            <InputNumber min={0} />
                                        </Form.Item>
                                    ))}
                                    <Form.Item name={["pricing", "replicate", "tiers"]} label="规格报价" rules={jsonObjectRules}>
                                        <JsonInput />
                                    </Form.Item>
                                </>
                            )}
                        </Form>
                    </Drawer>
                    <ModelConnectionWizard
                        open={wizardOpen}
                        channels={channels}
                        models={value.models}
                        routes={value.routes}
                        bindings={value.bindings}
                        features={features}
                        initial={wizardSeed}
                        onCancel={() => {
                            setWizardOpen(false);
                            setWizardSeed(undefined);
                        }}
                        onApply={applyConnectionWizard}
                    />
                    {removalTarget && (
                        <ModelRemovalWizard
                            open
                            channelId={removalTarget.channelId}
                            channelName={channels.find((channel) => channel.id === removalTarget.channelId)?.name || `渠道 ${removalTarget.channelId}`}
                            model={removalTarget.model}
                            management={value}
                            baseline={baseline}
                            features={features}
                            onCancel={() => setRemovalTarget(undefined)}
                            onDisableAndSave={disableRemovalRoutes}
                            onRemoveAndSave={removeTargetRoutes}
                        />
                    )}
                    <Drawer
                        forceRender
                        width="min(640px, 100vw)"
                        title="渠道模型"
                        open={!!editingRoute}
                        onClose={() => setEditingRoute(null)}
                        extra={
                            <Button
                                type="primary"
                                onClick={async () => {
                                    await routeForm.validateFields();
                                    const route = routeForm.getFieldsValue(true);
                                    setValue({ ...value, routes: [...value.routes.filter((r) => r.id !== route.id), route] });
                                    setEditingRoute(null);
                                }}
                            >
                                应用到草稿
                            </Button>
                        }
                    >
                        <Form name="managed-route" form={routeForm} layout="vertical">
                            <Form.Item name="id" hidden>
                                <Input />
                            </Form.Item>
                            <Form.Item name="channelId" label="渠道" rules={[{ required: true }]}>
                                <Select disabled={value.routes.some((r) => r.id === editingRoute?.id)} options={channels.map((c) => ({ value: c.id, label: c.name }))} onChange={() => routeForm.setFieldValue("model", "")} />
                            </Form.Item>
                            <Form.Item noStyle shouldUpdate={(p, n) => p.channelId !== n.channelId}>
                                {() => (
                                    <Form.Item name="model" label="上游真实模型 ID" rules={[{ required: true }]}>
                                        <Select showSearch disabled={value.routes.some((r) => r.id === editingRoute?.id)} options={(channels.find((c) => c.id === routeForm.getFieldValue("channelId"))?.models || []).map((m) => ({ value: m, label: m }))} />
                                    </Form.Item>
                                )}
                            </Form.Item>
                            <Form.Item noStyle shouldUpdate={(previous, current) => previous.channelId !== current.channelId || previous.model !== current.model}>
                                {() => (
                                    <Form.Item name="adapter" label="调用适配器">
                                        <Select
                                            disabled={value.routes.some((r) => r.id === editingRoute?.id)}
                                            options={modelAdapterOptionsForChannel(channels, Number(routeForm.getFieldValue("channelId")), routeForm.getFieldValue("model"))}
                                            onChange={(adapter) => routeForm.setFieldsValue(adapterRouteDefaults(adapter))}
                                        />
                                    </Form.Item>
                                )}
                            </Form.Item>
                            <Form.Item name="capability" label="能力类型">
                                <Select options={capabilityOptions.filter((option) => option.value !== "all")} />
                            </Form.Item>
                            <Form.Item name="operations" label="已适配操作">
                                <Select mode="tags" />
                            </Form.Item>
                            <Form.Item name="version" label="上游固定版本">
                                <Input disabled={value.routes.some((r) => r.id === editingRoute?.id)} />
                            </Form.Item>
                            <Form.Item name="enabled" label="启用" valuePropName="checked">
                                <Switch />
                            </Form.Item>
                            <Form.Item noStyle shouldUpdate={(p, n) => p.capability !== n.capability || p.adapter !== n.adapter}>
                                {() =>
                                    routeForm.getFieldValue("capability") === "video" &&
                                    !String(routeForm.getFieldValue("adapter")).startsWith("cloud:") && (
                                        <>
                                            <Form.Item name={["video", "interface"]} label="视频接口">
                                                <Select options={["openai", "relay", "ark", "sparkcine_h3"].map((v) => ({ value: v, label: v }))} />
                                            </Form.Item>
                                            <Form.Item name={["video", "resolutions"]} label="输出清晰度">
                                                <Select mode="tags" tokenSeparators={[","]} />
                                            </Form.Item>
                                            <Form.Item name={["video", "seconds"]} label="输出秒数">
                                                <Select mode="tags" tokenSeparators={[","]} />
                                            </Form.Item>
                                            <Form.Item name={["video", "inputModes"]} label="输入方式">
                                                <Select
                                                    mode="multiple"
                                                    options={[
                                                        { value: "reference", label: "多素材参考" },
                                                        { value: "first_last", label: "首尾帧" },
                                                        { value: "first_frame_only", label: "文生 / 单首帧" },
                                                    ]}
                                                />
                                            </Form.Item>
                                            {["maxImages", "maxVideos", "maxAudios", "referenceVideoMinSeconds", "referenceVideoMaxSeconds"].map((field) => (
                                                <Form.Item
                                                    key={field}
                                                    name={["video", field]}
                                                    label={{ maxImages: "最多参考图片", maxVideos: "最多参考视频", maxAudios: "最多参考音频", referenceVideoMinSeconds: "参考视频最短秒数", referenceVideoMaxSeconds: "参考视频最长秒数" }[field]}
                                                >
                                                    <InputNumber min={0} />
                                                </Form.Item>
                                            ))}
                                            <Form.Item name={["video", "firstFrameField"]} label="首帧字段">
                                                <Input />
                                            </Form.Item>
                                            <Form.Item name={["video", "lastFrameField"]} label="尾帧字段">
                                                <Input />
                                            </Form.Item>
                                            <Form.Item name={["video", "firstFrameRequired"]} label="首帧必填" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                            <Form.Item name={["video", "lastFrameOptional"]} label="尾帧可选" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                            <Form.Item name={["video", "generateAudio"]} label="支持生成声音" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </>
                                    )
                                }
                            </Form.Item>
                        </Form>
                    </Drawer>
                </>
            )}
        </div>
    );
}
