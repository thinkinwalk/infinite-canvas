import { useMemo, useState } from "react";
import { App, Button, Input, InputNumber, Modal, Select } from "antd";
import { PackageOpen } from "lucide-react";

import { saveCaseDraft } from "@/services/api/cases";
import { useUserStore } from "@/stores/use-user-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export function CasePackageModal({ open, project, nodes, connections, onClose }: { open: boolean; project: CanvasProject | null | undefined; nodes: CanvasNodeData[]; connections: CanvasConnection[]; onClose: () => void }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [category, setCategory] = useState("电商");
    const [priceCredits, setPriceCredits] = useState(0);
    const [saving, setSaving] = useState(false);
    const target = useMemo(() => nodes.find((node) => node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Text), [nodes]);

    const submit = async () => {
        if (!token) {
            message.warning("请先登录后封装案例");
            return;
        }
        if (!title.trim()) {
            message.warning("请填写案例名称");
            return;
        }
        const kind = target?.type === CanvasNodeType.Video ? "video" : target?.type === CanvasNodeType.Text ? "text" : "image";
        const basePrompt = nodes.find((node) => node.type === CanvasNodeType.Text)?.metadata?.content || target?.metadata?.prompt || target?.metadata?.composerContent || "";
        const prompt = basePrompt.includes("{{prompt}}") ? basePrompt : `${basePrompt}${basePrompt ? "\n\n" : ""}用户要求：{{prompt}}`;
        const sanitizedNodes = nodes.map((node) => {
            if (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                return { ...node, metadata: { ...node.metadata, content: undefined, images: undefined } };
            }
            return node;
        });
        setSaving(true);
        try {
            await saveCaseDraft(token, {
                title: title.trim(),
                description: description.trim(),
                category,
                tags: [category],
                publicSchema: { fields: [{ key: "prompt", label: "生成描述", type: "textarea", required: true, placeholder: "请输入本次生成要求" }] },
                workflowSnapshot: { schemaVersion: 1, projectId: project?.id || "", nodes: sanitizedNodes, connections },
                runtimeConfig: { kind, model: target?.metadata?.model || "", promptTemplate: prompt, size: target?.metadata?.size || "", quality: target?.metadata?.quality || "", seconds: target?.metadata?.seconds || "", ratio: target?.metadata?.ratio || "", resolution: target?.metadata?.resolution || "", generateAudio: target?.metadata?.generateAudio === "true", watermark: target?.metadata?.watermark === "true" },
                priceCredits,
                memberPriceCredits: priceCredits > 0 ? Math.max(1, Math.ceil(priceCredits * 0.75)) : 0,
                revenueSharePercent: 60,
            });
            message.success("案例草稿已保存，可在「我的案例」提交审核");
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存案例失败");
        } finally {
            setSaving(false);
        }
    };

    return <Modal open={open} title={<span className="flex items-center gap-2"><PackageOpen className="size-4" />封装为案例</span>} onCancel={onClose} footer={<><Button onClick={onClose}>取消</Button><Button type="primary" loading={saving} onClick={() => void submit()}>保存草稿</Button></>}>
        <div className="space-y-4">
            <p className="text-sm leading-6 text-stone-500">当前画布会保存为服务端私有工作流。发布后客户只会看到公开输入表单，不会看到节点和提示词。</p>
            <Input placeholder="案例名称，例如：商品多场景主图" value={title} onChange={(event) => setTitle(event.target.value)} />
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} placeholder="案例说明" value={description} onChange={(event) => setDescription(event.target.value)} />
            <Select className="w-full" value={category} onChange={setCategory} options={["电商", "服装鞋包", "家具家装", "视频创作", "创意应用"].map((value) => ({ label: value, value }))} />
            <InputNumber className="w-full" min={0} value={priceCredits} onChange={(value) => setPriceCredits(value || 0)} addonAfter="算力点/次" />
        </div>
    </Modal>;
}

