import { createZip } from "@/lib/zip";
import type { ProductSetCard, ProductSetRunResult } from "@/services/api/cases";

export function findImageURL(value: unknown): string | null {
    if (typeof value === "string" && /^(https?:\/\/|data:image\/|blob:)/i.test(value)) return value;
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) return value.map(findImageURL).find((item): item is string => Boolean(item)) || null;
    const record = value as Record<string, unknown>;
    if (typeof record.b64_json === "string" && record.b64_json) return `data:image/png;base64,${record.b64_json}`;
    for (const key of ["url", "image_url", "result_url", "output", "data"]) {
        const found = findImageURL(record[key]);
        if (found) return found;
    }
    return (
        Object.values(record)
            .map(findImageURL)
            .find((item): item is string => Boolean(item)) || null
    );
}

export function productSetDownloads(cards: ProductSetCard[], results: ProductSetRunResult["items"]) {
    const byId = new Map(results.map((item) => [item.cardId, item]));
    return cards.flatMap((card, index) => {
        const result = byId.get(card.id);
        const url = result && !result.error ? findImageURL(result.data) : null;
        return url ? [{ index: index + 1, title: card.title, url }] : [];
    });
}

export async function createProductSetZip(images: ReturnType<typeof productSetDownloads>, readImage: (url: string) => Promise<Blob>, onProgress?: (completed: number) => void) {
    if (!images.length) throw new Error("暂无可下载的图片");
    const files: Array<{ name: string; data: Blob }> = [];
    for (const image of images) {
        try {
            const blob = await readImage(image.url);
            if (!blob.size || !blob.type.startsWith("image/")) throw new Error("图片内容无效");
            const extension = blob.type.split(";")[0].split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg");
            const title =
                image.title
                    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
                    .trim()
                    .replace(/[. ]+$/, "") || "商品图";
            files.push({ name: `${String(image.index).padStart(2, "0")}_${title}.${extension}`, data: blob });
            onProgress?.(files.length);
        } catch {
            throw new Error(`第 ${image.index} 张图片读取失败，未下载不完整的压缩包，请重试`);
        }
    }
    return createZip(files);
}
