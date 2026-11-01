import { expect, test } from "bun:test";
import { archiveContentReplacementDraft, hasReplacementRecovery, isCurrentReplacementRecord, isLegacyMaskedPersonRecord, isPendingReplacement, newContentReplacementDraft, normalizeContentReplacementDraft } from "../src/lib/content-replacement-state";
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

test("archiving a replaced draft preserves its inputs and outputs without changing existing records", () => {
    const existing = record();
    const draft = {
        ...emptyVideoDraft("content-replace"),
        ...legacyDraft(),
        instructions: "保留这份任务",
        replacement: "product" as const,
        replacementTaskId: "task-1",
    };

    const archived = archiveContentReplacementDraft(draft, [existing]);

    expect(archived).toHaveLength(2);
    expect(archived[0]).toMatchObject({
        id: "content-replace-draft:task-1",
        tool: "content-replace",
        stage: "draft",
        status: "completed",
        replacementDraft: draft,
        result: draft.final,
        text: draft.instructions,
    });
    expect(archived[0].replacementDraft?.media).toEqual(draft.media);
    expect(archived[1]).toBe(existing);
    expect(newContentReplacementDraft()).toMatchObject({
        ...emptyVideoDraft("content-replace"),
        replacementTaskId: expect.any(String),
    });
    expect(newContentReplacementDraft().media).toEqual([]);
});

test("archiving the same task replaces its archived snapshot instead of duplicating it", () => {
    const draft = { ...emptyVideoDraft("content-replace"), instructions: "初始要求", replacementTaskId: "task-1" };
    const archived = archiveContentReplacementDraft(draft, []);
    const updated = archiveContentReplacementDraft({ ...draft, instructions: "更新后的要求" }, archived);

    expect(updated).toHaveLength(1);
    expect(updated[0].replacementDraft?.instructions).toBe("更新后的要求");
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

test("an independent replacement task is not blocked by historical cloud records", () => {
    const draft = { ...newContentReplacementDraft(), replacementModel: "headswap" as const, media: [source, image] };
    const old = {
        ...record(), replicateTask: { id: "old-edit", operation: "masked-edit" },
        replacementInput: { ...legacyDraft(), replacementTaskId: "old-task" },
    };
    const snapshot = structuredClone(old);
    expect(isCurrentReplacementRecord(old, draft)).toBe(false);
    expect(isCurrentReplacementRecord({ ...old, replacementInput: undefined }, draft)).toBe(false);
    expect(isCurrentReplacementRecord({ ...old, status: "failed" }, draft)).toBe(false);
    expect(isPendingReplacement(old)).toBe(true);
    expect(old).toEqual(snapshot);
});

test("current task cloud records stay protected after editing clears the selected record", () => {
    const old = { ...record(), replacementInput: { ...legacyDraft(), replacementTaskId: "current-task" } };
    const draft = { ...newContentReplacementDraft(), replacementTaskId: "current-task", activeRecord: undefined };
    expect(isCurrentReplacementRecord(old, draft)).toBe(true);
    expect(isCurrentReplacementRecord(old, { ...draft, instructions: "修改要求" })).toBe(true);
    expect(isCurrentReplacementRecord(old, { ...draft, replacementTaskId: "another-task" })).toBe(false);
    expect(isCurrentReplacementRecord({ ...old, tool: "subtitle-remove" }, draft)).toBe(false);
});

test("explicitly restored records retain their own identity without changing historical input snapshots", () => {
    const old = record(), draft = newContentReplacementDraft();
    expect(isCurrentReplacementRecord(old, { ...draft, activeRecord: old.id })).toBe(true);
    expect(isCurrentReplacementRecord(old, { ...draft, replacementTaskId: old.id })).toBe(true);
    expect(isCurrentReplacementRecord({ ...old, id: "another-record" }, { ...draft, replacementTaskId: old.id })).toBe(false);
    expect(old.replacementInput?.replacementTaskId).toBeUndefined();
    expect(isCurrentReplacementRecord(old, emptyVideoDraft("content-replace"))).toBe(false);
});
