import { useState } from "react";
import { App, Button, Input, Modal, Select } from "antd";
import { nanoid } from "nanoid";

import { useVideoWorkbenchStore } from "@/stores/use-video-workbench-store";
import type { DigitalHumanPreset, VideoDraft, WorkbenchMedia } from "@/types/video-workbench";
import { restoreWorkbenchFile } from "./use-video-workbench";
import { digitalSystemSpeakers } from "./digital-human-request";

const builtinAvatarSettings: DigitalHumanPreset["settings"] = {
    digitalHumanMode: "photo",
    digitalMotion: "自然看向镜头，轻微自然表情",
    voiceMode: "api",
    promptTranscript: "",
    language: "中文",
    replicateSpeaker: digitalSystemSpeakers[0] || "Serena",
    voice: digitalSystemSpeakers[0] || "Serena",
    route: "replicate",
    subtitleSize: 42,
    subtitleColor: "#ffffff",
    highlightColor: "#facc15",
};

type BuiltinAvatarPreset = DigitalHumanPreset & { description: string; scene: string };

const builtinAvatarCatalog = [
    ["business-lecturer", "商务讲师 · 专业可信", "短发、藏蓝西装、冷色背景", "企业培训、课程介绍、专业服务"],
    ["shop-owner", "实体店主 · 亲切务实", "中年男士、眼镜、深绿 POLO", "门店经营、产品推荐、本地生活"],
    ["beauty-host", "美妆导购 · 年轻活力", "高马尾、珊瑚色上衣、明亮背景", "美妆个护、服饰、生活方式"],
    ["knowledge-expert", "知识科普 · 沉稳理性", "短发银丝、橄榄绿针织衫", "健康科普、知识讲解、教育内容"],
    ["tech-advisor", "科技顾问 · 年轻专业", "卷发、炭灰衬衫、冷灰背景", "数码家电、软件工具、科技产品"],
    ["wellness-coach", "健康顾问 · 温和亲切", "成熟女性、灰发、米色针织衫", "养老护理、家庭健康、情感陪伴"],
] as const;

const builtinAvatarPresets: BuiltinAvatarPreset[] = builtinAvatarCatalog.map(([slug, name, description, scene], index) => {
    const number = String(index + 1).padStart(2, "0");
    const media: WorkbenchMedia = {
        id: `builtin-host-${number}`,
        name: `默认写实主播 ${number}`,
        url: `/digital-human/hosts/host-${number}.png`,
        storageKey: `builtin:digital-human-host-${number}`,
        bytes: 0,
        mimeType: "image/png",
        width: 1024,
        height: 1536,
        kind: "image",
        role: "avatar",
    };
    return { id: media.storageKey, name, description, scene, kind: "avatar", media: [{ ...media, name }], settings: builtinAvatarSettings };
});

