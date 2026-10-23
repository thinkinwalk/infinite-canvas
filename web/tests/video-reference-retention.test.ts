import { expect, test } from "bun:test";
import { canCleanVideoReference, clearExpiredReferenceURLs, ORIGINAL_VIDEO_MAX_BYTES, originalVideoSizeError, referenceExpiresAt, REFERENCE_IDLE_MS, REFERENCE_REVIEW_MS, type TemporaryVideoReference } from "../src/lib/video-reference-retention";

const reference = (): TemporaryVideoReference => ({
    id: "reference", userId: "user", name: "对标.mp4", storageKey: "media:original",
    keys: ["media:original", "media:analysis"], lastUsedAt: 1000, keep: false,
});

test("original imports accept files above the model reference budget through 300 MiB", () => {
    expect(originalVideoSizeError(51 * 1024 * 1024)).toBe("");
    expect(originalVideoSizeError(ORIGINAL_VIDEO_MAX_BYTES)).toBe("");
    expect(originalVideoSizeError(ORIGINAL_VIDEO_MAX_BYTES + 1)).toContain("300MB");
});

test("idle references expire after seven days, while review starts a separate 24 hour grace period", () => {
    const item = reference();
    expect(referenceExpiresAt(item)).toBe(1000 + REFERENCE_IDLE_MS);
    expect(canCleanVideoReference(item, referenceExpiresAt(item) - 1, new Set())).toBe(false);
    expect(canCleanVideoReference(item, referenceExpiresAt(item), new Set())).toBe(true);
    const reviewed = { ...item, reviewedAt: 10000 };
    expect(referenceExpiresAt(reviewed)).toBe(10000 + REFERENCE_REVIEW_MS);
});

test("pins, completed cleanup and any shared or active original/proxy prevent deletion", () => {
    const item = reference();
    const now = referenceExpiresAt(item) + 1;
    expect(canCleanVideoReference({ ...item, keep: true }, now, new Set())).toBe(false);
    expect(canCleanVideoReference({ ...item, cleanedAt: now }, now, new Set())).toBe(false);
    for (const key of item.keys) expect(canCleanVideoReference(item, now, new Set([key]))).toBe(false);
    expect(canCleanVideoReference(item, now, new Set(["media:other"]))).toBe(true);
});

test("renewing use starts a fresh idle period and preserves explicitly retained files", () => {
    const item = { ...reference(), keep: true, reviewedAt: 10000 };
    const renewed = { ...item, lastUsedAt: 20000, reviewedAt: undefined };
    expect(referenceExpiresAt(renewed)).toBe(20000 + REFERENCE_IDLE_MS);
    expect(canCleanVideoReference(renewed, Number.MAX_SAFE_INTEGER, new Set())).toBe(false);
});

test("expiring a reference removes stale playback URLs while preserving provenance, analysis and generated results", () => {
    const state = {
        media: [{ storageKey: "media:original", url: "blob:original", source: { title: "对标", sourceUrl: "https://example.com/share" } }],
        analysis: "镜头结构", result: { storageKey: "result:generated", url: "blob:result" },
    };
    const next = clearExpiredReferenceURLs(state, new Set(["media:original"]));
    expect(next.media[0].url).toBe("");
    expect(next.media[0].source).toEqual(state.media[0].source);
    expect(next.analysis).toBe("镜头结构");
    expect(next.result).toEqual(state.result);
    expect(state.media[0].url).toBe("blob:original");
});
