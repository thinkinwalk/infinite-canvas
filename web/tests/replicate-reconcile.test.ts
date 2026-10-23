import { afterEach, expect, test } from "bun:test";
import axios from "axios";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) || null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
} });
const { reconcileReplicateTask } = await import("../src/services/api/replicate");
const { useUserStore } = await import("../src/stores/use-user-store");
const adapter = axios.defaults.adapter;
afterEach(() => { axios.defaults.adapter = adapter; useUserStore.setState({ token: "" }); });

test("reconciliation sends distinct local and upstream task identifiers without submitting another generation", async () => {
    useUserStore.setState({ token: "admin-session" });
    const calls: string[] = [];
    axios.defaults.adapter = async (config) => {
        calls.push(config.url!);
        expect(config.method).toBe("post");
        expect(config.url).toBe("/api/admin/replicate/tasks/local-task/reconcile");
        expect(JSON.parse(config.data)).toEqual({ predictionId: "upstream-prediction" });
        expect(config.headers.Authorization).toBe("Bearer admin-session");
        return { data: { code: 0, data: { id: "local-task", predictionId: "upstream-prediction", status: "running" } }, status: 200, statusText: "OK", headers: {}, config };
    };
    const result = await reconcileReplicateTask("local-task", "upstream-prediction");
    expect(result.predictionId).toBe("upstream-prediction");
    expect(calls).toHaveLength(1);
});

test("a mismatched upstream task surfaces the rejection without retrying generation", async () => {
    useUserStore.setState({ token: "admin-session" });
    let calls = 0;
    axios.defaults.adapter = async (config) => {
        calls++;
        return { data: { code: 1, msg: "上游模型、版本或输入与原任务不一致，拒绝关联" }, status: 200, statusText: "OK", headers: {}, config };
    };
    await expect(reconcileReplicateTask("local-task", "wrong-prediction")).rejects.toThrow("拒绝关联");
    expect(calls).toBe(1);
});
