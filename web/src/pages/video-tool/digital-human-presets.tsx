import { useState } from "react";
import { App, Button, Input, Modal, Select } from "antd";
import { nanoid } from "nanoid";

import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { DigitalHumanPreset, VideoDraft } from "@/types/video-workbench";
import { restoreWorkbenchFile } from "./use-video-workbench";

export function DigitalHumanPresets({ draft: d, locked, onApply }: { draft: VideoDraft; locked: boolean; onApply: (value: Partial<VideoDraft>) => void }) {
    const { message, modal } = App.useApp();
    const presets = useVideoWorkbenchStore((s) => s.digitalPresets);
    const [kind, setKind] = useState<DigitalHumanPreset["kind"] | null>(null);
    const [name, setName] = useState("");
    const [restoring, setRestoring] = useState(false);
    const save = () => {
        if (!kind || locked || !name.trim()) return;
        const avatar = d.media.find((m) => m.role === "avatar" && m.kind === (d.digitalHumanMode === "photo" ? "image" : "video"));
        const voice = d.media.find((m) => m.role === "voice" && m.kind === "audio");
        if (kind === "avatar" && !avatar) return void message.error("请先选择人物形象");
        if (d.voiceMode === "clone" && !voice) return void message.error("请先上传声音样本");
        const { digitalHumanMode, digitalMotion, voiceMode, promptTranscript, language, replicateSpeaker, voice: systemVoice, route, subtitleSize, subtitleColor, highlightColor } = d;
        useVideoWorkbenchStore.getState().saveDigitalPreset({
            id: nanoid(), name: name.trim(), kind,
            media: d.media.filter((m) => (kind === "avatar" && m.id === avatar?.id) || (voiceMode === "clone" && m.id === voice?.id)),
            settings: { digitalHumanMode, digitalMotion, voiceMode, promptTranscript, language, replicateSpeaker, voice: systemVoice, route, subtitleSize, subtitleColor, highlightColor },
        });
        setKind(null);
        setName("");
        message.success("已保存到当前浏览器");
    };
    const apply = async (id: string) => {
        const preset = presets.find((p) => p.id === id);
        if (!preset || locked || restoring) return;
        setRestoring(true);
        try {
            const files = await Promise.all(preset.media.map(async (m) => ({ ...m, ...(await restoreWorkbenchFile(m)) })));
            const state = useVideoWorkbenchStore.getState();
            if (state.busyTools["digital-human"]) throw new Error("正在处理，请完成后再选择预设");
            const current = state.drafts["digital-human"] || d;
            const { voiceMode, promptTranscript, language, replicateSpeaker, voice, route } = preset.settings;
            onApply({
                ...(preset.kind === "avatar" ? preset.settings : { voiceMode, promptTranscript, language, replicateSpeaker, voice, route }),
                media: [...current.media.filter((m) => m.role !== "voice" && (preset.kind !== "avatar" || m.role !== "avatar")), ...files],
            });
            message.success(`已应用${preset.name}，请核对配音后生成视频`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "预设素材读取失败，请重新上传");
        } finally {
            setRestoring(false);
        }
    };
    return (
        <div className="space-y-2">
            {(["avatar", "voice"] as const).map((type) => (
                <div className="flex flex-wrap gap-2" key={type}>
                    <Select className="min-w-40 flex-1" aria-label={type === "avatar" ? "常用主播" : "资产库音色"} value={undefined} placeholder={type === "avatar" ? "选择常用主播" : "选择已保存音色"} disabled={locked || restoring} loading={restoring} options={presets.filter((p) => p.kind === type).map((p) => ({ value: p.id, label: p.name }))} onChange={(id: string) => void apply(id)} />
                    <Button size="small" disabled={locked || restoring} onClick={() => { setName(""); setKind(type); }}>保存 / 管理{type === "avatar" ? "主播" : "音色"}</Button>
                </div>
            ))}
            <p className="text-xs opacity-70">预设保存在本浏览器；主播包含人物、音色和字幕样式。应用后保留正文，需重新制作配音与视频。</p>
            <Modal open={kind !== null} title={kind === "avatar" ? "保存 / 管理常用主播" : "保存 / 管理音色"} okText="保存当前设置" cancelText="关闭" onCancel={() => setKind(null)} onOk={save} okButtonProps={{ disabled: locked || !name.trim() }}>
                <Input aria-label="预设名称" value={name} placeholder="例如：张老板 / 温柔女声" onChange={(e) => setName(e.target.value)} />
                <div className="mt-3 space-y-2">
                    {presets.filter((p) => p.kind === kind).map((p) => (
                        <div className="flex items-center justify-between gap-2" key={p.id}>
                            <span className="truncate">{p.name}</span>
                            <Button type="text" size="small" disabled={locked} onClick={() => modal.confirm({ title: `删除“${p.name}”？`, content: "只删除这项预设，保留当前草稿和素材。", okText: "删除", cancelText: "保留", onOk: () => { useVideoWorkbenchStore.getState().removeDigitalPreset(p.id); } })}>删除</Button>
                        </div>
                    ))}
                </div>
            </Modal>
        </div>
    );
}
