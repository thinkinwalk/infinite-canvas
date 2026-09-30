import { expect, test } from "bun:test";

import { readZip } from "../src/lib/zip";
import { createProductSetZip, productSetDownloads } from "../src/pages/cases/product-set-download";
import type { ProductSetCard } from "../src/services/api/cases";

const cards: ProductSetCard[] = [
    { id: "first", title: "商品/主图", description: "", aspectRatio: "1:1" },
    { id: "second", title: "细节图", description: "", aspectRatio: "1:1" },
    { id: "third", title: "商品/主图", description: "", aspectRatio: "1:1" },
];

test("downloads follow card order and exclude failed or missing images", () => {
    const images = productSetDownloads(cards, [
        { cardId: "third", title: "", data: { data: [{ url: "https://example.com/three.jpg" }] } },
        { cardId: "second", title: "", error: "失败", data: { url: "https://example.com/failed.png" } },
        { cardId: "first", title: "", data: { data: [{ b64_json: "AA==" }] } },
    ]);
    expect(images.map((item) => item.index)).toEqual([1, 3]);
    expect(images[0].url).toBe("data:image/png;base64,AA==");
    expect(productSetDownloads(cards, [])).toEqual([]);
});

test("zip retains original bytes and unique numbered names", async () => {
    const progress: number[] = [];
    const originals = [new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" })];
    const zip = await createProductSetZip([
        { index: 1, title: "商品/主图", url: "one" },
        { index: 3, title: "商品/主图", url: "three" },
    ], async (url) => originals[url === "one" ? 0 : 1], (completed) => progress.push(completed));
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(["01_商品_主图.png", "03_商品_主图.jpg"]);
    expect(new Uint8Array(await files.get("01_商品_主图.png")!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await files.get("03_商品_主图.jpg")!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    expect(progress).toEqual([1, 2]);
});

test("missing image bytes fail the archive instead of silently exporting fewer images", async () => {
    await expect(createProductSetZip([{ index: 2, title: "图", url: "missing" }], async () => { throw new Error("network failure"); })).rejects.toThrow("第 2 张图片读取失败");
    await expect(createProductSetZip([], async () => new Blob())).rejects.toThrow("暂无可下载的图片");
});
