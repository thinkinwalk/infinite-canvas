import localforage from "localforage";

type JsonObject = Record<string, any>;
type Delta = { value: unknown } | { changes: Record<string, Delta>; removed: string[] };
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "video_workbench" });
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("video-workbench");
let baseline: JsonObject = {};
let writing = Promise.resolve();
let failure: unknown;
let mutation = 0;
const unsaved: Delta[] = [];

// Apply only this tab's changed fields, under one browser-wide write lock.
function difference(before: any, after: any): Delta | undefined {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (!after || typeof after !== "object" || Array.isArray(after) || !before || typeof before !== "object" || Array.isArray(before)) return { value: after };
    const changes: Record<string, Delta> = {};
    for (const key of Object.keys(after)) {
        const delta = difference(before[key], after[key]);
        if (delta) changes[key] = delta;
    }
    return { changes, removed: Object.keys(before).filter((key) => !(key in after)) };
}

function apply(current: any, delta: Delta): any {
    if ("value" in delta) return delta.value;
    const next = { ...current };
    for (const key of delta.removed) delete next[key];
    for (const [key, change] of Object.entries(delta.changes)) next[key] = apply(next[key], change);
    return next;
}

function decode(raw: string | null): JsonObject {
    const saved = raw ? JSON.parse(raw) : {};
    if (saved.state?.records) saved.state.records = Object.fromEntries(saved.state.records.map((record: { id: string }) => [record.id, record]));
    return saved;
}

function encode(saved: JsonObject): string {
    const state = { ...saved.state };
    if (state.records) state.records = Object.values(state.records).sort((a: any, b: any) => b.createdAt - a.createdAt);
    return JSON.stringify({ ...saved, state });
}

export const flushWorkbenchStorage = async () => {
    await writing;
    if (failure) throw failure;
};

export const workbenchStorage = {
    getItem: async (key: string) => {
        for (;;) {
            await flushWorkbenchStorage();
            const version = mutation;
            const raw = await storage.getItem<string>(key);
            if (version !== mutation) continue;
            baseline = decode(raw);
            return raw;
        }
    },
    setItem: (key: string, raw: string) => {
        const next = decode(raw);
        const delta = difference(baseline, next);
        baseline = next;
        if (!delta) return writing;
        mutation++;
        unsaved.push(delta);
        const save = async () => {
            const changes = unsaved.splice(0);
            if (!changes.length) return;
            const update = async () => {
                const latest = decode(await storage.getItem<string>(key));
                await storage.setItem(key, encode(changes.reduce(apply, latest)));
            };
            try {
                if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request("video-workbench-write", update);
                else await update();
                failure = undefined;
            } catch (error) {
                unsaved.unshift(...changes);
                failure = error;
                throw error;
            }
            channel?.postMessage("updated");
        };
        const pending = writing.then(save);
        writing = pending.catch(() => {});
        return pending;
    },
    removeItem: (key: string) => storage.removeItem(key),
};

channel?.addEventListener("message", () => {
    void writing.then(() => window.dispatchEvent(new Event("video-workbench-synced")));
});
