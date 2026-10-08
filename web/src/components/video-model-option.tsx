import { supportedVideoInputModes, videoProfile } from "@/lib/video-capabilities";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

export function VideoModelOption({ config, model }: { config: AiConfig; model: string }) {
    const profile = videoProfile(config, model);
    const modes = supportedVideoInputModes(profile);
    const mini = /seedance.*mini/i.test(modelOptionName(model));
    const frames = modes.includes("first_last");
    const single = modes.includes("first_frame_only");
    const unavailable = profile.interface === "unavailable" || !modes.length;
    const tag = unavailable ? "暂不可用" : mini ? "日常推荐" : frames ? "首尾帧控制" : single ? profile.firstFrameRequired ? "单图生成" : "文生 / 图生" : "参考创作";
    const description = unavailable ? profile.description : frames
        ? `首帧${profile.firstFrameRequired ? "必填" : "可选"}，尾帧${profile.lastFrameOptional ? "可选" : "必填"}`
        : single ? profile.firstFrameRequired ? "上传一张首帧图片生成视频" : "纯文字即可生成，也支持一张首帧图"
        : mini ? "根据文字和参考图片生成视频" : profile.description;

    return (
        <span className="block min-w-0 flex-1 whitespace-normal py-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="break-words font-medium">{profile.displayName}</span>
                <span className="text-xs font-normal opacity-70">· {tag}</span>
            </span>
            <span className="mt-1 block break-words text-xs font-normal opacity-70">{description}</span>
        </span>
    );
}
