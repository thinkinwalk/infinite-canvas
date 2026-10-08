import { createZip } from "@/lib/zip";
import { fetchImageBlob } from "@/services/image-storage";
import { moduleImage, profileFor, sliceRanges, type DetailDraft, type DetailModule } from "./model";

function canvasOf(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器无法创建图片画布");
    return { canvas, ctx };
}
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number) {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        let line = "";
        // Preserve word boundaries where possible; split long tokens to avoid clipping.
        for (const token of paragraph.match(/[A-Za-z0-9]+\s*|[^A-Za-z0-9]/gu) || []) {
            if (line && ctx.measureText(line + token).width > width) { lines.push(line.trimEnd()); line = ""; }
            for (const char of token) {
                if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = ""; }
                line += char;
            }
        }
        lines.push(line.trimEnd());
    }
    return lines;
}
export async function renderModule(module: DetailModule, draft: DetailDraft): Promise<HTMLCanvasElement> {
    const profile = profileFor(draft);
    const url = moduleImage(module, draft);
    if (!url) throw new Error(`${module.role}：请先选择实拍或生成底图`);
    const bitmap = await createImageBitmap(await fetchImageBlob(url));
    try {
        const width = profile.width;
        const height = profile.photoOnly ? Math.round(bitmap.height * width / bitmap.width) : profile.height;
        const { canvas, ctx } = canvasOf(width, height);
        ctx.fillStyle = draft.background; ctx.fillRect(0, 0, width, height);
        const hasText = !profile.photoOnly && module.layout !== "none" && draft.language !== "无文字" && Boolean(module.title || module.body);
        const pad = Math.round(width * 0.05);
        const textWidth = module.layout === "left" ? width * 0.42 : width;
        const textHeight = module.layout === "left" ? height : height * 0.31;
        const imageX = hasText && module.layout === "left" ? textWidth : 0;
        const imageY = hasText && module.layout === "top" ? textHeight : 0;
        const imageWidth = width - imageX, imageHeight = height - imageY;
        // Fit the full product in the image area without inventing/cropping product details.
        const scale = Math.min(imageWidth / bitmap.width, imageHeight / bitmap.height);
        const dw = bitmap.width * scale, dh = bitmap.height * scale;
        ctx.drawImage(bitmap, imageX + (imageWidth - dw) / 2, imageY + (imageHeight - dh) / 2, dw, dh);
        if (hasText) {
            ctx.fillStyle = draft.foreground; ctx.textBaseline = "top";
            let y = pad;
            for (const [content, fontSize, weight] of [[module.title, width * 0.045, 700], [module.body, width * 0.026, 400]] as const) {
                if (!content) continue;
                ctx.font = `${weight} ${fontSize}px "Microsoft YaHei", Arial, sans-serif`;
                const lines = wrap(ctx, content, textWidth - 2 * pad);
                const lineHeight = fontSize * 1.45;
                if (y + lines.length * lineHeight > textHeight - pad / 2) throw new Error(`${module.role}：文案超出排版区域，请缩短文字或更换版式`);
                for (const line of lines) { ctx.fillText(line, pad, y); y += lineHeight; }
                y += pad * 0.3;
            }
        }
        return canvas;
    } finally { bitmap.close(); }
}
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片导出失败；整页过长时请使用切片包")), "image/jpeg", 0.92));
}
export async function renderEnabled(draft: DetailDraft) {
    const modules = draft.modules.filter(m => m.enabled);
    if (!modules.length) throw new Error("请至少启用一个模块");
    if (!draft.confirmed && !profileFor(draft).photoOnly) throw new Error("请先核对并确认商品事实与文案");
    const canvases: HTMLCanvasElement[] = [];
    for (const module of modules) canvases.push(await renderModule(module, draft));
    return { modules, canvases };
}
function composeRange(canvases: HTMLCanvasElement[], y: number, height: number) {
    const { canvas, ctx } = canvasOf(canvases[0].width, height);
    let offset = 0;
    for (const image of canvases) {
        const start = Math.max(y, offset), end = Math.min(y + height, offset + image.height);
        if (end > start) ctx.drawImage(image, 0, start - offset, image.width, end - start, 0, start - y, image.width, end - start);
        offset += image.height;
    }
    return canvas;
}
export async function exportLongImage(draft: DetailDraft) {
    const { canvases } = await renderEnabled(draft);
    return canvasBlob(composeRange(canvases, 0, canvases.reduce((sum, c) => sum + c.height, 0)));
}
export async function exportDetailPackage(draft: DetailDraft) {
    const profile = profileFor(draft);
    const { modules, canvases } = await renderEnabled(draft);
    const sliced = profile.output === "slices";
    const ranges = sliceRanges(canvases.map(c => c.height), sliced ? draft.sliceMode : "module", draft.sliceHeight);
    const folder = sliced ? "slices" : profile.output === "aplus" ? "aplus" : profile.output === "sections" ? "sections" : "gallery";
    const files: { name: string; data: BlobPart }[] = [];
    for (const [i, range] of ranges.entries()) {
        const canvas = sliced ? composeRange(canvases, range.y, range.height) : canvases[i];
        files.push({ name: `${folder}/${String(i + 1).padStart(2, "0")}.jpg`, data: await canvasBlob(canvas) });
    }
    const manifest = {
        version: 1, platform: profile.label, output: profile.output, width: profile.width,
        market: draft.market, language: draft.language, strategy: profile.note,
        template: profile.output === "aplus" ? draft.amazonTemplate : undefined,
        files: ranges.map((r, i) => ({ file: files[i].name, width: profile.width, height: r.height, ...(sliced ? { y: r.y } : { moduleId: modules[i].id }) })),
        modules: modules.map((m, i) => ({ id: m.id, role: m.role, title: m.title, body: m.body, source: profile.photoOnly ? "photo" : m.source, width: canvases[i].width, height: canvases[i].height })),
    };
    files.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) });
    files.push({ name: "copy.txt", data: modules.map((m, i) => `${i + 1}. ${m.role}\n${m.title}\n${m.body}`).join("\n\n") });
    files.push({ name: "使用说明.txt", data: `${profile.label} · ${profile.width}px\n${profile.note}\n按文件名顺序上传 ${folder} 目录中的图片。尺寸为制作预设，请核对后台实际上传位置。\n${sliced && draft.sliceMode === "fixed" ? "固定高度切片可能跨越图文；建议优先使用按模块切片。" : ""}\n实拍模式只做等比缩放；不会把合成图转换成实拍。\n制作参考：Gayaya999/ecommerce-detail-page-generator、linbei0/EcomGen。` });
    return createZip(files);
}
