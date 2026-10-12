import { useEffect, useRef, useState } from "react";
import { Button, Modal, Slider, Typography } from "antd";
import { drawVideoFrame, loadVideoFrame, videoFrameCrop } from "@/lib/video-frames";
import type { ReferenceImage } from "@/types/image";

export function VideoFrameEditor({ references, ratio, onClose, onConfirm }: { references: ReferenceImage[]; ratio: "16:9" | "9:16"; onClose: () => void; onConfirm: (references: ReferenceImage[]) => void }) {
    const [images, setImages] = useState<HTMLImageElement[]>([]);
    const [positions, setPositions] = useState(() => references.map((item) => ({ x: item.videoFrame?.ratio === ratio ? item.videoFrame.x : 0.5, y: item.videoFrame?.ratio === ratio ? item.videoFrame.y : 0.5 })));
    const [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        void Promise.all(references.map((item) => loadVideoFrame(item, controller.signal))).then((items) => { if (!controller.signal.aborted) setImages(items); }).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "图片读取失败，请重新上传。"); });
        return () => controller.abort();
    }, [references]);
    return <Modal title="确认首尾帧构图" open onCancel={onClose} width={760} footer={<><Button onClick={onClose}>取消</Button><Button type="primary" disabled={images.length !== references.length || Boolean(error)} onClick={() => onConfirm(references.map((item, index) => ({ ...item, videoFrame: { ratio, ...positions[index], sourceWidth: images[index].naturalWidth, sourceHeight: images[index].naturalHeight } })))}>确认构图</Button></>}>
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto">
            <p className="text-sm text-muted-foreground">输出画幅 {ratio}。调整取景位置，确保人物和商品完整；只裁剪与等比缩放，不拉伸，原图保留。视频最终尺寸可能由模型对齐调整。</p>
            {error && <Typography.Text type="danger" role="alert">{error}</Typography.Text>}
            {!images.length && !error && <p role="status">正在读取图片…</p>}
            {images.map((image, index) => {
                const crop = videoFrameCrop(image.naturalWidth, image.naturalHeight, ratio);
                const retained = Math.round(crop.width * crop.height / (image.naturalWidth * image.naturalHeight) * 100);
                return <div key={references[index].id} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex flex-wrap justify-between gap-2 text-sm"><strong>{index === 0 ? "首帧" : "尾帧"}</strong><span>原图 {image.naturalWidth} × {image.naturalHeight} · 宽高比 {(image.naturalWidth / image.naturalHeight).toFixed(2)}:1</span></div>
                    <div className="grid grid-cols-2 gap-3">
                        <div><p className="mb-1 text-xs text-muted-foreground">原图</p><img src={image.src} alt={`${index === 0 ? "首帧" : "尾帧"}原图`} className="h-40 w-full rounded bg-muted object-contain" /></div>
                        <div><p className="mb-1 text-xs text-muted-foreground">提交构图 · {ratio}</p><FramePreview image={image} ratio={ratio} position={positions[index]} label={`${index === 0 ? "首帧" : "尾帧"}裁剪预览`} /></div>
                    </div>
                    <p className="text-xs text-muted-foreground">{crop.width === image.naturalWidth && crop.height === image.naturalHeight ? "完整保留画面" : `裁剪后保留约 ${retained}% 原图面积，请检查主体是否被裁掉。`}{crop.width < image.naturalWidth ? "可左右调整。" : crop.height < image.naturalHeight ? "可上下调整。" : ""}</p>
                    {crop.width < image.naturalWidth && <div className="flex items-center gap-3"><span className="text-xs">左右取景</span><Slider className="min-w-0 flex-1" ariaLabelForHandle={`${index === 0 ? "首帧" : "尾帧"}左右取景`} min={0} max={100} value={positions[index].x * 100} onChange={(value) => setPositions((items) => items.map((item, i) => i === index ? { ...item, x: value / 100 } : item))} /></div>}
                    {crop.height < image.naturalHeight && <div className="flex items-center gap-3"><span className="text-xs">上下取景</span><Slider className="min-w-0 flex-1" ariaLabelForHandle={`${index === 0 ? "首帧" : "尾帧"}上下取景`} min={0} max={100} value={positions[index].y * 100} onChange={(value) => setPositions((items) => items.map((item, i) => i === index ? { ...item, y: value / 100 } : item))} /></div>}
                </div>;
            })}
        </div>
    </Modal>;
}

function FramePreview({ image, ratio, position, label }: { image: HTMLImageElement; ratio: string; position: { x: number; y: number }; label: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [w, h] = ratio.split(":").map(Number);
    useEffect(() => { if (ref.current) drawVideoFrame(ref.current, image, ratio, position.x, position.y); }, [image, ratio, position]);
    return <div className="flex h-40 items-center justify-center rounded bg-muted"><canvas ref={ref} width={w * 40} height={h * 40} role="img" aria-label={label} className="max-h-full max-w-full" style={{ aspectRatio: `${w}/${h}` }} /></div>;
}
