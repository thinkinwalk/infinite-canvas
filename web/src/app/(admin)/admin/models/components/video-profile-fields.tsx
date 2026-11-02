import { Form, Input, InputNumber, Select, Switch } from "antd";
import type { VideoModelProfile } from "@/services/api/admin";
import { connectionVideoProfile } from "../model-management-options";

type Props = {
    adapter: string;
    value?: VideoModelProfile;
    onChange?: (value: VideoModelProfile) => void;
};

export function VideoProfileFields({ adapter, value, onChange }: Props) {
    const profile = connectionVideoProfile(value, adapter, value?.displayName || "")!;
    const patch = (next: Partial<VideoModelProfile>) => onChange?.({ ...profile, ...next });
    const modes = profile.inputModes || ["reference"];
    const frames = modes.includes("first_last") || modes.includes("first_frame_only");
    return (
        <div>
            <Form.Item label="视频接口">
                <Input value={profile.interface} disabled />
            </Form.Item>
            <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                <Form.Item label="输出清晰度" required>
                    <Select aria-label="输出清晰度" mode="tags" tokenSeparators={[","]} value={profile.resolutions} onChange={(resolutions) => patch({ resolutions })} placeholder="填写渠道支持的清晰度" />
                </Form.Item>
                <Form.Item label="输出秒数" required>
                    <Select aria-label="输出秒数" mode="tags" tokenSeparators={[","]} value={profile.seconds} onChange={(seconds) => patch({ seconds })} placeholder="填写渠道支持的秒数" />
                </Form.Item>
            </div>
            <Form.Item label="输入方式" required>
                <Select aria-label="输入方式" mode="multiple" value={modes} onChange={(inputModes) => patch({ inputModes })} options={[
                    { value: "reference", label: "多素材参考" },
                    { value: "first_last", label: "首尾帧" },
                    { value: "first_frame_only", label: "文生 / 单首帧" },
                ]} />
            </Form.Item>
            <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-3">
                {(["maxImages", "maxVideos", "maxAudios"] as const).map((field) => (
                    <Form.Item key={field} label={{ maxImages: "最多参考图片", maxVideos: "最多参考视频", maxAudios: "最多参考音频" }[field]}>
                        <InputNumber aria-label={{ maxImages: "最多参考图片", maxVideos: "最多参考视频", maxAudios: "最多参考音频" }[field]} min={0} precision={0} className="!w-full" value={profile[field]} onChange={(number) => patch({ [field]: number ?? 0 })} />
                    </Form.Item>
                ))}
            </div>
            {profile.maxVideos > 0 && <div className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
                {(["referenceVideoMinSeconds", "referenceVideoMaxSeconds"] as const).map((field) => (
                    <Form.Item key={field} label={field === "referenceVideoMinSeconds" ? "参考视频最短秒数" : "参考视频最长秒数"}>
                        <InputNumber min={0} value={profile[field]} onChange={(number) => patch({ [field]: number ?? undefined })} />
                    </Form.Item>
                ))}
            </div>}
            {frames && <>
                <Form.Item label="首帧字段" required>
                    <Input value={profile.firstFrameField} onChange={(event) => patch({ firstFrameField: event.target.value })} />
                </Form.Item>
                {modes.includes("first_last") && <Form.Item label="尾帧字段" required>
                    <Input value={profile.lastFrameField} onChange={(event) => patch({ lastFrameField: event.target.value })} />
                </Form.Item>}
                <Form.Item label="首帧必填"><Switch checked={profile.firstFrameRequired} onChange={(firstFrameRequired) => patch({ firstFrameRequired })} /></Form.Item>
                {modes.includes("first_last") && <Form.Item label="尾帧可选"><Switch checked={profile.lastFrameOptional} onChange={(lastFrameOptional) => patch({ lastFrameOptional })} /></Form.Item>}
            </>}
            <Form.Item label="支持生成声音"><Switch checked={profile.generateAudio} onChange={(generateAudio) => patch({ generateAudio })} /></Form.Item>
        </div>
    );
}
