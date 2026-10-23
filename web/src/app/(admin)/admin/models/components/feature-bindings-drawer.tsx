import { useState } from "react";
import { App, Button, Checkbox, Drawer, Empty, Flex, Input, Select, Space, Typography } from "antd";
import { ClearOutlined } from "@ant-design/icons";
import type { ModelFeature } from "@/services/api/model-management";

type Props = {
    name: string;
    features: ModelFeature[];
    selectedIds: string[];
    onApply: (ids: string[]) => void;
    onClose: () => void;
};

export function FeatureBindingsDrawer({ name, features, selectedIds, onApply, onClose }: Props) {
    const { modal } = App.useApp();
    const [ids, setIds] = useState(selectedIds);
    const [keyword, setKeyword] = useState("");
    const [module, setModule] = useState<string>();
    const groupName = (feature: ModelFeature) => feature.module.split(" · ")[0];
    const modules = [...new Set(features.map(groupName))].sort((a, b) => Number(a === "案例") - Number(b === "案例"));
    const search = keyword.trim().toLowerCase();
    const visible = features.filter((feature) => (!module || groupName(feature) === module) &&
        (!search || `${feature.module} ${feature.label} ${feature.id}`.toLowerCase().includes(search)));
    const changed = ids.length !== selectedIds.length || ids.some((id) => !selectedIds.includes(id));
    const close = () => changed ? modal.confirm({
        title: "放弃未应用的功能调整",
        content: "本次选择尚未应用到草稿，是否放弃？",
        okText: "放弃调整",
        cancelText: "继续编辑",
        onOk: onClose,
    }) : onClose();
    const toggle = (targets: string[], checked: boolean) => setIds((current) => checked
        ? [...new Set([...current, ...targets])]
        : current.filter((id) => !targets.includes(id)));

    return <Drawer title={<span className="break-words">适用功能 · {name}</span>} open width="min(640px, 100vw)" onClose={close}
        footer={<Flex gap={8} wrap justify="flex-end"><Button onClick={close}>取消</Button><Button type="primary" onClick={() => onApply(ids)}>应用到草稿</Button></Flex>}>
        <Space direction="vertical" size={16} className="w-full">
            <Input.Search aria-label="搜索适用功能" placeholder="搜索模块、功能名称或编号" value={keyword} onChange={(event) => setKeyword(event.target.value)} allowClear />
            <Flex gap={12} wrap align="center" justify="space-between">
                <Select aria-label="功能模块" placeholder="全部模块" allowClear value={module} onChange={setModule} style={{ width: 180, maxWidth: "100%" }}
                    options={modules.map((value) => ({ value, label: value }))} />
                <Space wrap><Typography.Text>已选择 {ids.length} 项</Typography.Text><Button type="text" icon={<ClearOutlined />} disabled={!ids.length} onClick={() => setIds([])}>清空选择</Button></Space>
            </Flex>
            {!visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={features.length ? "没有匹配的功能" : "暂无匹配的功能"} />}
            {modules.map((name) => {
                const group = visible.filter((feature) => groupName(feature) === name);
                if (!group.length) return null;
                const checkedCount = group.filter((feature) => ids.includes(feature.id)).length;
                return <section key={name} aria-label={`${name}功能`} className="border-b border-[var(--ant-color-border-secondary)] pb-4">
                    <Flex gap={12} justify="space-between" align="center" className="mb-3">
                        <Checkbox aria-label={`全选${name}`} checked={checkedCount === group.length} indeterminate={checkedCount > 0 && checkedCount < group.length}
                            onChange={(event) => toggle(group.map((feature) => feature.id), event.target.checked)}><Typography.Text strong>{name}</Typography.Text></Checkbox>
                        <Typography.Text type="secondary">{checkedCount} / {group.length}</Typography.Text>
                    </Flex>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-3 pl-6 sm:grid-cols-2">
                        {group.map((feature) => <Checkbox key={feature.id} checked={ids.includes(feature.id)}
                            className="min-w-0 [&_.ant-checkbox-label]:min-w-0 [&_.ant-checkbox-label]:break-words"
                            onChange={(event) => toggle([feature.id], event.target.checked)}>
                            {feature.module === name ? feature.label : `${feature.module.slice(name.length + 3)} · ${feature.label}`}
                        </Checkbox>)}
                    </div>
                </section>;
            })}
        </Space>
    </Drawer>;
}