export function DigitalHumanPresets({ draft: d, locked, onApply }: { draft: VideoDraft; locked: boolean; onApply: (value: Partial<VideoDraft>) => void }) {
    const { message, modal } = App.useApp();
    const presets = useVideoWorkbenchStore((s) => s.digitalPresets);
    const avatarPresets = [...builtinAvatarPresets, ...presets.filter((p) => p.kind === "avatar")];
    const selectedAvatarKey = d.media.find((m) => m.role === "avatar")?.storageKey;
    const [kind, setKind] = useState<DigitalHumanPreset["kind"] | null>(null);
    const [name, setName] = useState("");
    const [restoring, setRestoring] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const selectedAvatarMedia = d.media.find((m) => m.role === "avatar");
    const selectedAvatarPreset = avatarPresets.find((preset) => preset.media[0]?.storageKey === selectedAvatarKey);
    const save = () => {
        if (!kind || locked || !name.trim()) return;
        const avatar = d.media.find((m) => m.role === "avatar" && m.kind === (d.digitalHumanMode === "photo" ? "image" : "video"));
        const voice = d.media.find((m) => m.role === "voice" && m.kind === "audio");
        if (kind === "avatar" && !avatar) return void message.error("请先选择人物形象");
        if (d.voiceMode === "clone" && !voice) return void message.error("请先上传声音样本");
        const { digitalHumanMode, digitalMotion, voiceMode, promptTranscript, language, replicateSpeaker, voice: systemVoice, route, subtitleSize, subtitleColor, highlightColor } = d;
        useVideoWorkbenchStore.getState().saveDigitalPreset({
            id: nanoid(),
            name: name.trim(),
            kind,
            media: d.media.filter((m) => (kind === "avatar" && m.id === avatar?.id) || (voiceMode === "clone" && m.id === voice?.id)),
            settings: { digitalHumanMode, digitalMotion, voiceMode, promptTranscript, language, replicateSpeaker, voice: systemVoice, route, subtitleSize, subtitleColor, highlightColor },
        });
        setKind(null);
        setName("");
        message.success("已保存到当前浏览器");
    };
    const apply = async (id: string) => {
        const preset = [...builtinAvatarPresets, ...presets].find((p) => p.id === id);
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
            <p className="text-xs opacity-70">默认主播是为口播场景生成的虚拟形象；也可以上传本人或已取得商业授权的人物照片/视频。系统音色可直接选择，常用音色用于保存你自己的配置。</p>
            <div className="flex flex-wrap gap-2">
                <Select
                    className="min-w-56 flex-1"
                    aria-label="默认系统音色"
                    value={d.voiceMode === "api" && d.route === "replicate" ? d.replicateSpeaker : undefined}
                    placeholder="选择默认系统音色"
                    disabled={locked || restoring}
                    options={digitalSystemSpeakers.map((value) => ({ value, label: `${value} · 系统音色` }))}
                    onChange={(replicateSpeaker: string) => onApply({ voiceMode: "api", route: "replicate", replicateSpeaker })}
                />
                <span className="flex items-center text-xs opacity-70">选择后可在“先试听音色”中试听</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-medium">主播形象</div>
                    <div className="text-xs opacity-65">先看缩略图，选中后在上方查看大图</div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {presets.some((p) => p.kind === "avatar") && (
                        <Button size="small" disabled={locked || restoring} onClick={() => setAssetPickerOpen(true)}>
                            从资产库选择
                        </Button>
                    )}
                    <Button
                        size="small"
                        disabled={locked || restoring}
                        onClick={() => {
                            setName("");
                            setKind("avatar");
                        }}
                    >
                        保存 / 管理主播
                    </Button>
                </div>
            </div>
            {selectedAvatarMedia && (
                <div className="flex items-center gap-4 rounded-lg border border-blue-500/40 bg-blue-500/5 p-3">
                    <img src={selectedAvatarMedia.url} alt={selectedAvatarPreset?.name || selectedAvatarMedia.name} className="h-48 w-32 shrink-0 rounded-md bg-black/20 object-contain sm:h-56 sm:w-36" />
                    <div className="min-w-0">
                        <div className="text-sm font-medium">当前主播：{selectedAvatarPreset?.name || selectedAvatarMedia.name}</div>
                        <div className="mt-1 text-xs opacity-70">生成口播视频时将使用这个人物形象。点击下方缩略图即可更换。</div>
                    </div>
                </div>
            )}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="默认写实主播缩略图">
                {builtinAvatarPresets.map((preset) => (
                    <button
                        key={preset.id}
                        type="button"
                        disabled={locked || restoring}
                        title={`${preset.name}：${preset.description}`}
                        className={`min-w-0 overflow-hidden rounded-lg border p-1.5 text-left transition ${selectedAvatarKey === preset.media[0]?.storageKey ? "border-blue-500 bg-blue-500/10 ring-2 ring-blue-500/50" : "hover:border-blue-400"}`}
                        onClick={() => void apply(preset.id)}
                    >
                        <div className="relative mx-auto aspect-[2/3] w-full max-w-20 bg-black/20">
                            <img src={preset.media[0]?.url} alt={preset.name} className="h-full w-full object-contain" />
                            {selectedAvatarKey === preset.media[0]?.storageKey && <span className="absolute left-0.5 top-0.5 rounded-full bg-blue-600 px-1 py-0.5 text-[10px] text-white">已选</span>}
                        </div>
                        <span className="mt-1 block truncate text-center text-[11px] font-medium">{preset.name.split(" · ")[0]}</span>
                        <span className="block truncate text-center text-[10px] opacity-65">{preset.scene.split("、")[0]}</span>
                    </button>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Select
                    className="min-w-40 flex-1"
                    aria-label="资产库音色"
                    value={undefined}
                    placeholder="选择已保存音色（暂无时为空）"
                    disabled={locked || restoring}
                    loading={restoring}
                    options={presets.filter((p) => p.kind === "voice").map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(id: string) => void apply(id)}
                />
                <Button
                    size="small"
                    disabled={locked || restoring}
                    onClick={() => {
                        setName("");
                        setKind("voice");
                    }}
                >
                    保存 / 管理音色
                </Button>
            </div>
            <p className="text-xs opacity-70">常用主播和音色预设保存在本浏览器；应用后保留正文，需重新制作配音与视频。</p>
            <Modal open={assetPickerOpen} title="从资产库选择主播" footer={null} onCancel={() => setAssetPickerOpen(false)}>
                <div className="space-y-2">
                    {presets
                        .filter((p) => p.kind === "avatar")
                        .map((preset) => (
                            <div className="flex items-center justify-between gap-3 rounded-lg border p-2" key={preset.id}>
                                <span className="truncate text-sm">{preset.name}</span>
                                <Button
                                    size="small"
                                    disabled={locked || restoring}
                                    onClick={() => {
                                        setAssetPickerOpen(false);
                                        void apply(preset.id);
                                    }}
                                >
                                    应用
                                </Button>
                            </div>
                        ))}
                </div>
            </Modal>
            <Modal open={kind !== null} title={kind === "avatar" ? "保存 / 管理常用主播" : "保存 / 管理音色"} okText="保存当前设置" cancelText="关闭" onCancel={() => setKind(null)} onOk={save} okButtonProps={{ disabled: locked || !name.trim() }}>
                <Input aria-label="预设名称" value={name} placeholder="例如：张老板 / 温柔女声" onChange={(e) => setName(e.target.value)} />
                <div className="mt-3 space-y-2">
                    {presets
                        .filter((p) => p.kind === kind)
                        .map((p) => (
                            <div className="flex items-center justify-between gap-2" key={p.id}>
                                <span className="truncate">{p.name}</span>
                                <Button
                                    type="text"
                                    size="small"
                                    disabled={locked}
                                    onClick={() =>
                                        modal.confirm({
                                            title: `删除“${p.name}”？`,
                                            content: "只删除这项预设，保留当前草稿和素材。",
                                            okText: "删除",
                                            cancelText: "保留",
                                            onOk: () => {
                                                useVideoWorkbenchStore.getState().removeDigitalPreset(p.id);
                                            },
                                        })
                                    }
                                >
                                    删除
                                </Button>
                            </div>
                        ))}
                </div>
            </Modal>
        </div>
    );
}
