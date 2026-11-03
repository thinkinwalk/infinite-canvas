import { afterEach, expect, test } from "bun:test";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { useUserStore } = await import("../src/stores/use-user-store");
const { useReplacementJobsStore: store } = await import("../src/stores/use-replacement-jobs-store");
const originalFetch = globalThis.fetch;
const online = (id: string) => ({ id, createdAt: "2026-11-02T00:00:00Z", status: "completed" } as Parameters<ReturnType<typeof store.getState>["update"]>[0]);
const respond = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState({ token: "" }); store.getState().reset(""); });

test("logout clears online history and late responses cannot restore the previous account", async () => {
    useUserStore.setState({ token: "first" });
    store.getState().reset("first");
    let complete!: (response: Response) => void;
    globalThis.fetch = () => new Promise((resolve) => { complete = resolve; });
    const pending = store.getState().refresh();
    useUserStore.setState({ token: "second" });
    store.getState().reset("second");
    complete(respond([online("first-job")]));
    await pending;
    expect(store.getState().jobs).toEqual([]);
    store.getState().update(online("stale-update"), "first");
    expect(store.getState().jobs).toEqual([]);
});

test("a slow list response never undoes a completed archive operation", async () => {
    useUserStore.setState({ token: "session" });
    store.getState().reset("session");
    let complete!: (response: Response) => void;
    globalThis.fetch = () => new Promise((resolve) => { complete = resolve; });
    const pending = store.getState().refresh();
    store.getState().update({ ...online("job"), archived: true }, "session");
    complete(respond([{ ...online("job"), archived: false }]));
    await pending;
    expect(store.getState().jobs[0].archived).toBe(true);
});

test("read errors preserve loaded records and a later successful read clears the error", async () => {
    useUserStore.setState({ token: "session" });
    store.getState().reset("session");
    store.getState().update(online("saved"), "session");
    globalThis.fetch = async () => { throw new Error("offline"); };
    await store.getState().refresh();
    expect(store.getState().error).toBe("offline");
    expect(store.getState().jobs[0].id).toBe("saved");
    globalThis.fetch = async () => respond([online("latest")]);
    await store.getState().refresh();
    expect(store.getState().error).toBe("");
    expect(store.getState().jobs[0].id).toBe("latest");
});

test("an older overlapping read cannot replace a newer result", async () => {
    useUserStore.setState({ token: "session" });
    store.getState().reset("session");
    const pending: ((response: Response) => void)[] = [];
    globalThis.fetch = () => new Promise((resolve) => { pending.push(resolve); });
    const first = store.getState().refresh(), second = store.getState().refresh();
    pending[1](respond([online("new")]));
    await second;
    pending[0](respond([online("old")]));
    await first;
    expect(store.getState().jobs[0].id).toBe("new");
});
