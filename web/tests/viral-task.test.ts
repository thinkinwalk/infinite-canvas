import { expect, test } from "bun:test";
import { archiveViralTask, hasViralTaskContent, viralTaskDraft, viralTaskGroups } from "../src/lib/viral-task";
import { emptyVideoDraft, type VideoRecord } from "../src/types/video-workbench";

const draft = () => ({
    ...emptyVideoDraft("viral-recreate"), viralTaskId: "task-a", viralStep: 1,
    instructions: "Use the new location", script: "My edited script", viralScriptSuggestion: "An unused suggestion",
    media: [{ id: "image", role: "visual-reference" as const, kind: "image" as const, name: "location.jpg", storageKey: "image:stored", url: "blob:old", mimeType: "image/jpeg", bytes: 100 }],
});
const record = (patch: Partial<VideoRecord> = {}): VideoRecord => ({
    id: "analysis", tool: "viral-recreate", stage: "analyze", status: "completed", createdAt: 1, ...patch,
});

test("empty defaults do not create history; manual input and optional image edits do", () => {
    const empty = emptyVideoDraft("viral-recreate"), records = [record()];
    expect(hasViralTaskContent(empty)).toBe(false);
    expect(archiveViralTask(empty, records)).toBe(records);
    for (const patch of [{ instructions: "Manual requirements" }, { script: "Manual script" }, { viralBrief: { subject: "Name", person: "", scene: "", marks: "" } }, { viralKeyframePrompt: "Camera position" }])
        expect(hasViralTaskContent({ ...empty, ...patch })).toBe(true);
});

test("archiving preserves the complete draft and media references without rewriting step records", () => {
    const current = draft(), original = record({ viralTaskId: "task-a" });
    const records = archiveViralTask(current, [original]);
    expect(records).toHaveLength(2);
    expect(records[0].viralDraft).toEqual(current);
    expect(records[1]).toBe(original);
    expect(viralTaskDraft(records[0])).toEqual(current);
});

test("saving another revision updates one snapshot and keeps other tasks", () => {
    const other = record({ id: "task-b", viralTaskId: "task-b" });
    const first = archiveViralTask(draft(), [other]);
    const next = archiveViralTask({ ...draft(), script: "The latest manual edit" }, first);
    expect(next).toHaveLength(2);
    expect(next[0].viralDraft?.script).toBe("The latest manual edit");
    expect(next[1]).toBe(other);
});

test("continuing a completed step includes its result and starts from empty defaults", () => {
    const saved = record({
        id: "script", stage: "script", viralTaskId: "task-a",
        viralInput: { ...emptyVideoDraft("viral-recreate"), script: "Before", channelMode: "remote", baseUrl: "" },
        draftPatch: { script: "Generated script", viralScriptSuggestion: "Protected suggestion" },
    });
    const restored = viralTaskDraft(saved)!;
    expect(restored.script).toBe("Generated script");
    expect(restored.viralScriptSuggestion).toBe("Protected suggestion");
    expect(restored.viralTaskId).toBe("task-a");
    expect(restored.viralStep).toBe(1);
    expect(restored.video).toBeNull();
    expect(restored.viralClimaxId).toBeUndefined();
    expect(saved.viralInput?.script).toBe("Before");
});

test("failed steps restore original input, without applying partial results", () => {
    const saved = record({
        id: "failed", status: "failed",
        viralInput: { ...emptyVideoDraft("viral-recreate"), script: "Protected script", viralScriptSuggestion: "Previous pending result", viralScriptSuggestionBase: "Original comparison base", channelMode: "remote", baseUrl: "" },
        draftPatch: { script: "Incomplete result" },
    });
    expect(viralTaskDraft(saved)?.script).toBe("Protected script");
    expect(viralTaskDraft(saved)?.viralScriptSuggestion).toBe("Previous pending result");
    expect(viralTaskDraft(saved)?.viralScriptSuggestionBase).toBe("Original comparison base");
    expect(viralTaskDraft(saved)?.viralTaskId).toBe("failed");
});

test("task groups collect new step records, prefer the latest saved draft and retain ungrouped history", () => {
    const records = archiveViralTask(draft(), [
        record({ viralTaskId: "task-a" }), record({ id: "script", stage: "script", viralTaskId: "task-a", createdAt: 2 }),
        record({ id: "old-a" }), record({ id: "old-b" }),
    ]);
    const groups = viralTaskGroups(records);
    expect(groups).toHaveLength(3);
    expect(groups[0].id).toBe("task-a");
    expect(groups[0].current.viralDraft?.script).toBe("My edited script");
    expect(groups[0].records.map((entry) => entry.id)).toEqual(["script", "analysis"]);
    expect(groups.map((group) => group.id)).toContain("old-a");
    expect(groups.map((group) => group.id)).toContain("old-b");
});

test("task previews prefer the generated video over newer intermediate text", () => {
    const video = { url: "blob:result", storageKey: "video:output", bytes: 100, mimeType: "video/mp4" };
    const groups = viralTaskGroups([
        record({ id: "later-text", viralTaskId: "task-a", createdAt: 3, text: "A newer analysis" }),
        record({ id: "video", viralTaskId: "task-a", createdAt: 2, stage: "video", result: video }),
    ]);
    expect(groups[0].result?.result).toBe(video);
});
