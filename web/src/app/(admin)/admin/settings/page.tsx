"use client";

import { CheckCircleOutlined, DeleteOutlined, EditOutlined, FormatPainterOutlined, LoadingOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from "@ant-design/icons";
import { json } from "@codemirror/lang-json";
import { App, Button, Card, Checkbox, Col, Collapse, Drawer, Flex, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography } from "antd";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { EditorView } from "@uiw/react-codemirror";

import { fetchAdminSettings, fetchChannelModels, saveAdminSettings, testChannelModel, type AdminReplicatePricing, type AdminModelChannel, type AdminModelCost, type AdminSettings } from "@/services/api/admin";
import { REPLICATE_FEATURES, REPLICATE_IMAGE_MODELS, REPLICATE_SUPPORTED_MODELS, replicateFeatureUrl } from "@/services/api/replicate";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });
const jsonEditorTheme = EditorView.theme({
    "&": { backgroundColor: "var(--ant-color-bg-container)", color: "var(--ant-color-text)" },
    ".cm-content": { caretColor: "var(--ant-color-text)", padding: "12px 0" },
    ".cm-line": { padding: "0 18px" },
    ".cm-gutters": { backgroundColor: "var(--ant-color-fill-quaternary)", borderRight: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    ".cm-activeLine": { backgroundColor: "var(--ant-color-fill-quaternary)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--ant-color-fill-quaternary)", color: "var(--ant-color-text)" },
    ".cm-cursor": { borderLeftColor: "var(--ant-color-text)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--ant-control-item-bg-active)" },
    ".cm-foldPlaceholder": { backgroundColor: "var(--ant-color-fill-quaternary)", border: "1px solid var(--ant-color-border)", color: "var(--ant-color-text-tertiary)" },
    "&.cm-focused": { outline: "none" },
});

const emptySettings: AdminSettings = {
    public: {
        modelChannel: {
            availableModels: [],
            modelCosts: [],
            defaultModel: "",
            defaultImageModel: "",
            defaultVideoModel: "",
            defaultTextModel: "",
            systemPrompt: "",
            allowCustomChannel: true,
        },
        adminContact: { qq: "", note: "" },
        auth: { allowRegister: true, linuxDo: { enabled: false } },
    },
    private: { channels: [], groups: { default: { name: "普通用户", creditRatio: 1, enabled: true } }, promptSync: { enabled: true, cron: "*/5 * * * *" }, auth: { linuxDo: { clientId: "", clientSecret: "" } }, replicate: { channelsInitialized: true, pricing: {} } },
};
const emptyChannel: AdminModelChannel = { id: 0, protocol: "openai", name: "", baseUrl: "", apiKey: "", models: [], weight: 1, enabled: true, remark: "", allowedGroups: [] };

type SettingsTabKey = "public" | "private";
type EditorMode = "visual" | "json";
type ModelSelectTabKey = "new" | "current";

export default function AdminSettingsPage() {
    const token = useUserStore((state) => state.token);
    const { message } = App.useApp();
    const [form] = Form.useForm<AdminSettings>();
    const [activeTab, setActiveTab] = useState<SettingsTabKey>("public");
    const [editorMode, setEditorMode] = useState<Record<SettingsTabKey, EditorMode>>({ public: "visual", private: "visual" });
    const [jsonText, setJsonText] = useState<Record<SettingsTabKey, string>>({ public: "", private: "" });
    const [channels, setChannels] = useState<AdminModelChannel[]>([]);
    const [groupEditor, setGroupEditor] = useState<{ originalKey?: string; key: string; name: string; creditRatio: number; enabled: boolean } | null>(null);
    const [channelForm] = Form.useForm<AdminModelChannel & { replicatePricing?: Record<string, AdminReplicatePricing> }>();
    const [editingChannelIndex, setEditingChannelIndex] = useState<number | null>(null);
    const [isChannelDrawerOpen, setIsChannelDrawerOpen] = useState(false);
    const [testChannelIndex, setTestChannelIndex] = useState<number | null>(null);
    const [testKeyword, setTestKeyword] = useState("");
    const [selectedTestModels, setSelectedTestModels] = useState<string[]>([]);
    const [testingModels, setTestingModels] = useState<string[]>([]);
    const [testResults, setTestResults] = useState<Record<string, { status: "success" | "error"; duration?: string; message: string }>>({});
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [modelSelectSource, setModelSelectSource] = useState<string[]>([]);
    const [modelSelectExisting, setModelSelectExisting] = useState<string[]>([]);
    const [modelSelectSelected, setModelSelectSelected] = useState<string[]>([]);
    const [modelSelectKeyword, setModelSelectKeyword] = useState("");
    const [modelSelectNewModel, setModelSelectNewModel] = useState("");
    const [modelSelectTab, setModelSelectTab] = useState<ModelSelectTabKey>("new");
    const [isFetchingChannelModels, setIsFetchingChannelModels] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [modelCosts, setModelCosts] = useState<AdminModelCost[]>([]);
    const channelProtocol = Form.useWatch("protocol", channelForm) || "openai";
    // Replicate 与 WaveSpeed 都由后端固定接口地址和适配模型列表。
    const cloudProtocol = channelProtocol === "replicate" || channelProtocol === "wavespeed";
    const channelUsesEnvironment = Form.useWatch("useEnvironmentKey", channelForm);
    const channelSelectedModels = (Form.useWatch("models", channelForm) || []) as string[];
    const replicatePrices = Form.useWatch("replicatePricing", { form: channelForm, preserve: true }) || {};
    const channelVideoModels = (cloudProtocol ? [] : channelSelectedModels).filter((name) => /video|seedance|seedace|sora|veo|kling|wan|hailuo|tejiasd/i.test(name));
    const [knownModels, setKnownModels] = useState<string[]>([]);
    const publicModels = Form.useWatch(["public", "modelChannel", "availableModels"], form) || [];
    const channelModels = useMemo(() => collectChannelModels(channels), [channels]);
    const channelTableData = useMemo(() => channels.map((channel, index) => ({ ...channel, _index: index })), [channels]);
    const activeMode = editorMode[activeTab];
    const activeJsonText = jsonText[activeTab];
    const jsonError = activeMode === "json" ? getJsonError(activeJsonText) : "";
    const modelSelectGroups = useMemo(() => buildModelSelectGroups(modelSelectSource, modelSelectExisting), [modelSelectSource, modelSelectExisting]);
    const activeModelSelectModels = useMemo(() => {
        const keyword = modelSelectKeyword.trim().toLowerCase();
        return modelSelectGroups[modelSelectTab].filter((model) => model.toLowerCase().includes(keyword));
    }, [modelSelectGroups, modelSelectKeyword, modelSelectTab]);
    const activeSelectedCount = activeModelSelectModels.filter((model) => modelSelectSelected.includes(model)).length;

    const loadSettings = async () => {
        if (!token) return;
        setIsLoading(true);
        try {
            const data = normalizeSettings(await fetchAdminSettings(token));
            form.setFieldsValue(data);
            setChannels(data.private.channels);
            setModelCosts(data.public.modelChannel.modelCosts);
            setKnownModels(collectKnownModels(data));
            setJsonText({
                public: JSON.stringify(data.public, null, 2),
                private: JSON.stringify(data.private, null, 2),
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取设置失败");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        void loadSettings();
    }, [token]);

    const changeTab = (nextTab: SettingsTabKey) => {
        setActiveTab(nextTab);
    };

    const saveSettings = async () => {
        if (!token) return;
        const values = await collectSettings(form, editorMode, jsonText, message);
        if (!values) {
            return;
        }
        setIsSaving(true);
        try {
            const saved = normalizeSettings(await saveAdminSettings(token, values));
            const merged = saved;
            refreshModelCatalog();
            form.setFieldsValue(merged);
            setChannels(merged.private.channels);
            setModelCosts(merged.public.modelChannel.modelCosts);
            rememberKnownModels(merged);
            setJsonText({
                public: JSON.stringify(merged.public, null, 2),
                private: JSON.stringify(merged.private, null, 2),
            });
            message.success("已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setIsSaving(false);
        }
    };

    const toggleMode = (tab: SettingsTabKey, nextMode: EditorMode) => {
        if (nextMode === "json") {
            setJsonText((current) => ({
                ...current,
                [tab]: JSON.stringify(tab === "public" ? normalizePublicSetting(form.getFieldValue(["public"]) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(form.getFieldValue(["private"]) as Partial<AdminSettings["private"]>), null, 2),
            }));
            setEditorMode((current) => ({ ...current, [tab]: nextMode }));
            return;
        }
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        form.setFieldsValue({ [tab]: parsed } as Partial<AdminSettings>);
        if (tab === "private") setChannels((parsed as AdminSettings["private"]).channels);
        if (tab === "public") setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
        rememberKnownModels({ ...normalizeSettings(form.getFieldsValue(true) as AdminSettings), [tab]: parsed });
        setEditorMode((current) => ({ ...current, [tab]: nextMode }));
    };

    const formatJson = (tab: SettingsTabKey) => {
        const parsed = parseTabJson(tab, jsonText[tab]);
        if (!parsed) {
            message.error("JSON 格式不正确");
            return;
        }
        if (tab === "public") setModelCosts((parsed as AdminSettings["public"]).modelChannel.modelCosts);
        setJsonText((current) => ({
            ...current,
            [tab]: JSON.stringify(parsed, null, 2),
        }));
    };

    const openChannelDrawer = (index: number | null) => {
        setEditingChannelIndex(index);
        setIsChannelDrawerOpen(true);
        const channel = index === null ? emptyChannel : normalizeChannel(channels[index]);
        channelForm.resetFields();
        channelForm.setFieldsValue({ ...channel, replicatePricing: form.getFieldValue(["private", "replicate", "pricing"]) || {} });
        rememberModels(channel.models);
    };

    const closeChannelDrawer = () => {
        setIsChannelDrawerOpen(false);
        setEditingChannelIndex(null);
        channelForm.resetFields();
    };

    const saveChannel = async () => {
        try {
            await channelForm.validateFields();
            const draft = channelForm.getFieldsValue(true);
            const channel = normalizeChannel(draft);
            rememberModels(channel.models);
            const nextChannels = [...channels];
            if (editingChannelIndex === null) nextChannels.push(channel);
            else nextChannels[editingChannelIndex] = channel;
            await persistChannels(nextChannels, cloudProtocol || channel.protocol === "replicate" ? draft.replicatePricing : undefined);
            closeChannelDrawer();
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        }
    };

    const fetchChannelModelList = async () => {
        if (!token) return;
        const channel = channelForm.getFieldsValue(true);
        if (!channel?.baseUrl) {
            message.warning("请先填写接口地址");
            return;
        }
        if (channel.protocol !== "replicate" && editingChannelIndex === null && !channel?.apiKey) {
            message.warning("请先填写 API Key");
            return;
        }
        setIsFetchingChannelModels(true);
        try {
            const channelModels = await fetchChannelModels(token, { index: editingChannelIndex ?? undefined, channel: normalizeChannel(channel) });
            const current = isModelSelectorOpen ? uniqueModels(modelSelectSelected) : uniqueModels(channelForm.getFieldValue("models") || []);
            rememberModels(channelModels);
            if (!channelModels.length) {
                message.warning("上游未返回模型列表，请手动输入模型名称");
                return;
            }
            setModelSelectExisting(current);
            setModelSelectSource(uniqueModels(channelModels));
            setModelSelectSelected(uniqueModels([...current, ...channelModels]));
            setModelSelectKeyword("");
            setModelSelectNewModel("");
            setModelSelectTab("new");
            setIsModelSelectorOpen(true);
            message.success(`已获取 ${channelModels.length} 个模型，请选择后确认`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取模型失败");
        } finally {
            setIsFetchingChannelModels(false);
        }
    };

    const openChannelModelSelector = (sourceModels?: string[]) => {
        const current = uniqueModels(channelForm.getFieldValue("models") || []);
        const source = uniqueModels(sourceModels !== undefined ? sourceModels : cloudProtocol ? REPLICATE_SUPPORTED_MODELS.filter((item) => channelProtocol === "wavespeed" ? item.model.startsWith("wavespeed-ai/") : !item.model.startsWith("wavespeed-ai/")).map((item) => item.model) : [...knownModels, ...current]);
        setModelSelectExisting(current);
        setModelSelectSource(source);
        setModelSelectSelected(sourceModels ? uniqueModels([...current, ...source]) : current);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
        setModelSelectTab(sourceModels || cloudProtocol ? "new" : "current");
        setIsModelSelectorOpen(true);
    };

    const closeChannelModelSelector = () => {
        setIsModelSelectorOpen(false);
        setModelSelectKeyword("");
        setModelSelectNewModel("");
    };

    const confirmChannelModelSelector = () => {
        const models = uniqueModels(modelSelectSelected);
        channelForm.setFieldValue("models", models);
        rememberModels(models);
        closeChannelModelSelector();
    };

    const toggleSelectedModel = (model: string, checked: boolean) => {
        setModelSelectSelected((current) => (checked ? uniqueModels([...current, model]) : current.filter((item) => item !== model)));
    };

    const selectActiveModels = () => {
        setModelSelectSelected((current) => uniqueModels([...current, ...activeModelSelectModels]));
    };

    const clearActiveModels = () => {
        const active = new Set(activeModelSelectModels);
        setModelSelectSelected((current) => current.filter((model) => !active.has(model)));
    };

    const addModelInSelector = () => {
        const model = modelSelectNewModel.trim();
        if (!model) return;
        setModelSelectExisting((current) => uniqueModels([...current, model]));
        setModelSelectSelected((current) => uniqueModels([...current, model]));
        setModelSelectNewModel("");
        setModelSelectTab("current");
    };

    function rememberModels(models: string[]) {
        setKnownModels((current) => uniqueModels([...current, ...models]));
    }

    function rememberKnownModels(settings: AdminSettings) {
        rememberModels(collectKnownModels(settings));
    }

    const openTestDialog = (index: number) => {
        const channel = normalizeChannel(channels[index]);
        if (!channel.baseUrl || channel.models.length === 0) {
            message.warning("请先填写接口地址和至少一个模型");
            return;
        }
        setTestChannelIndex(index);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const closeTestDialog = () => {
        setTestChannelIndex(null);
        setTestKeyword("");
        setSelectedTestModels([]);
        setTestingModels([]);
        setTestResults({});
    };

    const testModelOnline = async (model: string) => {
        if (testChannelIndex === null) return;
        if (!token) return;
        const channel = normalizeChannel(channels[testChannelIndex]);
        setTestingModels((current) => [...current, model]);
        try {
            const startedAt = performance.now();
            const result = await testChannelModel(token, { index: testChannelIndex, channel, model });
            setTestResults((current) => ({ ...current, [model]: { status: "success", duration: `${((performance.now() - startedAt) / 1000).toFixed(2)}s`, message: result } }));
        } catch (error) {
            setTestResults((current) => ({ ...current, [model]: { status: "error", message: error instanceof Error ? error.message : "测试失败" } }));
        } finally {
            setTestingModels((current) => current.filter((item) => item !== model));
        }
    };

    const batchTestModels = async () => {
        for (const model of selectedTestModels) {
            await testModelOnline(model);
        }
    };

    const testChannel = testChannelIndex === null ? null : normalizeChannel(channels[testChannelIndex]);
    const testModels = (testChannel?.models || []).filter((model) => model.toLowerCase().includes(testKeyword.trim().toLowerCase()));

    function refreshModelCatalog() {
        void useConfigStore.getState().loadPublicSettings();
        localStorage.setItem("platform-model-catalog-changed", String(Date.now()));
    }

    async function persistChannels(nextChannels: AdminModelChannel[], pricing?: Record<string, AdminReplicatePricing>) {
        if (!token) return;
        const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
        const nextChannelModels = collectChannelModels(nextChannels);
        const nextSettings = normalizeSettings({
            ...values,
            public: { ...values.public, modelChannel: { ...values.public.modelChannel, availableModels: nextChannelModels } },
            private: { ...values.private, channels: nextChannels, replicate: { ...values.private.replicate, pricing: pricing || values.private.replicate.pricing } },
        });
        const saved = normalizeSettings(await saveAdminSettings(token, nextSettings));
        const merged = saved;
        refreshModelCatalog();
        setChannels(merged.private.channels);
        setModelCosts(merged.public.modelChannel.modelCosts);
        rememberKnownModels(merged);
        form.setFieldsValue(merged);
        setJsonText({
            public: JSON.stringify(merged.public, null, 2),
            private: JSON.stringify(merged.private, null, 2),
        });
        message.success("已保存");
    }

    const groups = (form.getFieldValue(["private", "groups"]) || {}) as AdminSettings["private"]["groups"];
    const groupRows = Object.entries(groups).map(([key, value]) => ({ key, ...value }));
    const saveGroup = () => {
        if (!groupEditor?.key.trim() || !groupEditor.name.trim()) {
            message.error("请输入分组标识和显示名称");
            return;
        }
        const key = groupEditor.key.trim();
        if (groups[key] && key !== groupEditor.originalKey) {
            message.error("分组标识已存在");
            return;
        }
        const nextGroups = { ...groups };
        if (groupEditor.originalKey && groupEditor.originalKey !== key) delete nextGroups[groupEditor.originalKey];
        nextGroups[key] = { name: groupEditor.name.trim(), creditRatio: Math.max(0, Number(groupEditor.creditRatio) || 0), enabled: groupEditor.enabled };
        form.setFieldsValue({ private: { ...form.getFieldValue("private"), groups: nextGroups } });
        setJsonText((current) => ({ ...current, private: JSON.stringify({ ...form.getFieldsValue(true).private, groups: nextGroups }, null, 2) }));
        setGroupEditor(null);
    };

    return (
        <main style={{ padding: 24 }}>
            <Flex vertical gap={16}>
                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap>
                        <Tabs
                            activeKey={activeTab}
                            onChange={(key) => changeTab(key as SettingsTabKey)}
                            items={[
                                { key: "public", label: "公开配置（对外暴露）" },
                                { key: "private", label: "私有配置（不会对外暴露）" },
                            ]}
                        />
                        <Space>
                            <Button icon={<ReloadOutlined />} loading={isLoading} onClick={() => void loadSettings()}>
                                刷新
                            </Button>
                            <Button type="primary" icon={<SaveOutlined />} loading={isSaving} onClick={() => void saveSettings()}>
                                保存设置
                            </Button>
                        </Space>
                    </Flex>
                </Card>

                <Card variant="borderless">
                    <Flex justify="space-between" align="center" gap={16} wrap style={{ marginBottom: 16 }}>
                        <Segmented
                            value={activeMode}
                            onChange={(value) => toggleMode(activeTab, value as EditorMode)}
                            options={[
                                { label: "可视化编辑", value: "visual" },
                                { label: "手动编辑 JSON", value: "json" },
                            ]}
                        />
                        {activeMode === "json" ? (
                            <Space>
                                {jsonError ? (
                                    <Tag color="error">{jsonError}</Tag>
                                ) : (
                                    <Tag color="success" icon={<CheckCircleOutlined />}>
                                        JSON 格式正确
                                    </Tag>
                                )}
                                <Button icon={<FormatPainterOutlined />} onClick={() => formatJson(activeTab)}>
                                    格式化
                                </Button>
                            </Space>
                        ) : (
                            <Typography.Text type="secondary">{activeTab === "public" ? "这些配置会暴露给前端读取" : "这些配置只会在后台保存"}</Typography.Text>
                        )}
                    </Flex>

                    {activeTab === "public" ? (
                        activeMode === "visual" ? (
                            <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                                <Row gutter={16}>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "availableModels"]} label="OpenAI 兼容模型（先在私有配置里配置渠道）" extra="这里汇总 OpenAI 兼容渠道的模型；Replicate 模型按渠道权限、启用状态和报价配置自动发布。">
                                            <Select mode="multiple" placeholder="请选择系统可用模型" options={channelModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultModel"]} label="默认模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultImageModel"]} label="默认图片模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultVideoModel"]} label="默认视频模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={6}>
                                        <Form.Item name={["public", "modelChannel", "defaultTextModel"]} label="默认文本模型">
                                            <Select showSearch allowClear options={publicModels.map((item) => ({ label: item, value: item }))} />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "systemPrompt"]} label="系统提示词">
                                            <Input.TextArea rows={4} />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={8}>
                                        <Form.Item name={["public", "adminContact", "qq"]} label="管理员 QQ" extra="用户遇到模型分组权限限制时显示">
                                            <Input placeholder="例如 123456789" />
                                        </Form.Item>
                                    </Col>
                                    <Col xs={24} md={16}>
                                        <Form.Item name={["public", "adminContact", "note"]} label="管理员联系说明" extra="可填写服务时间或其他联系方式">
                                            <Input placeholder="例如：工作日 9:00-18:00 在线" />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "modelChannel", "allowCustomChannel"]} label="是否允许用户自定义渠道" extra="开启后，前端可提供走后端渠道和用户自定义 baseUrl 直连两种模式" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Form.Item name={["public", "auth", "allowRegister"]} label="是否允许用户注册" extra="关闭后隐藏注册入口，注册接口也会拒绝新用户创建" valuePropName="checked">
                                            <Switch />
                                        </Form.Item>
                                    </Col>
                                    <Col span={24}>
                                        <Typography.Title level={5}>模型算力点</Typography.Title>
                                        <Table
                                            rowKey="model"
                                            pagination={false}
                                            size="small"
                                            dataSource={publicModels.map((model) => ({ model, credits: modelCostCredits(modelCosts, model) }))}
                                            columns={[
                                                { title: "模型", dataIndex: "model" },
                                                {
                                                    title: "每次调用扣除",
                                                    dataIndex: "credits",
                                                    width: 220,
                                                    render: (_, item) => (
                                                        <InputNumber
                                                            min={0}
                                                            step={1}
                                                            precision={0}
                                                            className="!w-full"
                                                            value={item.credits}
                                                            addonAfter="点"
                                                            onChange={(value) => setModelCost(form, setModelCosts, item.model, Number(value) || 0)}
                                                        />
                                                    ),
                                                },
                                            ]}
                                        />
                                    </Col>
                                </Row>
                            </Form>
                        ) : (
                            <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                                <CodeMirror
                                    value={activeJsonText}
                                    height="520px"
                                    extensions={[json(), jsonEditorTheme]}
                                    basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                    theme="none"
                                    onChange={(value) => setJsonText((current) => ({ ...current, public: value }))}
                                    style={{ fontSize: 13 }}
                                />
                            </div>
                        )
                    ) : activeMode === "visual" ? (
                        <Form form={form} layout="vertical" initialValues={emptySettings} requiredMark={false}>
                            <Flex vertical gap={12}>
                                <Card
                                    size="small"
                                    title={
                                        <Space>
                                            <img src="/icons/linuxdo.svg" alt="" width={18} height={18} />
                                            Linux.do 登录
                                        </Space>
                                    }
                                >
                            <Flex vertical gap={14}>
                                        <Typography.Text type="secondary">
                                            本项目接口回调地址是 /api/auth/linux-do/callback，请在 Linux.do 应用后台自行拼接站点前缀。
                                            <Typography.Link href="https://connect.linux.do" target="_blank" rel="noreferrer">
                                                点击此处管理你的 LinuxDO OAuth App
                                            </Typography.Link>
                                        </Typography.Text>
                                        <Row gutter={16}>
                                            <Col xs={24} md={6}>
                                                <Form.Item name={["public", "auth", "linuxDo", "enabled"]} label="开启 Linux.do 登录" valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={9}>
                                                <Form.Item name={["private", "auth", "linuxDo", "clientId"]} label="Linux.do Client ID">
                                                    <Input placeholder="输入 Linux.do OAuth App 的 ID" />
                                                </Form.Item>
                                            </Col>
                                            <Col xs={24} md={9}>
                                                <Form.Item name={["private", "auth", "linuxDo", "clientSecret"]} label="Linux.do Client Secret">
                                                    <Input.Password placeholder="留空则沿用已保存的密钥" />
                                                </Form.Item>
                                            </Col>
                                        </Row>
                                    </Flex>
                                </Card>
                                <Card
                                    size="small"
                                    title="用户分组"
                                    extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setGroupEditor({ key: "", name: "", creditRatio: 1, enabled: true })}>新增分组</Button>}
                                >
                                    <Table
                                        size="small"
                                        pagination={false}
                                        rowKey="key"
                                        dataSource={groupRows}
                                        locale={{ emptyText: "暂无分组" }}
                                        columns={[
                                            { title: "标识", dataIndex: "key", width: 180 },
                                            { title: "名称", dataIndex: "name" },
                                            { title: "扣除比例", dataIndex: "creditRatio", width: 120, render: (value) => `${value}x` },
                                            { title: "状态", dataIndex: "enabled", width: 90, render: (value) => <Tag color={value ? "success" : "default"}>{value ? "启用" : "停用"}</Tag> },
                                            {
                                                title: "操作",
                                                key: "actions",
                                                width: 150,
                                                align: "right",
                                                render: (_, item) => (
                                                    <Space size={4}>
                                                        <Button size="small" icon={<EditOutlined />} onClick={() => setGroupEditor({ originalKey: item.key, ...item })}>编辑</Button>
                                                        <Button size="small" danger disabled={item.key === "default"} icon={<DeleteOutlined />} onClick={() => {
                                                            const nextGroups = { ...groups };
                                                            delete nextGroups[item.key];
                                                            form.setFieldsValue({ private: { ...form.getFieldValue("private"), groups: nextGroups } });
                                                            setJsonText((current) => ({ ...current, private: JSON.stringify({ ...form.getFieldsValue(true).private, groups: nextGroups }, null, 2) }));
                                                        }} />
                                                    </Space>
                                                ),
                                            },
                                        ]}
                                    />
                                    <Typography.Text type="secondary">分组倍率会应用于算力点扣除；default 分组不可删除。</Typography.Text>
                                </Card>
                                <Card size="small" title="提示词定时同步">
                                    <Row gutter={16} align="middle">
                                        <Col xs={24} md={8}>
                                            <Form.Item name={["private", "promptSync", "enabled"]} label="开启定时同步" valuePropName="checked">
                                                <Switch />
                                            </Form.Item>
                                        </Col>
                                        <Col xs={24} md={16}>
                                            <Form.Item name={["private", "promptSync", "cron"]} label="Cron 表达式" extra="默认每 5 分钟同步内置 GitHub 远程提示词源">
                                                <Input placeholder="*/5 * * * *" />
                                            </Form.Item>
                                        </Col>
                                    </Row>
                                </Card>
                                <Button type="primary" icon={<PlusOutlined />} onClick={() => openChannelDrawer(null)}>
                                    新增渠道
                                </Button>
                                <Table
                                    rowKey={(item) => item.id > 0 ? item.id : `unsaved-${item._index}`}
                                    pagination={false}
                                    dataSource={channelTableData}
                                    columns={[
                                        { title: "ID", dataIndex: "id", width: 80, render: (value: number) => value > 0 ? value : "未分配" },
                                        { title: "名称", dataIndex: "name", render: (value) => value || "未命名渠道" },
                                        { title: "协议", dataIndex: "protocol", width: 96, render: (value) => <Tag>{value || "openai"}</Tag> },
                                        { title: "状态", dataIndex: "enabled", width: 96, render: (value) => <Tag color={value ? "success" : "default"}>{value ? "已启用" : "已停用"}</Tag> },
                                        {
                                            title: "模型",
                                            dataIndex: "models",
                                            render: (value: string[]) => (
                                                <Typography.Text ellipsis style={{ maxWidth: 360 }}>
                                                    {modelSummary(value || [])}
                                                </Typography.Text>
                                            ),
                                        },
                                        { title: "权重", dataIndex: "weight", width: 88 },
                                        {
                                            title: "操作",
                                            key: "actions",
                                            width: 220,
                                            align: "right",
                                            render: (_, item) => (
                                                <Space size={4}>
                                                    <Button size="small" onClick={() => openTestDialog(item._index)}>
                                                        测试
                                                    </Button>
                                                    <Button size="small" onClick={() => openChannelDrawer(item._index)}>
                                                        编辑
                                                    </Button>
                                                    <Button
                                                        danger
                                                        size="small"
                                                        icon={<DeleteOutlined />}
                                                        onClick={() => {
                                                            const nextChannels = [...channels];
                                                            nextChannels.splice(item._index, 1);
                                                            void persistChannels(nextChannels).catch((error) => message.error(error instanceof Error ? error.message : "删除渠道失败"));
                                                        }}
                                                    />
                                                </Space>
                                            ),
                                        },
                                    ]}
                                />
                            </Flex>
                        </Form>
                    ) : (
                        <div style={{ overflow: "hidden", border: "1px solid var(--ant-color-border)", borderRadius: 6 }}>
                            <CodeMirror
                                value={activeJsonText}
                                height="520px"
                                extensions={[json(), jsonEditorTheme]}
                                basicSetup={{ foldGutter: true, lineNumbers: true, highlightActiveLine: true, highlightActiveLineGutter: true }}
                                theme="none"
                                onChange={(value) => setJsonText((current) => ({ ...current, private: value }))}
                                style={{ fontSize: 13 }}
                            />
                        </div>
                    )}
                </Card>
                <Drawer
                    title={editingChannelIndex === null ? "新增渠道" : "编辑渠道"}
                    open={isChannelDrawerOpen}
                    size={560}
                    onClose={closeChannelDrawer}
                    extra={
                        <Space>
                            <Button onClick={closeChannelDrawer}>取消</Button>
                            <Button type="primary" onClick={() => void saveChannel()}>
                                保存
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Form form={channelForm} layout="vertical" requiredMark={false} initialValues={emptyChannel}>
                        <Form.Item name="id" hidden>
                            <InputNumber />
                        </Form.Item>
                        {editingChannelIndex !== null ? <Typography.Paragraph type="secondary">渠道 ID：{channels[editingChannelIndex].id}</Typography.Paragraph> : null}
                        <Row gutter={16}>
                            <Col span={12}>
                                <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入渠道名称" }]}>
                                    <Input />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="protocol" label="协议" extra="按渠道接口协议选择，具体模型在下方配置。">
                                    <Select options={[{ label: "OpenAI 兼容", value: "openai" }, { label: "Replicate", value: "replicate" }, { label: "WaveSpeed", value: "wavespeed" }]} onChange={(protocol) => channelForm.setFieldsValue({ baseUrl: protocol === "replicate" ? "https://api.replicate.com/v1" : protocol === "wavespeed" ? "https://api.wavespeed.ai/api/v3" : "", apiKey: "", apiKeyConfigured: false, clearApiKey: false, useEnvironmentKey: false, models: [], videoModels: {} })} />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="weight" label="权重">
                                    <InputNumber min={1} step={1} className="!w-full" />
                                </Form.Item>
                            </Col>
                            <Col span={12}>
                                <Form.Item name="enabled" label="启用" valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="allowedGroups" label="允许访问的用户分组" extra="留空表示所有分组可用">
                                    <Select mode="multiple" allowClear options={Object.entries(form.getFieldValue(["private", "groups"]) || {}).map(([key, value]) => ({ label: `${(value as { name?: string }).name || key} (${key})`, value: key }))} />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="baseUrl" label="接口地址" rules={[{ required: true, message: "请输入接口地址" }]}>
                                    <Input disabled={cloudProtocol} />
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="apiKey" label={channelProtocol === "replicate" ? "API Token" : "API Key"} extra={editingChannelIndex !== null ? (channels[editingChannelIndex].apiKeyConfigured ? "密钥已配置" : "未配置密钥") : undefined} rules={editingChannelIndex === null && !channelUsesEnvironment ? [{ required: true, message: "请输入 API Key" }] : []}>
                                    <Input.Password autoComplete="new-password" placeholder={editingChannelIndex === null ? "输入渠道密钥" : "留空则沿用该渠道已保存的密钥"} />
                                </Form.Item>
                            </Col>
                            {editingChannelIndex !== null && <Col span={24}><Form.Item name="clearApiKey" valuePropName="checked"><Checkbox>保存时移除该渠道密钥</Checkbox></Form.Item></Col>}
                            {cloudProtocol && <Col span={24}><Form.Item name="useEnvironmentKey" valuePropName="checked" extra="仅此渠道使用服务器环境令牌；停用渠道后不会用于新任务。"><Checkbox>{channelProtocol === "wavespeed" ? "无渠道密钥时使用服务器 WAVESPEED_API_KEY" : "无渠道密钥时使用服务器 REPLICATE_API_TOKEN"}</Checkbox></Form.Item></Col>}
                            <Col span={24}>
                                <Form.Item label="渠道可用模型">
                                    <Space.Compact style={{ width: "100%" }}>
                                        <Form.Item name="models" noStyle>
                                            <Select mode={cloudProtocol ? "multiple" : "tags"} maxTagCount="responsive" tokenSeparators={[",", "\n"]} options={cloudProtocol ? REPLICATE_SUPPORTED_MODELS.filter((item) => channelProtocol === "wavespeed" ? item.model.startsWith("wavespeed-ai/") : !item.model.startsWith("wavespeed-ai/")).map((item) => ({ label: `${item.label} · ${item.model}`, value: item.model })) : knownModels.map((model) => ({ label: model, value: model }))} />
                                        </Form.Item>
                                        <Button onClick={() => openChannelModelSelector()}>选择模型</Button>
                                    </Space.Compact>
                                </Form.Item>
                            </Col>
                            <Col span={24}>
                                <Form.Item name="remark" label="备注">
                                    <Input.TextArea rows={3} />
                                </Form.Item>
                            </Col>
                            {channelVideoModels.map((name) => (
                                <Col span={24} key={name}>
                                    <Card size="small" title={`视频能力 · ${name}`}>
                                        <Typography.Paragraph type="secondary">只开启该渠道已确认支持的素材。接口名称相同也可能能力不同；数量设为0表示不支持。价格仍在公共配置的模型算力点中调整。</Typography.Paragraph>
                                        <Form.Item name={["videoModels", name, "displayName"]} label="前台展示名称" initialValue={name}><Input /></Form.Item>
                                        <Form.Item name={["videoModels", name, "description"]} label="一句话用途"><Input.TextArea rows={2} /></Form.Item>
                                        <Form.Item name={["videoModels", name, "interface"]} label="视频调用方式" initialValue={/seedance|seedace/i.test(name) ? "relay" : "openai"}>
                                            <Select options={[{ value: "openai", label: "普通视频接口（图片参考）" }, { value: "relay", label: "JSON视频中转（reference_videos / audio_urls）" }, { value: "ark", label: "火山多素材接口（content）" }]} />
                                        </Form.Item>
                                        <Form.Item name={["videoModels", name, "inputModes"]} label="支持的输入模式" initialValue={["reference"]} extra="只开启上游文档和实测已确认的模式；首尾帧与普通参考图片独立。">
                                            <Select mode="multiple" options={[{ value: "reference", label: "参考模式" }, { value: "first_last", label: "首尾帧模式" }, { value: "first_frame_only", label: "文生 / 单首帧模式" }]} />
                                        </Form.Item>
                                        <Row gutter={12}>
                                            <Col span={12}><Form.Item name={["videoModels", name, "firstFrameField"]} label="首帧字段" extra="JSON / 表单参数名；Ark 使用 content.role=first_frame。"><Input placeholder="例如 first_frame 或 image_url" /></Form.Item></Col>
                                            <Col span={12}><Form.Item name={["videoModels", name, "lastFrameField"]} label="尾帧字段" extra="未填写则不开放首尾帧；Ark 使用 content.role=last_frame。"><Input placeholder="例如 last_frame 或 last_image" /></Form.Item></Col>
                                            <Col span={12}><Form.Item name={["videoModels", name, "firstFrameRequired"]} label="首帧必填" valuePropName="checked" initialValue={true}><Switch /></Form.Item></Col>
                                            <Col span={12}><Form.Item name={["videoModels", name, "lastFrameOptional"]} label="尾帧可选" valuePropName="checked" initialValue={true}><Switch /></Form.Item></Col>
                                        </Row>
                                        <Row gutter={12}>
                                            {([['maxImages', '最多参考图片（张）', 7], ['maxVideos', '视频数量', 3], ['maxAudios', '音频数量', 3]] as const).map(([field, label, maximum]) => <Col span={8} key={field}><Form.Item name={["videoModels", name, field]} label={label} initialValue={field === 'maxImages' ? 7 : 0}><InputNumber min={0} max={name.trim().toLowerCase() === 'wan30-720p' ? field === 'maxImages' ? 10 : 5 : maximum} precision={0} className="!w-full" /></Form.Item></Col>)}
                                        </Row>
                                        <Form.Item name={["videoModels", name, "resolutions"]} label="支持分辨率" initialValue={/seedance|seedace/i.test(name) ? ["480", "720"] : ["480", "720", "1080"]}><Select mode="multiple" options={["480", "720", "1080"].map((value) => ({ value, label: `${value}p` }))} /></Form.Item>
                                        <Form.Item name={["videoModels", name, "seconds"]} label="支持输出秒数" extra="填写上游支持的档位；留空沿用现有4至30秒设置。" initialValue={/seedance|seedace/i.test(name) ? Array.from({ length: 12 }, (_, i) => String(i + 4)) : []}><Select mode="tags" tokenSeparators={[",", " "]} /></Form.Item>
                                        <Form.Item name={["videoModels", name, "generateAudio"]} label="支持生成声音开关" valuePropName="checked" initialValue={false}><Switch /></Form.Item>
                                    </Card>
                                </Col>
                            ))}
                        </Row>

                        {cloudProtocol && <>
                            <Typography.Paragraph type="secondary">下列报价为平台向用户收取的算力点，同一模型在多个 Replicate 渠道和工具中共享。模型版本使用已适配的固定版本；停用渠道仍可恢复原任务。</Typography.Paragraph>
                            <Collapse items={REPLICATE_FEATURES.filter((feature) => channelSelectedModels.includes(feature.model)).map((feature) => {
                                const billingMode = replicatePrices[feature.model]?.billingMode || feature.billingMode;
                                const tierKeys = billingMode === "fixed" ? [] : feature.tierKeys;
                                const version = (form.getFieldValue(["public", "modelChannel", "models"]) || []).find((item: { model: string; version?: string }) => item.model === feature.model)?.version;
                                return {
                                key: feature.model,
                                label: <Space wrap><span>{feature.label}</span><Typography.Text type="secondary" code>{feature.model}</Typography.Text><Tag>{replicatePrices[feature.model]?.enabled ? "已启用" : "已停用"}</Tag></Space>,
                                children: <>
                                    <Typography.Paragraph><Typography.Text code>{feature.model}</Typography.Text></Typography.Paragraph>
                                    <Typography.Paragraph type="secondary">{feature.description}{feature.operation === "video-edit" ? " 此模型同时用于视频编辑与字幕去除，共享报价。" : ""}</Typography.Paragraph>
                                    <Typography.Paragraph type="secondary">固定版本：{replicatePrices[feature.model]?.version || "保存后由服务器补全"}</Typography.Paragraph>
                                    {version && replicatePrices[feature.model]?.version !== version && <Button size="small" onClick={() => channelForm.setFieldValue(["replicatePricing", feature.model, "version"], version)}>采用当前适配版本（保存后生效）</Button>}
                                    <Button size="small" href={replicateFeatureUrl(feature.operation)} target="_blank" rel="noopener noreferrer">打开对应功能</Button>
                                    <Row gutter={12}>
                                        <Col span={8}><Form.Item name={["replicatePricing", feature.model, "enabled"]} label="启用" valuePropName="checked"><Switch /></Form.Item></Col>
                                        <Col span={16}><Form.Item label="收费单位"><Space wrap><Tag color="blue">{replicateBillingModeLabel(billingMode)}</Tag><Typography.Text type="secondary">{replicateBillingUnitHelp(billingMode)}</Typography.Text></Space></Form.Item></Col>
                                        {!tierKeys?.length && <Col span={12}><Form.Item name={["replicatePricing", feature.model, "unitCredits"]} label="计费单价（算力点）" extra={replicateBillingUnitHelp(billingMode)}><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item></Col>}
                                        <Col span={12}><Form.Item name={["replicatePricing", feature.model, "minimumCredits"]} label="一次任务最低消耗" extra="任务计算结果低于此数值时，按这个数值收取。"><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item></Col>
                                        {(billingMode === "output_seconds" || billingMode === "runtime_seconds" || billingMode === "duration_resolution") && <Col span={12}><Form.Item name={["replicatePricing", feature.model, "defaultUnits"]} label="无法读取时的安全时长" extra="只有系统无法读取素材时使用，不代表每次固定扣除。"><InputNumber min={1} precision={0} style={{ width: "100%" }} /></Form.Item></Col>}
                                        {billingMode === "duration_resolution" && <Col span={12}><Form.Item name={["replicatePricing", feature.model, "blockSeconds"]} label="每个计费档包含秒数" extra="例如填 5，表示按每 5 秒视频计算一个档位。"><InputNumber min={1} precision={0} style={{ width: "100%" }} /></Form.Item></Col>}
                                    </Row>
                                    {tierKeys?.length ? <><Typography.Text strong>不同规格的单价</Typography.Text><Typography.Paragraph type="secondary" style={{ margin: "4px 0 8px" }}>用户选择不同清晰度、帧率或模型版本时，系统会使用对应档位。</Typography.Paragraph><Row gutter={12}>{tierKeys.map((tier) => <Col span={12} key={tier}><Form.Item name={["replicatePricing", feature.model, "tiers", tier]} label={replicateTierLabel(tier)}><InputNumber min={0} precision={0} style={{ width: "100%" }} /></Form.Item></Col>)}</Row></> : null}
                                </>,
                                };
                            })} />
                            {REPLICATE_IMAGE_MODELS.filter((feature) => channelSelectedModels.includes(feature.model)).map((feature) => <Card key={feature.model} size="small" title={feature.label} style={{ marginTop: 12 }}><Typography.Text code>{feature.model}</Typography.Text><Typography.Paragraph type="secondary">{feature.description}模型版本沿用现有案例接口的上游版本读取方式。</Typography.Paragraph></Card>)}
                        </>}
                    </Form>
                </Drawer>
                <Modal title={groupEditor?.originalKey ? "编辑分组" : "新增分组"} open={Boolean(groupEditor)} onCancel={() => setGroupEditor(null)} onOk={saveGroup} okText="保存" cancelText="取消">
                    <Form layout="vertical">
                        <Form.Item label="分组标识" required extra="用于用户和渠道匹配，建议使用英文、数字或下划线">
                            <Input value={groupEditor?.key || ""} disabled={Boolean(groupEditor?.originalKey === "default")} onChange={(event) => setGroupEditor((current) => current ? { ...current, key: event.target.value } : current)} />
                        </Form.Item>
                        <Form.Item label="显示名称" required>
                            <Input value={groupEditor?.name || ""} onChange={(event) => setGroupEditor((current) => current ? { ...current, name: event.target.value } : current)} />
                        </Form.Item>
                        <Form.Item label="算力点扣除比例" extra="1 为原价，0.5 为五折">
                            <InputNumber min={0} step={0.1} value={groupEditor?.creditRatio} onChange={(value) => setGroupEditor((current) => current ? { ...current, creditRatio: Number(value) || 0 } : current)} />
                        </Form.Item>
                        <Form.Item label="状态">
                            <Switch checked={groupEditor?.enabled} onChange={(enabled) => setGroupEditor((current) => current ? { ...current, enabled } : current)} />
                        </Form.Item>
                    </Form>
                </Modal>
                <Modal
                    title={
                        <Space size={12}>
                            选择渠道模型
                            <Typography.Text type="secondary">
                                已选择 {modelSelectSelected.length} / {uniqueModels([...modelSelectSource, ...modelSelectExisting]).length}
                            </Typography.Text>
                        </Space>
                    }
                    open={isModelSelectorOpen}
                    width={960}
                    onCancel={closeChannelModelSelector}
                    footer={
                        <Space>
                            <Button onClick={closeChannelModelSelector}>取消</Button>
                            <Button type="primary" onClick={confirmChannelModelSelector}>
                                确定
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={14}>
                        <Flex gap={12} wrap>
                            <Input.Search placeholder="搜索模型" allowClear value={modelSelectKeyword} onChange={(event) => setModelSelectKeyword(event.target.value)} style={{ flex: "1 1 260px" }} />
                            <Space.Compact style={{ flex: "1 1 320px" }}>
                                {channelProtocol !== "replicate" && <><Input value={modelSelectNewModel} placeholder="输入模型名称" onChange={(event) => setModelSelectNewModel(event.target.value)} onPressEnter={addModelInSelector} /><Button onClick={addModelInSelector}>增加模型</Button></>}
                                <Button icon={<ReloadOutlined />} loading={isFetchingChannelModels} onClick={() => void fetchChannelModelList()}>
                                    {cloudProtocol ? "查看已适配模型" : "拉取模型列表"}
                                </Button>
                            </Space.Compact>
                        </Flex>
                        <Typography.Text type="secondary">{cloudProtocol ? "仅列出已适配模型；一个模型可支持多个工具功能。" : "如果上游不提供 OpenAI /models 模型列表接口，请在这里手动增加模型名称。"}</Typography.Text>
                        <Tabs
                            activeKey={modelSelectTab}
                            onChange={(key) => setModelSelectTab(key as ModelSelectTabKey)}
                            items={[
                                { key: "new", label: `新获取的模型 (${modelSelectGroups.new.length})` },
                                { key: "current", label: `已有的模型 (${modelSelectGroups.current.length})` },
                            ]}
                        />
                        <Flex justify="space-between" align="center" gap={12} wrap>
                            <Typography.Text type="secondary">
                                当前列表已选择 {activeSelectedCount} / {activeModelSelectModels.length}
                            </Typography.Text>
                            <Space size={8}>
                                <Button size="small" disabled={!activeModelSelectModels.length || activeSelectedCount === activeModelSelectModels.length} onClick={selectActiveModels}>
                                    全选当前列表
                                </Button>
                                <Button size="small" disabled={!activeSelectedCount} onClick={clearActiveModels}>
                                    取消当前列表
                                </Button>
                            </Space>
                        </Flex>
                        <div style={{ maxHeight: 420, overflowY: "auto", borderTop: "1px solid var(--ant-color-border-secondary)", paddingTop: 12 }}>
                            {activeModelSelectModels.length ? (
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", columnGap: 24, rowGap: 12 }}>
                                    {activeModelSelectModels.map((model) => (
                                        <Checkbox key={model} checked={modelSelectSelected.includes(model)} onChange={(event) => toggleSelectedModel(model, event.target.checked)}>
                                            <Typography.Text style={{ wordBreak: "break-all" }}>{model}</Typography.Text>
                                        </Checkbox>
                                    ))}
                                </div>
                            ) : (
                                <div style={{ padding: "48px 0", textAlign: "center" }}>
                                    <Typography.Text type="secondary">没有匹配的模型</Typography.Text>
                                </div>
                            )}
                        </div>
                    </Flex>
                </Modal>
                <Modal
                    title={
                        <Space>
                            #{testChannel?.id} {testChannel?.name || "渠道"} 渠道的模型测试<Typography.Text type="secondary">共 {testChannel?.models.length || 0} 个模型</Typography.Text>
                        </Space>
                    }
                    open={testChannelIndex !== null}
                    width={920}
                    onCancel={closeTestDialog}
                    footer={
                        <Space>
                            <Button onClick={closeTestDialog}>取消</Button>
                            <Button type="primary" disabled={!selectedTestModels.length || testingModels.length > 0} onClick={() => void batchTestModels()}>
                                批量测试 {selectedTestModels.length} 个模型
                            </Button>
                        </Space>
                    }
                    destroyOnHidden
                >
                    <Flex vertical gap={12}>
                        <Typography.Text type="secondary">Replicate 测试检查当前模型的令牌和访问权限，不创建付费任务。普通文本模型发送一条 hi；Agent Plan / Seedance 只检查配置格式。</Typography.Text>
                        <Input.Search placeholder="搜索模型..." allowClear value={testKeyword} onChange={(event) => setTestKeyword(event.target.value)} />
                        <Table
                            rowKey="model"
                            pagination={false}
                            scroll={{ y: 420 }}
                            dataSource={testModels.map((model) => ({ model }))}
                            rowSelection={{
                                selectedRowKeys: selectedTestModels,
                                onChange: (keys) => setSelectedTestModels(keys.map(String)),
                            }}
                            columns={[
                                { title: "模型名称", dataIndex: "model", render: (value) => <Typography.Text strong>{value}</Typography.Text> },
                                {
                                    title: "状态",
                                    dataIndex: "model",
                                    width: 260,
                                    render: (value) => {
                                        if (testingModels.includes(value)) return <Tag icon={<LoadingOutlined className="animate-spin" />}>测试中</Tag>;
                                        const result = testResults[value];
                                        if (!result) return <Tag>未开始</Tag>;
                                        return result.status === "success" ? (
                                            <Space size={6} wrap>
                                                <Tag color="success">成功</Tag>
                                                <Typography.Text type="secondary">请求时长: {result.duration}</Typography.Text>
                                            </Space>
                                        ) : (
                                            <Typography.Text type="danger">{result.message}</Typography.Text>
                                        );
                                    },
                                },
                                {
                                    title: "操作",
                                    key: "actions",
                                    width: 120,
                                    align: "right",
                                    render: (_, item) => (
                                        <Button size="small" loading={testingModels.includes(item.model)} onClick={() => void testModelOnline(item.model)}>
                                            测试
                                        </Button>
                                    ),
                                },
                            ]}
                        />
                    </Flex>
                </Modal>
            </Flex>
        </main>
    );
}

function normalizeSettings(settings: Partial<AdminSettings> = {}): AdminSettings {
    const privateSetting = normalizePrivateSetting(settings.private);
    return {
        public: {
            ...normalizePublicSetting(settings.public),
        },
        private: privateSetting,
    };
}

function normalizePublicSetting(setting: Partial<AdminSettings["public"]> = {}): AdminSettings["public"] {
    return {
        ...emptySettings.public,
        modelChannel: {
            ...emptySettings.public.modelChannel,
            ...(setting.modelChannel || {}),
            availableModels: setting.modelChannel?.availableModels || [],
            modelCosts: normalizeModelCosts(setting.modelChannel?.modelCosts || []),
        },
        adminContact: {
            qq: setting.adminContact?.qq || "",
            note: setting.adminContact?.note || "",
        },
        auth: {
            allowRegister: setting.auth?.allowRegister !== false,
            linuxDo: {
                enabled: setting.auth?.linuxDo?.enabled === true,
            },
        },
    };
}

function normalizeModelCosts(items: Partial<AdminSettings["public"]["modelChannel"]["modelCosts"][number]>[]) {
    return items.filter((item) => item.model).map((item) => ({ model: item.model || "", credits: Math.max(0, Number(item.credits) || 0) }));
}

function normalizePrivateSetting(setting: Partial<AdminSettings["private"]> = {}): AdminSettings["private"] {
    return {
        nextChannelId: setting.nextChannelId,
        channels: (setting.channels || []).map(normalizeChannel),
        groups: setting.groups || { default: { name: "普通用户", creditRatio: 1, enabled: true } },
        promptSync: {
            enabled: setting.promptSync?.enabled !== false,
            cron: setting.promptSync?.cron || "*/5 * * * *",
        },
        auth: {
            linuxDo: {
                clientId: setting.auth?.linuxDo?.clientId || "",
                clientSecret: setting.auth?.linuxDo?.clientSecret || "",
            },
        },
        replicate: {
            channelsInitialized: setting.replicate?.channelsInitialized,
            legacyChannelId: setting.replicate?.legacyChannelId,
            modelCredits: setting.replicate?.modelCredits || {},
            pricing: normalizeReplicatePricing(setting.replicate?.pricing || {}),
        },
    };
}

function normalizeReplicatePricing(items: NonNullable<AdminSettings["private"]["replicate"]["pricing"]>) {
    return Object.fromEntries(REPLICATE_FEATURES.map((feature) => {
        const item = items[feature.model] || {};
        const tiers = { ...item.tiers, ...Object.fromEntries((feature.tierKeys || []).map((key) => [key, Math.max(0, Number(item.tiers?.[key]) || 0)])) };
        return [feature.model, {
            model: item.model || feature.model,
            version: item.version || "",
            billingMode: item.billingMode || feature.billingMode,
            unitCredits: Math.max(0, Number(item.unitCredits) || 0),
            minimumCredits: Math.max(0, Number(item.minimumCredits) || 0),
            defaultUnits: Math.max(1, Number(item.defaultUnits) || 1),
            blockSeconds: Math.max(1, Number(item.blockSeconds) || (feature.billingMode === "duration_resolution" ? 1 : 0)),
            tiers,
            enabled: item.enabled ?? false,
        }];
    }));
}

function replicateBillingModeLabel(mode: string) {
    switch (mode) {
        case "input_seconds": return "按输入音频时长收费";
        case "input_characters": return "按文字量收费";
        case "output_seconds": return "按输出视频时长收费";
        case "output_count": return "按生成条数收费";
        case "duration_resolution": return "按时长和视频规格收费";
        case "runtime_seconds": return "按模型运行时长收费";
        default: return "按任务收费";
    }
}

function replicateBillingUnitHelp(mode: string) {
    switch (mode) {
        case "input_seconds": return "每 1 秒输入音频；与上游运行时间费用分别核算";
        case "input_characters": return "每 1000 个字符";
        case "output_seconds": return "每 1 秒成片";
        case "output_count": return "每 1 条成片";
        case "duration_resolution": return "每个时长/清晰度档位";
        case "runtime_seconds": return "每 1 秒后台运行时间";
        default: return "每 1 次任务";
    }
}

function replicateTierLabel(tier: string) {
    const labels: Record<string, string> = {
        "base:480p": "基础版 · 480p", "base:720p": "基础版 · 720p", "interpolate:480p": "补帧版 · 480p", "interpolate:720p": "补帧版 · 720p",
        "720p:30": "720p · 30 FPS", "720p:60": "720p · 60 FPS", "1080p:30": "1080p · 30 FPS", "1080p:60": "1080p · 60 FPS", "4k:30": "4K · 30 FPS", "4k:60": "4K · 60 FPS",
        "480": "480p", "720": "720p", "480p": "480p · 每秒", "720p": "720p · 每秒",
        "768p:6": "768p · 6秒 / 条", "768p:10": "768p · 10秒 / 条", "1080p:6": "1080p · 6秒 / 条",
    };
    return labels[tier] || tier;
}

function normalizeChannel(item: Partial<AdminModelChannel> = {}): AdminModelChannel {
    return {
        id: item.id || 0,
        protocol: item.protocol === "replicate" ? "replicate" : item.protocol === "wavespeed" ? "wavespeed" : "openai",
        name: item.name || "",
        baseUrl: item.baseUrl || "",
        apiKey: item.apiKey || "",
        apiKeyConfigured: item.apiKeyConfigured,
        clearApiKey: item.clearApiKey,
        useEnvironmentKey: item.useEnvironmentKey,
        models: item.models || [],
        weight: Math.max(1, Number(item.weight) || 1),
        enabled: item.enabled !== false,
        remark: item.remark || "",
        allowedGroups: item.allowedGroups || [],
        videoModels: item.videoModels || {},
    };
}

function modelCostCredits(items: AdminSettings["public"]["modelChannel"]["modelCosts"], model: string) {
    return items.find((item) => item.model === model)?.credits || 0;
}

function setModelCost(form: any, setModelCosts: (items: AdminModelCost[]) => void, model: string, credits: number) {
    const current = (form.getFieldValue(["public", "modelChannel", "modelCosts"]) || []) as AdminSettings["public"]["modelChannel"]["modelCosts"];
    const next = current.filter((item) => item.model !== model);
    next.push({ model, credits: Math.max(0, credits) });
    form.setFieldValue(["public", "modelChannel", "modelCosts"], next);
    setModelCosts(next);
}

function collectChannelModels(channels: AdminModelChannel[]) {
    return uniqueModels(channels.filter((channel) => channel.enabled && channel.protocol !== "replicate" && channel.protocol !== "wavespeed").flatMap((channel) => channel.models || []));
}

function collectKnownModels(settings: AdminSettings) {
    return uniqueModels([
        ...(settings.public.modelChannel.availableModels || []),
        ...(settings.public.modelChannel.modelCosts || []).map((item) => item.model),
        ...settings.private.channels.flatMap((channel) => channel.models || []),
    ]);
}

function buildModelSelectGroups(sourceModels: string[], existingModels: string[]): Record<ModelSelectTabKey, string[]> {
    const source = uniqueModels(sourceModels);
    const existing = uniqueModels(existingModels);
    const existingSet = new Set(existing);
    return {
        new: source.filter((model) => !existingSet.has(model)),
        current: existing,
    };
}

function uniqueModels(models: string[]) {
    return Array.from(new Set(models.filter(Boolean)));
}

function modelSummary(models: string[]) {
    if (!models.length) return "未配置模型";
    const preview = models.slice(0, 3).join(", ");
    return models.length > 3 ? `${models.length} 个模型：${preview}...` : preview;
}

function parseTabJson(tab: "public", value: string): AdminSettings["public"] | null;
function parseTabJson(tab: "private", value: string): AdminSettings["private"] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null;
function parseTabJson(tab: SettingsTabKey, value: string): AdminSettings[SettingsTabKey] | null {
    try {
        return tab === "public" ? normalizePublicSetting(JSON.parse(value) as Partial<AdminSettings["public"]>) : normalizePrivateSetting(JSON.parse(value) as Partial<AdminSettings["private"]>);
    } catch {
        return null;
    }
}

async function collectSettings(form: any, editorMode: Record<SettingsTabKey, EditorMode>, jsonText: Record<SettingsTabKey, string>, message: { error: (value: string) => void }) {
    const values = normalizeSettings(form.getFieldsValue(true) as AdminSettings);
    if (editorMode.public === "json") {
        const publicSetting = parseTabJson("public", jsonText.public);
        if (!publicSetting) {
            message.error("公开配置 JSON 格式不正确");
            return null;
        }
        values.public = publicSetting;
    }
    if (editorMode.private === "json") {
        const privateSetting = parseTabJson("private", jsonText.private);
        if (!privateSetting) {
            message.error("私有配置 JSON 格式不正确");
            return null;
        }
        values.private = privateSetting;
    }
    values.public.modelChannel.availableModels = collectChannelModels(values.private.channels);
    return normalizeSettings(values);
}

function getJsonError(value: string) {
    try {
        JSON.parse(value);
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : "JSON 格式不正确";
    }
}
