import { inferVideoRatio } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

export function wanFrameRatio(size: string): "16:9" | "9:16" {
    return inferVideoRatio(size) === "9:16" ? "9:16" : "16:9";
}

export async function loadVideoFrame(reference: ReferenceImage, signal?: AbortSignal) {
    const source = await imageToDataUrl(reference, { signal });
    signal?.throwIfAborted();
    const image = new Image();
    image.src = source;
    try { await image.decode(); } catch { throw new Error(`无法读取“${reference.name}”，请重新上传可打开的图片。`); }
    signal?.throwIfAborted();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片尺寸无效，请重新上传。");
    return image;
}

// Positions describe the remaining horizontal/vertical space, not a stretched image.
export function videoFrameCrop(width: number, height: number, ratio: string, x = 0.5, y = 0.5) {
    const [rw, rh] = ratio.split(":").map(Number);
    const cropWidth = Math.min(width, height * rw / rh);
    const cropHeight = Math.min(height, width * rh / rw);
    return { x: (width - cropWidth) * x, y: (height - cropHeight) * y, width: cropWidth, height: cropHeight };
}

export function drawVideoFrame(canvas: HTMLCanvasElement, image: HTMLImageElement, ratio: string, x: number, y: number) {
    const crop = videoFrameCrop(image.naturalWidth, image.naturalHeight, ratio, x, y);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理图片，请更换浏览器后重试。");
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    return crop;
}

export async function prepareWanVideoFrames(references: ReferenceImage[], size: string, resolution: string, signal?: AbortSignal) {
    const ratio = wanFrameRatio(size);
    const result: ReferenceImage[] = [];
    for (const reference of references) {
        const image = await loadVideoFrame(reference, signal);
        const frame = reference.videoFrame;
        const [rw, rh] = ratio.split(":").map(Number);
        const alreadyFits = image.naturalWidth * rh === image.naturalHeight * rw;
        if (frame && (frame.ratio !== ratio || frame.sourceWidth !== image.naturalWidth || frame.sourceHeight !== image.naturalHeight || !Number.isFinite(frame.x) || !Number.isFinite(frame.y) || frame.x < 0 || frame.x > 1 || frame.y < 0 || frame.y > 1)) {
            throw new Error("素材或画幅已改变，请在视频创作台重新确认首尾帧构图。");
        }
        if (!frame && !alreadyFits) throw new Error("首尾帧需要先确认裁剪构图，请进入视频创作台调整画幅后生成。");
        const canvas = document.createElement("canvas");
        const unit = resolution.replace(/p$/i, "") === "720" ? 80 : 52;
        canvas.width = rw * unit;
        canvas.height = rh * unit;
        drawVideoFrame(canvas, image, ratio, frame?.x ?? 0.5, frame?.y ?? 0.5);
        // A new upload is created from this copy; the user's original storage key stays intact.
        result.push({ id: reference.id, name: reference.name, type: "image/png", dataUrl: canvas.toDataURL("image/png") });
    }
    signal?.throwIfAborted();
    return result;
}
