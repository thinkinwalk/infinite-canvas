import { expect, test } from "bun:test";

import { streamProductSet, type ProductSetInput } from "../src/services/api/cases";

const inputs = { images: ["data:image/png;base64,AA=="], cardIds: ["white-background"] } as ProductSetInput;

test("product-set stream reports each result before the batch finishes", async () => {
    const originalFetch = globalThis.fetch;
    const updates: Array<[string, number, number]> = [];
    const payload = [
        JSON.stringify({ type: "start", total: 1 }),
        JSON.stringify({ type: "item", item: { cardId: "white-background", title: "白底图", data: { url: "https://example.com/image.png" } }, completed: 1, total: 1 }),
        JSON.stringify({ type: "done", failed: 0, total: 1 }),
    ].join("\n") + "\n";
    const bytes = new TextEncoder().encode(payload);
    globalThis.fetch = async (_url, options) => {
        expect(options?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer token" });
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(bytes.slice(0, 15));
                controller.enqueue(bytes.slice(15, 73));
                controller.enqueue(bytes.slice(73));
                controller.close();
            },
        }), { headers: { "Content-Type": "application/x-ndjson" } });
    };
    try {
        const result = await streamProductSet("token", "official-product-grid", inputs, (item, completed, total) => updates.push([item.cardId, completed, total]));
        expect(updates).toEqual([["white-background", 1, 1]]);
        expect(result.total).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.items[0]?.cardId).toBe("white-background");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("product-set stream reports an interrupted batch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ type: "start", total: 1 }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
    try {
        await expect(streamProductSet("token", "official-product-grid", inputs, () => undefined)).rejects.toThrow("生成连接中断");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
