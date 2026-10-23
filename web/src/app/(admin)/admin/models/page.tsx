"use client";

import { useEffect, useState, type Key } from "react";
import { Alert, App, Button, Checkbox, Drawer, Flex, Form, Input, InputNumber, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import { CopyOutlined, EditOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons";
import { nanoid } from "nanoid";
import { fetchModelManagement, previewModelManagement, saveModelManagement, type FeatureBinding, type ManagedModel, type ManagedRoute, type ModelFeature, type ModelManagement } from "@/services/api/model-management";
import type { AdminModelChannel } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";
import { useConfigStore } from "@/stores/use-config-store";
import { JsonInput, jsonObjectRules } from "./json-input";
import { FeatureBindingsDrawer } from "./components/feature-bindings-drawer";

const empty: ModelManagement = { enabled: false, revision: 0, routes: [], models: [], bindings: [] };
const capabilityOptions = [{ value: "all", label: "全部" }, { value: "text", label: "文字" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }];
const featureModule = (feature: ModelFeature) => feature.module.split(" · ")[0];
const adapterOptions = [
    ["text.openai", "文字 · OpenAI"], ["image.openai", "图片 · OpenAI"], ["image.responses", "图片 · Responses"], ["audio.openai", "音频 · OpenAI"],
    ["video.openai", "视频 · OpenAI"], ["video.relay", "视频 · JSON 中转"], ["video.ark", "视频 · 火山多素材"], ["video.sparkcine_h3", "视频 · SparkCine H3"],
    ["video.wan30", "视频 · Wan30"], ["video.h3-2k", "视频 · H3 2K"], ["video.minimax-h3", "视频 · MiniMax H3"], ["video.minimax-h3-frames", "视频 · MiniMax H3 首尾帧"],
    ...["text-to-video", "image-to-video", "hailuo-video", "speech", "transcribe", "digital-human", "lipsync", "replace-person", "head-swap", "upscale", "video-edit", "subtitle-remove", "masked-edit", "cutout-replicate", "upscale-replicate"].map((operation) => [`cloud:${operation}`, `专用接口 · ${operation}`]),
].map(([value, label]) => ({ value, label }));

export default function ModelManagementPage() {
    const token = useUserStore((s) => s.token);
    const { message, modal } = App.useApp();
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
    const routeLabel = (route: ManagedRoute) => `${channels.find((c) => c.id === route.channelId)?.name || route.channelId} / ${route.model}`;
    const load = async () => {
        setLoading(true);
        setLoaded(false);
        setLoadError("");
        try {
            const result = await fetchModelManagement(token);
            setValue(result.management || empty); setBaseline(result.management || empty);
            setFeatures(result.features); setChannels(result.channels); setWarnings([]);
            setLoaded(true);
        } catch (e) { setLoadError(e instanceof Error ? e.message : "读取失败"); }
        finally { setLoading(false); }
    };
    useEffect(() => { void load(); }, [token]);
    useEffect(() => {
        setSelectedModels([]);
        setPage(1);
    }, [capabilityFilter, keyword, module, channelFilter, adapterFilter, protocolFilter, statusFilter, activeView, selectedFeature]);
    const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
    useEffect(() => {
        const protect = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", protect);
        return () => window.removeEventListener("beforeunload",protect);
    }, [dirty]);
    const replaceDraft = (action: () => void) => dirty ? modal.confirm({title:"替换未保存草稿",content:"当前修改尚未保存，继续将替换当前草稿。",onOk:action}) : action();
    const editModel = (entry: ManagedModel) => {
        modelForm.resetFields(); setEditingModel(structuredClone(entry)); modelForm.setFieldsValue(structuredClone(entry));
        setPriceMode(entry.pricing.replicate ? "cloud" : entry.pricing.video ? "duration_resolution" : "fixed");
    };
    const editRoute = (route: ManagedRoute) => { routeForm.resetFields(); setEditingRoute(structuredClone(route)); routeForm.setFieldsValue(structuredClone(route)); };
    const bulkBind = (enabled: boolean) => setValue((current) => {
        const bindings = [...current.bindings];
        for (const entry of current.models.filter((m) => selectedModels.includes(m.id))) for (const id of bulkFeatures) {
            const feature = features.find((f) => f.id === id);
            const routes = current.routes.filter((r) => entry.routeIds.includes(r.id) && r.capability === feature?.capability && r.operations.some((op) => feature.operations.includes(op)));
            if (!routes.length) continue;
            const index = bindings.findIndex((b) => b.featureId === id && b.modelId === entry.id);
            const old = bindings[index] || { featureId:id,modelId:entry.id,routeIds:routes.map((r) => r.id),order:bindings.length,default:false,enabled:false };
            const next = { ...old,enabled,default:enabled && old.default };
            if (index >= 0) bindings[index] = next; else bindings.push(next);
        }
        return {...current,bindings};
    });
    const patchBinding = (entry: ManagedModel, patch: Partial<FeatureBinding>) => setValue((current) => {
        let bindings = [...current.bindings];
        const index = bindings.findIndex((b) => b.featureId === selectedFeature && b.modelId === entry.id);
        const old = index >= 0 ? bindings[index] : { featureId: selectedFeature, modelId: entry.id, routeIds: entry.routeIds, enabled: false, default: false, order: bindings.length };
        const next = { ...old, ...patch };
        if (!next.enabled) next.default = false;
        if (next.default) bindings = bindings.map((b) => b.featureId === selectedFeature ? { ...b, default: false } : b);
        if (index >= 0) bindings[index] = next; else bindings.push(next);
        return { ...current, bindings };
    });
    const save = () => {
        if (!loaded || loading) return;
        const changedModels = value.models.filter((entry) => JSON.stringify(entry) !== JSON.stringify(baseline.models.find((old) => old.id === entry.id)));
        const changedRoutes = value.routes.filter((route) => JSON.stringify(route) !== JSON.stringify(baseline.routes.find((old) => old.id === route.id)));
        const affected = new Set(value.bindings.filter((b) => JSON.stringify(b) !== JSON.stringify(baseline.bindings.find((old) => old.featureId === b.featureId && old.modelId === b.modelId)) || changedModels.some((m) => m.id === b.modelId) || changedRoutes.some((r) => b.routeIds.includes(r.id))).map((b) => b.featureId));
        const priceChanges = changedModels.filter((entry) => JSON.stringify(entry.pricing) !== JSON.stringify(baseline.models.find((old) => old.id === entry.id)?.pricing));
        const defaults = [...affected].filter((id) => value.bindings.find((b) => b.featureId === id && b.default)?.modelId !== baseline.bindings.find((b) => b.featureId === id && b.default)?.modelId);
        const modelName = (id?: string) => value.models.find((m) => m.id === id)?.displayName || "无";
        modal.confirm({
            title: "保存模型配置",
            width: 640,
            content: <Space direction="vertical" className="max-h-[65vh] w-full overflow-auto break-words"><span>平台模型变更 {changedModels.length} 项，渠道模型变更 {changedRoutes.length} 项，涉及功能步骤 {affected.size} 项。</span><span>{value.enabled ? "保存后新报价与新生成使用此配置；未提交报价需重新确认。" : "统一模型目录尚未启用，现有入口继续使用原配置。"}</span><Typography.Text type="secondary">{[...affected].map((id) => {const f = features.find((f) => f.id === id);return f ? `${f.module} · ${f.label}` : id;}).join("、")}</Typography.Text>{defaults.map((id) => <div key={id}>默认模型：{features.find((f) => f.id === id)?.label}，{modelName(baseline.bindings.find((b) => b.featureId === id && b.default)?.modelId)} → {modelName(value.bindings.find((b) => b.featureId === id && b.default)?.modelId)}</div>)}{changedModels.filter((entry) => JSON.stringify(entry.routeIds) !== JSON.stringify(baseline.models.find((m) => m.id === entry.id)?.routeIds)).map((entry) => <div key={`routes-${entry.id}`}>{entry.displayName} · 允许接入：{entry.routeIds.map((id) => value.routes.find((r) => r.id === id)).filter((r): r is ManagedRoute => !!r).map(routeLabel).join("；") || "无"}</div>)}{priceChanges.map((entry) => <div key={entry.id}>{entry.displayName} · 报价变化<pre className="whitespace-pre-wrap text-xs">{JSON.stringify(baseline.models.find((old) => old.id === entry.id)?.pricing || {},null,2)}{"\n→\n"}{JSON.stringify(entry.pricing,null,2)}</pre></div>)}</Space>,
            onOk: async () => {
                try {
                    const saved = await saveModelManagement(token, value);
                    setValue(saved); setBaseline(saved); message.success("模型配置已保存");
                    window.localStorage.setItem("platform-model-catalog-revision", String(saved.revision));
                    window.dispatchEvent(new Event("platform-model-catalog-changed"));
                    void useConfigStore.getState().loadPublicSettings();
                } catch (e) {
                    message.error(e instanceof Error ? e.message : "保存失败");
                    throw e;
                }
            },
        });
    };
    const availableFeatures = features.filter((entry) => !capabilityFilter || entry.capability === capabilityFilter);
    const matchingFeatures = availableFeatures.filter((entry) => !module || featureModule(entry) === module);
    const feature = matchingFeatures.find((entry) => entry.id === selectedFeature);
    const moduleBindings = value.bindings.filter((binding) => binding.enabled && matchingFeatures.some((entry) => entry.id === binding.featureId));
    const routeMatchesFilters = (route: ManagedRoute) => (!capabilityFilter || route.capability === capabilityFilter) &&
        (channelFilter === undefined || route.channelId === channelFilter) && (!adapterFilter || route.adapter === adapterFilter) &&
        (!protocolFilter || channels.some((channel) => channel.id === route.channelId && channel.protocol === protocolFilter));
    const matchingModels = value.models.filter((entry) => {
        if (keyword && !`${entry.displayName} ${entry.internalName} ${entry.id}`.toLowerCase().includes(keyword.toLowerCase())) return false;
        if (statusFilter !== undefined && String(entry.enabled) !== statusFilter) return false;
        return value.routes.some((route) => entry.routeIds.includes(route.id) && routeMatchesFilters(route)) || !entry.routeIds.length && !capabilityFilter && channelFilter === undefined && !adapterFilter && !protocolFilter;
    });
    const platformModels = matchingModels.filter((entry) => !module || moduleBindings.some((binding) => binding.modelId === entry.id &&
        value.routes.some((route) => entry.routeIds.includes(route.id) && binding.routeIds.includes(route.id) && routeMatchesFilters(route))));
    const matchingRoutes = value.routes.filter((route) =>
        (!keyword || routeLabel(route).toLowerCase().includes(keyword.toLowerCase())) &&
        routeMatchesFilters(route) &&
        (statusFilter === undefined || String(route.enabled) === statusFilter) &&
        (!module || moduleBindings.some((binding) => binding.routeIds.includes(route.id) && value.models.some((entry) => entry.id === binding.modelId && entry.routeIds.includes(route.id)))));
    const bindModelFeatures = (entry: ManagedModel, ids: string[]) => setValue((current) => ({
        ...current,
        bindings: [
            ...current.bindings.filter((b) => b.modelId !== entry.id || !ids.includes(b.featureId)).map((b) => b.modelId === entry.id ? {...b,enabled:false,default:false} : b),
            ...ids.map((id,index) => {
                const old = current.bindings.find((b) => b.modelId === entry.id && b.featureId === id);
                const feature = features.find((f) => f.id === id);
                return {...old,featureId:id,modelId:entry.id,routeIds:old?.routeIds || current.routes.filter((r) => entry.routeIds.includes(r.id) && r.capability === feature?.capability && r.operations.some((op) => feature.operations.includes(op))).map((r) => r.id),enabled:true,default:old?.default || false,order:old?.order ?? index};
            }),
        ],
    }));
    const availability = (entry: ManagedModel) => !entry.enabled ? "平台模型停用" : !entry.pricing.configured ? "价格未配置" : !value.routes.some((r) => entry.routeIds.includes(r.id) && r.enabled && channels.some((c) => c.id === r.channelId && c.enabled)) ? "无已启用渠道" : "按功能绑定及用户分组生效";
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
        setCapabilityFilter(undefined); setKeyword(""); setModule(undefined); setChannelFilter(undefined);
        setAdapterFilter(undefined); setProtocolFilter(undefined); setStatusFilter(undefined);
        setSelectedFeature(""); setSelectedModels([]); setBulkFeatures([]);
    };
    const filtered = !!(capabilityFilter || keyword || module || channelFilter !== undefined || adapterFilter || protocolFilter || statusFilter !== undefined || selectedFeature);
    const bindingModel = value.models.find((entry) => entry.id === bindingModelId);
    const viewingRoutesModel = value.models.find((entry) => entry.id === viewingRoutesId);
    return <div className="flex flex-col gap-3 p-4 sm:p-6">
        <Flex gap={12} wrap align="center" justify="space-between">
            <Space wrap><Typography.Title level={4} style={{ margin: 0 }}>模型管理</Typography.Title><Tag>版本 {value.revision}</Tag><Switch disabled={!loaded || loading} checked={value.enabled} checkedChildren="已启用" unCheckedChildren="未启用" onChange={(enabled) => setValue({ ...value, enabled })} /></Space>
            <Space wrap><Button icon={<ReloadOutlined />} onClick={() => replaceDraft(() => void load())} loading={loading}>重新加载</Button><Button disabled={!loaded || loading} onClick={() => replaceDraft(async () => { try { const result = await previewModelManagement(token); setValue(result.management); setWarnings(result.warnings); message.success("已生成转换草稿，核对后保存生效"); } catch (e) { message.error(e instanceof Error ? e.message : "预览失败"); } })}>转换现有配置预览</Button><Button disabled={!loaded || loading} type="primary" icon={<SaveOutlined />} onClick={save}>保存配置</Button></Space>
        </Flex>
        {loadError && <Alert type="error" showIcon title="模型配置读取失败" description={`${loadError}。请确认后端运行当前版本后重新加载，读取成功前不能编辑或保存。`} />}
        {loaded && <>
        {warnings.length > 0 && <Alert type="warning" showIcon title="转换预览" description={<div className="max-h-40 overflow-auto">{warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div>} />}
        <div role="group" aria-label="模型能力分类">
            <Segmented block name="model-capability" value={capabilityFilter || "all"} onChange={changeCapability} className="w-full sm:!w-fit"
                options={categories.map(({ value, label, count }) => ({ value, tooltip: `${label}平台模型：${count} 个`, label: <span className="flex flex-col items-center py-1 leading-5 sm:flex-row sm:gap-2 sm:py-0"><span>{label}</span><span className="text-xs tabular-nums">{count}</span></span> }))} />
        </div>
        <Flex gap={12} wrap align="center">
            <Input.Search aria-label="搜索模型" placeholder="搜索名称、内部名称、编号" value={keyword} onChange={(e) => setKeyword(e.target.value)} allowClear className="min-w-0 flex-1 sm:flex-none" style={{ width: 416, maxWidth: "100%" }} />
            <Tooltip title="重置筛选"><Button aria-label="重置筛选" icon={<UndoOutlined />} disabled={!filtered} onClick={resetFilters}><span className="hidden sm:inline">重置筛选</span></Button></Tooltip>
        </Flex>
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
            <Select aria-label="适用模块" allowClear showSearch optionFilterProp="label" placeholder="适用模块" className="w-full sm:w-[200px]" value={module} onChange={(next) => { setModule(next); setSelectedFeature(""); setBulkFeatures([]); }} options={modules.map((name) => ({ value: name, label: name }))} />
            <Select aria-label="接入渠道" allowClear placeholder="接入渠道" className="w-full sm:w-[180px]" value={channelFilter} onChange={setChannelFilter} options={channels.map((c) => ({value:c.id,label:c.name}))} />
            <Select aria-label="启用状态" allowClear placeholder="启用状态" className="w-full sm:w-[140px]" value={statusFilter} onChange={setStatusFilter} options={[{value:"true",label:"启用"},{value:"false",label:"停用"}]} />
            <Select aria-label="调用协议" allowClear placeholder="调用协议" className="w-full sm:w-[160px]" value={protocolFilter} onChange={setProtocolFilter} options={[...new Set(channels.map((c) => c.protocol))].map((value) => ({value,label:value}))} />
            <Select aria-label="调用适配器" allowClear showSearch optionFilterProp="label" placeholder="调用适配器" className="w-full sm:w-[240px]" value={adapterFilter} onChange={setAdapterFilter} options={adapterOptions} />
        </div>
        {activeView === "models" && <Flex gap={8} wrap><Select mode="multiple" maxTagCount={1} aria-label="批量功能" placeholder="批量选择功能步骤" style={{ width:320,maxWidth:"100%" }} value={bulkFeatures} onChange={setBulkFeatures} options={matchingFeatures.map((f) => ({value:f.id,label:`${f.module} · ${f.label}`}))} /><Button disabled={!selectedModels.length || !bulkFeatures.length} onClick={() => bulkBind(true)}>批量绑定</Button><Button disabled={!selectedModels.length || !bulkFeatures.length} onClick={() => bulkBind(false)}>批量解绑</Button></Flex>}
        <Tabs activeKey={activeView} onChange={setActiveView} items={[
            { key: "models", label: `平台模型 (${platformModels.length})`, children: <>
                <Space wrap className="mb-3"><Button icon={<PlusOutlined />} onClick={() => editModel({ id: `model_${nanoid().replaceAll("-", "_")}`, internalName: "", displayName: "", displayMode: "alias", description: "", enabled: false, routeIds: [], pricing: { configured: false, free: false, credits: 0 } })}>新增平台模型</Button><Button disabled={!selectedModels.length} onClick={() => setValue({ ...value, models: value.models.map((m) => selectedModels.includes(m.id) ? { ...m, enabled: false } : m), bindings: value.bindings.map((b) => selectedModels.includes(b.modelId) ? { ...b, default: false } : b) })}>批量停用</Button></Space>
                <Table rowKey="id" dataSource={platformModels} pagination={{ current: page, onChange: setPage }} scroll={{ x: 1130 }} rowSelection={{ columnWidth: 48, selectedRowKeys: selectedModels, onChange: setSelectedModels }} columns={[
                    { title: "前台名称", width: 150, dataIndex: "displayName", render: (name, entry) => <div className="min-w-0"><div className="truncate" title={name}>{name}</div><Typography.Text type="secondary" ellipsis title={entry.internalName} style={{ display: "block" }}>{entry.internalName}</Typography.Text></div> },
                    { title: "展示方式", width: 130, dataIndex: "displayMode", render: (mode) => ({ alias: "仅别名", real: "真实 ID", both: "别名与真实 ID" }[mode as "alias"]) },
                    { title: "接入渠道", width: 160, render: (_, entry) => {
                        const routes = value.routes.filter((route) => entry.routeIds.includes(route.id));
                        const enabled = routes.filter((route) => route.enabled && channels.some((channel) => channel.id === route.channelId && channel.enabled)).length;
                        return <div><Button type="link" className="!px-0" icon={<EyeOutlined />} aria-label={`${entry.displayName} · 查看接入渠道`} onClick={() => setViewingRoutesId(entry.id)}>{routes.length} 个接入</Button><Typography.Text type="secondary" style={{ display: "block" }}>启用 {enabled} 个</Typography.Text></div>;
                    } },
                    { title: "价格", width: 110, render: (_, entry) => !entry.pricing.configured ? <Tag color="warning">未配置</Tag> : entry.pricing.free ? "免费" : entry.pricing.video ? "按秒/规格" : entry.pricing.replicate ? entry.pricing.replicate.billingMode : `${entry.pricing.credits} 点/次` },
                    { title: "可用状态", width: 180, render: (_,entry) => availability(entry) },
                    { title: "适用功能", width: 160, render: (_, entry) => <Button type="link" className="!px-0" icon={<EditOutlined />} aria-label={`${entry.displayName} · 管理适用功能`} onClick={() => setBindingModelId(entry.id)}>已绑定 {value.bindings.filter((binding) => binding.modelId === entry.id && binding.enabled).length} 项</Button> },
                    { title: "启用", width: 80, render: (_, entry) => <Switch checked={entry.enabled} onChange={(enabled) => setValue({ ...value, models: value.models.map((m) => m.id === entry.id ? { ...m, enabled } : m), bindings: value.bindings.map((b) => b.modelId === entry.id && !enabled ? { ...b, default: false } : b) })} /> },
                    { title: "操作", width: 112, fixed: "right", render: (_, entry) => <Space><Button icon={<EditOutlined />} aria-label="编辑模型" onClick={() => editModel(entry)} /><Button icon={<CopyOutlined />} aria-label="复制模型" onClick={() => editModel({ ...structuredClone(entry), id: `model_${nanoid().replaceAll("-", "_")}`, displayName: `${entry.displayName} 副本`, enabled: false })} /></Space> },
                ]} />
            </> },
            { key: "features", label: "功能绑定", children: <>
                <Select aria-label="功能步骤" showSearch optionFilterProp="label" placeholder="选择功能步骤" value={selectedFeature || undefined} onChange={setSelectedFeature} style={{ width: 400, maxWidth: "100%" }} className="mb-4" options={matchingFeatures.map((f) => ({ value: f.id, label: `${f.module} · ${f.label}` }))} />
                {feature && <Table rowKey="id" pagination={{ current: page, onChange: setPage }} scroll={{ x: 1050 }} dataSource={matchingModels.filter((m) => value.routes.some((r) => m.routeIds.includes(r.id) && routeMatchesFilters(r) && r.capability === feature.capability && r.operations.some((op) => feature.operations.includes(op))))} columns={[
                    { title: "平台模型", dataIndex: "displayName" },
                    { title: "允许使用", render: (_, entry) => <Switch checked={value.bindings.some((b) => b.featureId === selectedFeature && b.modelId === entry.id && b.enabled)} onChange={(enabled) => patchBinding(entry, { enabled })} /> },
                    { title: "默认", render: (_, entry) => <Checkbox checked={value.bindings.some((b) => b.featureId === selectedFeature && b.modelId === entry.id && b.default)} disabled={!entry.enabled || !value.bindings.some((b) => b.featureId === selectedFeature && b.modelId === entry.id && b.enabled)} onChange={(e) => patchBinding(entry, { default: e.target.checked })} /> },
                    { title: "顺序", render: (_, entry) => <InputNumber min={0} value={value.bindings.find((b) => b.featureId === selectedFeature && b.modelId === entry.id)?.order || 0} onChange={(order) => patchBinding(entry, { order: order || 0 })} /> },
                    { title: "允许渠道", render: (_, entry) => <Select mode="multiple" maxTagCount={1} style={{ width: 220 }} value={value.bindings.find((b) => b.featureId === selectedFeature && b.modelId === entry.id)?.routeIds || entry.routeIds} options={value.routes.filter((r) => entry.routeIds.includes(r.id)).map((r) => ({ value: r.id, label: routeLabel(r) }))} onChange={(routeIds) => patchBinding(entry, { routeIds })} /> },
                    { title: "输出规格子集", render: (_, entry) => { const binding = value.bindings.find((b) => b.featureId === selectedFeature && b.modelId === entry.id); const route = value.routes.find((r) => entry.routeIds.includes(r.id)); return route?.video ? <Space direction="vertical"><Select mode="multiple" placeholder="全部清晰度" style={{ minWidth: 150 }} value={binding?.resolutions} options={route.video.resolutions.map((v) => ({ value: v, label: v }))} onChange={(resolutions) => patchBinding(entry, { resolutions })} /><Select mode="multiple" placeholder="全部时长" style={{ minWidth: 150 }} value={binding?.seconds} options={route.video.seconds.map((v) => ({ value: v, label: `${v}秒` }))} onChange={(seconds) => patchBinding(entry, { seconds })} /></Space> : null; } },
                ]} />}
            </> },
            { key: "routes", label: `渠道模型 (${matchingRoutes.length})`, children: <><Space wrap className="mb-3"><Button href="/admin/settings">渠道与密钥设置</Button><Button icon={<PlusOutlined />} onClick={() => { const capability = capabilityFilter || "text"; editRoute({ id: `route_${nanoid().replaceAll("-", "_")}`, channelId: channels[0]?.id || 0, model: "", adapter: `${capability}.openai`, capability, operations: [capability], enabled: false }); }}>新增渠道模型</Button></Space><Table rowKey="id" pagination={{ current: page, onChange: setPage }} scroll={{ x: 800 }} dataSource={matchingRoutes} columns={[{ title: "渠道 / 真实模型", render: (_, route) => routeLabel(route) }, { title: "适配器", dataIndex: "adapter" }, { title: "类型", dataIndex: "capability", render: (capability) => capabilityOptions.find((option) => option.value === capability)?.label || capability }, { title: "状态", render: (_, route) => route.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> }, { title: "操作", render: (_, route) => <Button icon={<EditOutlined />} onClick={() => editRoute(route)}>编辑</Button> }]} /></> },
        ]} />
        {bindingModel && <FeatureBindingsDrawer key={bindingModel.id} name={bindingModel.displayName}
            features={features.filter((feature) => value.routes.some((route) => bindingModel.routeIds.includes(route.id) && route.capability === feature.capability && route.operations.some((operation) => feature.operations.includes(operation))))}
            selectedIds={value.bindings.filter((binding) => binding.modelId === bindingModel.id && binding.enabled).map((binding) => binding.featureId)}
            onApply={(ids) => {
                const current = value.bindings.filter((binding) => binding.modelId === bindingModel.id && binding.enabled).map((binding) => binding.featureId);
                if (ids.length !== current.length || ids.some((id) => !current.includes(id))) bindModelFeatures(bindingModel, ids);
                setBindingModelId("");
            }}
            onClose={() => setBindingModelId("")} />}
        <Drawer width="min(720px, 100vw)" title={<span className="break-words">接入渠道 · {viewingRoutesModel?.displayName}</span>} open={!!viewingRoutesModel} onClose={() => setViewingRoutesId("")}>
            <Table size="small" rowKey="id" pagination={false} scroll={{ x: 560 }} dataSource={value.routes.filter((route) => viewingRoutesModel?.routeIds.includes(route.id))}
                columns={[
                    { title: "渠道", width: 150, render: (_, route) => channels.find((channel) => channel.id === route.channelId)?.name || route.channelId },
                    { title: "真实模型", dataIndex: "model", width: 180 },
                    { title: "适配器", dataIndex: "adapter", width: 140 },
                    { title: "状态", width: 100, render: (_, route) => !route.enabled ? <Tag>接入停用</Tag> : !channels.some((channel) => channel.id === route.channelId && channel.enabled) ? <Tag>渠道停用</Tag> : <Tag color="success">启用</Tag> },
                ]} />
        </Drawer>
        <Drawer forceRender width="min(640px, 100vw)" title="平台模型" open={!!editingModel} onClose={() => setEditingModel(null)} extra={<Button type="primary" onClick={async () => { await modelForm.validateFields(); const entry = modelForm.getFieldsValue(true); if (priceMode !== "cloud") entry.pricing.replicate = undefined; if (priceMode !== "duration_resolution") entry.pricing.video = undefined; setValue({ ...value, models: [...value.models.filter((m) => m.id !== entry.id), entry], bindings: value.bindings.map((b) => b.modelId === entry.id && !entry.enabled ? { ...b, default: false } : b) }); setEditingModel(null); }}>应用到草稿</Button>}>
            <Form name="managed-model" form={modelForm} layout="vertical">
                <Form.Item name="id" hidden><Input /></Form.Item><Form.Item name="internalName" label="内部名称"><Input /></Form.Item>
                <Form.Item name="displayName" label="前台名称" rules={[{ required: true }]}><Input /></Form.Item>
                <Form.Item name="displayMode" label="展示方式"><Select options={[{ value: "alias", label: "仅别名" }, { value: "real", label: "真实模型 ID" }, { value: "both", label: "别名与真实模型 ID" }]} /></Form.Item>
                <Form.Item name="description" label="用途说明"><Input.TextArea rows={2} /></Form.Item>
                <Form.Item name="routeIds" label="渠道模型"><Select mode="multiple" options={value.routes.map((r) => ({ value: r.id, label: routeLabel(r) }))} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                <Form.Item name={["pricing", "configured"]} label="价格已配置" valuePropName="checked"><Switch /></Form.Item>
                <Form.Item name={["pricing", "free"]} label="明确免费" valuePropName="checked"><Switch /></Form.Item>
                <Form.Item label="计费方式"><Select value={priceMode} onChange={setPriceMode} options={[{ value: "fixed", label: "固定点数 / 次" }, { value: "duration_resolution", label: "通用视频 · 时长与规格" }, { value: "cloud", label: "专用模型计费" }]} /></Form.Item>
                <Form.Item name={["pricing", "credits"]} label="固定点数"><InputNumber min={0} precision={0} /></Form.Item>
                {priceMode === "duration_resolution" && <><Form.Item name={["pricing", "video", "billingMode"]} initialValue="duration_resolution" hidden><Input /></Form.Item><Form.Item name={["pricing", "video", "minimumCredits"]} label="最低点数"><InputNumber min={0} /></Form.Item><Form.Item name={["pricing", "video", "billingTiers"]} label="各分辨率点数 / 秒" rules={jsonObjectRules}><JsonInput rows={4} /></Form.Item></>}
                {priceMode === "cloud" && <><Form.Item name={["pricing", "replicate", "billingMode"]} label="计费单位"><Select options={["fixed", "input_characters", "input_seconds", "output_seconds", "duration_resolution", "runtime_seconds", "output_count"].map((v) => ({ value: v, label: v }))} /></Form.Item>{["unitCredits", "minimumCredits", "defaultUnits", "blockSeconds"].map((field) => <Form.Item key={field} name={["pricing", "replicate", field]} label={{ unitCredits: "单价", minimumCredits: "最低点数", defaultUnits: "现有备用计费单位", blockSeconds: "现有每档秒数" }[field]}><InputNumber min={0} /></Form.Item>)}<Form.Item name={["pricing", "replicate", "tiers"]} label="规格报价" rules={jsonObjectRules}><JsonInput /></Form.Item></>}
            </Form>
        </Drawer>
        <Drawer forceRender width="min(640px, 100vw)" title="渠道模型" open={!!editingRoute} onClose={() => setEditingRoute(null)} extra={<Button type="primary" onClick={async () => { await routeForm.validateFields(); const route = routeForm.getFieldsValue(true); setValue({ ...value, routes: [...value.routes.filter((r) => r.id !== route.id), route] }); setEditingRoute(null); }}>应用到草稿</Button>}>
            <Form name="managed-route" form={routeForm} layout="vertical">
                <Form.Item name="id" hidden><Input /></Form.Item><Form.Item name="channelId" label="渠道" rules={[{ required: true }]}><Select disabled={value.routes.some((r) => r.id === editingRoute?.id)} options={channels.map((c) => ({ value: c.id, label: c.name }))} onChange={() => routeForm.setFieldValue("model", "")} /></Form.Item>
                <Form.Item noStyle shouldUpdate={(p, n) => p.channelId !== n.channelId}>{() => <Form.Item name="model" label="上游真实模型 ID" rules={[{ required: true }]}><Select showSearch disabled={value.routes.some((r) => r.id === editingRoute?.id)} options={(channels.find((c) => c.id === routeForm.getFieldValue("channelId"))?.models || []).map((m) => ({ value: m, label: m }))} /></Form.Item>}</Form.Item>
                <Form.Item name="adapter" label="调用适配器"><Select disabled={value.routes.some((r) => r.id === editingRoute?.id)} options={adapterOptions} onChange={(adapter) => { const capability = adapter.startsWith("cloud:") ? ["speech", "transcribe"].includes(adapter.slice(6)) ? "audio" : adapter.endsWith("-replicate") ? "image" : "video" : adapter.split(".")[0]; routeForm.setFieldsValue({ capability, operations: [adapter.startsWith("cloud:") ? adapter.slice(6) : capability] }); }} /></Form.Item>
                <Form.Item name="capability" label="能力类型"><Select options={capabilityOptions.filter((option) => option.value !== "all")} /></Form.Item>
                <Form.Item name="operations" label="已适配操作"><Select mode="tags" /></Form.Item><Form.Item name="version" label="上游固定版本"><Input disabled={value.routes.some((r) => r.id === editingRoute?.id)} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                <Form.Item noStyle shouldUpdate={(p,n) => p.capability !== n.capability || p.adapter !== n.adapter}>{() => routeForm.getFieldValue("capability") === "video" && !String(routeForm.getFieldValue("adapter")).startsWith("cloud:") && <>
                    <Form.Item name={["video","interface"]} label="视频接口"><Select options={["openai","relay","ark","sparkcine_h3"].map((v) => ({value:v,label:v}))} /></Form.Item>
                    <Form.Item name={["video","resolutions"]} label="输出清晰度"><Select mode="tags" tokenSeparators={[","]} /></Form.Item>
                    <Form.Item name={["video","seconds"]} label="输出秒数"><Select mode="tags" tokenSeparators={[","]} /></Form.Item>
                    <Form.Item name={["video","inputModes"]} label="输入方式"><Select mode="multiple" options={[{value:"reference",label:"多素材参考"},{value:"first_last",label:"首尾帧"},{value:"first_frame_only",label:"文生 / 单首帧"}]} /></Form.Item>
                    {["maxImages","maxVideos","maxAudios","referenceVideoMinSeconds","referenceVideoMaxSeconds"].map((field) => <Form.Item key={field} name={["video",field]} label={{maxImages:"最多参考图片",maxVideos:"最多参考视频",maxAudios:"最多参考音频",referenceVideoMinSeconds:"参考视频最短秒数",referenceVideoMaxSeconds:"参考视频最长秒数"}[field]}><InputNumber min={0} /></Form.Item>)}
                    <Form.Item name={["video","firstFrameField"]} label="首帧字段"><Input /></Form.Item><Form.Item name={["video","lastFrameField"]} label="尾帧字段"><Input /></Form.Item>
                    <Form.Item name={["video","firstFrameRequired"]} label="首帧必填" valuePropName="checked"><Switch /></Form.Item><Form.Item name={["video","lastFrameOptional"]} label="尾帧可选" valuePropName="checked"><Switch /></Form.Item><Form.Item name={["video","generateAudio"]} label="支持生成声音" valuePropName="checked"><Switch /></Form.Item>
                </>}</Form.Item>
            </Form>
        </Drawer>
        </>}
    </div>;
}
