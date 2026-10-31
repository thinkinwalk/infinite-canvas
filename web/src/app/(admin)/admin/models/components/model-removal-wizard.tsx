import { Alert, Button, Descriptions, Drawer, Space, Steps, Tag, Typography } from "antd";
import { DeleteOutlined, PauseCircleOutlined } from "@ant-design/icons";
import type { FeatureBinding, ManagedModel, ModelFeature, ModelManagement } from "@/services/api/model-management";
import { channelModelDependencies } from "../model-management-options";

type Props = {
    open: boolean;
    channelId: number;
    channelName: string;
    model: string;
    management: ModelManagement;
    baseline: ModelManagement;
    features: ModelFeature[];
    onCancel: () => void;
    onDisableAndSave: () => void;
    onRemoveAndSave: () => void;
};

export function ModelRemovalWizard({ open, channelId, channelName, model, management, baseline, features, onCancel, onDisableAndSave, onRemoveAndSave }: Props) {
    const routes = management.routes.filter((route) => route.channelId === channelId && route.model === model);
    const routeIds = new Set(routes.map((route) => route.id));
    const dependencies = channelModelDependencies(management, channelId, model);
    const platformModels = management.models.filter((entry) => entry.routeIds.some((id) => routeIds.has(id)));
    const bindings = management.bindings.filter((binding) => binding.routeIds.some((id) => routeIds.has(id)));
    const needsDisableSave = routes.some((route) => route.enabled) || baseline.routes.some((route) => route.channelId === channelId && route.model === model && route.enabled);
    const featureName = (binding: FeatureBinding) => {
        const feature = features.find((entry) => entry.id === binding.featureId);
        return feature ? `${feature.module} · ${feature.label}` : binding.featureId;
    };

    return (
        <Drawer
            open={open}
            width="min(680px, 100vw)"
            title="移除渠道模型向导"
            onClose={onCancel}
            extra={<Tag color="red">移除渠道接入</Tag>}
            footer={
                <Space className="w-full justify-end" wrap>
                    <Button onClick={onCancel}>取消</Button>
                    {routes.length > 0 &&
                        (needsDisableSave ? (
                            <Button type="primary" icon={<PauseCircleOutlined />} onClick={onDisableAndSave}>
                                停用接入并保存
                            </Button>
                        ) : (
                            <Button danger type="primary" icon={<DeleteOutlined />} onClick={onRemoveAndSave}>
                                解除引用并移除
                            </Button>
                        ))}
                </Space>
            }
        >
            <Space direction="vertical" size={16} className="w-full">
                <Steps current={routes.length === 0 ? 0 : needsDisableSave ? 0 : 1} items={[{ title: "停用接入" }, { title: "解除引用并移除" }]} />
                <Descriptions size="small" bordered column={1}>
                    <Descriptions.Item label="渠道">{channelName}</Descriptions.Item>
                    <Descriptions.Item label="上游真实模型 ID">{model}</Descriptions.Item>
                    <Descriptions.Item label="目录接入">
                        {routes.length
                            ? routes.map((route) => (
                                  <Tag key={route.id} color={route.enabled ? "processing" : "default"}>
                                      {route.id} · {route.enabled ? "启用中" : "已停用"}
                                  </Tag>
                              ))
                            : "未找到对应的模型目录接入"}
                    </Descriptions.Item>
                </Descriptions>

                {routes.length === 0 ? (
                    <Alert type="info" showIcon message="模型目录中没有对应接入" description="请返回系统设置中的渠道编辑器，再保存移除该上游模型。" />
                ) : needsDisableSave ? (
                    <Alert type="warning" showIcon message="先停用并保存接入" description="接入仍启用，或当前停用状态尚未保存。保存后向导会进入解除引用步骤；当前平台模型和功能绑定不会被改动。" />
                ) : (
                    <Alert
                        type="warning"
                        showIcon
                        message="确认解除下列目录引用"
                        description="确认后会移除该渠道接入及其目录引用；仍有其他接入的平台模型会保留。失去全部接入的平台模型会保留记录但自动停用，无接入的功能绑定也会自动停用。历史任务或计费记录仍可能阻止保存。"
                    />
                )}

                <section>
                    <Typography.Text strong>引用的平台模型（{platformModels.length}）</Typography.Text>
                    {platformModels.length ? (
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                            {platformModels.map((entry: ManagedModel) => (
                                <li key={entry.id}>
                                    {entry.displayName} · {entry.routeIds.length > 1 ? `另有 ${entry.routeIds.length - routes.filter((route) => entry.routeIds.includes(route.id)).length} 个接入` : "仅此接入"}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <Typography.Paragraph type="secondary" className="mt-2">
                            没有平台模型引用。
                        </Typography.Paragraph>
                    )}
                </section>

                <section>
                    <Typography.Text strong>引用的功能绑定（{bindings.length}）</Typography.Text>
                    {bindings.length ? (
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                            {bindings.map((binding) => (
                                <li key={`${binding.featureId}:${binding.modelId}`}>{featureName(binding)}</li>
                            ))}
                        </ul>
                    ) : (
                        <Typography.Paragraph type="secondary" className="mt-2">
                            没有功能绑定引用。
                        </Typography.Paragraph>
                    )}
                </section>

                {needsDisableSave && dependencies.some((dependency) => dependency.enabled) && <Typography.Text type="secondary">此接入仍启用；先停用可避免影响新报价和新任务。</Typography.Text>}
            </Space>
        </Drawer>
    );
}
