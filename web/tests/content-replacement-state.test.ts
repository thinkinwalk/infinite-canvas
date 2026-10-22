import { expect, test } from "bun:test";
import { hasReplacementRecovery, isLegacyMaskedPersonRecord, isPendingReplacement, normalizeContentReplacementDraft } from "../src/lib/content-replacement-state";
import { emptyVideoDraft, type VideoRecord, type WorkbenchMedia } from "../src/types/video-workbench";

const source: WorkbenchMedia = { id: "source", role: "reference", kind: "video", name: "source.mp4", url: "blob:source", storageKey: "source", mimeType: "video/mp4", bytes: 100, durationMs: 5000 };
const image: WorkbenchMedia = { ...source, id: "image", role: "model", kind: "image", name: "person.png", mimeType: "image/png" };
const mask: WorkbenchMedia = { ...source, id: "mask", role: "mask" };
const regions = [{ x: 0.1, y: 0.2, width: 0.4, height: 0.6 }];
const legacyDraft = () => ({
    ...emptyVideoDraft("content-replace"), maskedPerson: true, maskedEdit: true,
    media: [source, image, mask], regions, replacementSeedTime: 1.25,
    final: source, video: source, activeRecord: "paid", replacementJobId: "batch",
});
const record = (): VideoRecord => ({
    id: "paid", tool: "content-replace", stage: "video", createdAt: 1, status: "interrupted",
    replacementInput: legacyDraft(),
    maskedReplacement: { phase: "generate", workerUrl: "/api/v1/video-worker", mask },
});

test("old browser drafts converge without losing sources, outputs or current task", () => {
    const old = legacyDraft();
    const next = normalizeContentReplacementDraft(old);
    expect(next.maskedPerson).toBe(false);
    expect(next.maskedEdit).toBe(false);
    expect(next.regions).toEqual([]);
    expect(next.replacementSeedTime).toBeUndefined();
    expect(next.media).toEqual([source, image]);
    expect(next.final).toBe(old.final);
    expect(next.video).toBe(old.video);
    expect(next.activeRecord).toBe("paid");
    expect(next.replacementJobId).toBe("batch");
    expect(old.media).toEqual([source, image, mask]);
    expect(normalizeContentReplacementDraft(next)).toBe(next);
    expect(normalizeContentReplacementDraft({ ...old, maskedPerson: false })).toEqual(next);
});

test("person drafts from retired worker/model routes enter the current automatic workflow", () => {
    for (const route of ["worker", "model"] as const) {
        const next = normalizeContentReplacementDraft({ ...legacyDraft(), route });
        expect(next.route).toBe("replicate");
        expect(next.media).toEqual([source, image]);
    }
    const face = normalizeContentReplacementDraft({ ...legacyDraft(), replacementModel: "headswap" });
    expect(face.replacementModel).toBe("headswap");
});

test("product and background masks, seed frames and route are unchanged", () => {
    for (const replacement of ["product", "background"] as const) {
        const draft = { ...legacyDraft(), replacement, route: "worker" as const };
        expect(normalizeContentReplacementDraft(draft)).toBe(draft);
    }
});

test("restoring a historical snapshot never re-enables the retired UI or mutates recovery inputs", () => {
    const paid = record();
    const snapshot = structuredClone(paid);
    const visible = normalizeContentReplacementDraft({ ...emptyVideoDraft("content-replace"), ...paid.replacementInput });
    expect(visible.maskedPerson).toBe(false);
    expect(paid).toEqual(snapshot);
    expect(paid.replacementInput?.regions).toEqual(regions);
    expect(paid.replacementInput?.replacementSeedTime).toBe(1.25);
    expect(paid.replacementInput?.media).toContain(mask);
    expect(isLegacyMaskedPersonRecord(paid)).toBe(true);
    expect(isPendingReplacement(paid)).toBe(true);
});

test("mask-only and composite-only recovery states remain discoverable", () => {
    const maskOnly = { ...record(), maskedReplacement: undefined, replacementMaskTask: { id: "tracking-paid", operation: "track-mask" as const } };
    expect(hasReplacementRecovery(maskOnly)).toBe(true);
    expect(isLegacyMaskedPersonRecord(maskOnly)).toBe(true);
    expect(isPendingReplacement(maskOnly)).toBe(true);
    expect(isPendingReplacement({ ...maskOnly, status: "completed" })).toBe(false);
    expect(hasReplacementRecovery({ ...maskOnly, status: "failed" })).toBe(true);
    expect(isLegacyMaskedPersonRecord({ ...record(), maskedReplacement: undefined })).toBe(false);
    expect(isPendingReplacement({ ...maskOnly, tool: "subtitle-remove" })).toBe(false);
});
