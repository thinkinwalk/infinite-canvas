import type { TaskChangePlan, TaskConversationMessage } from "@/types/task-conversation";
import { diffLines } from "diff";

export function taskConversationMessage(role: TaskConversationMessage["role"], text: string): TaskConversationMessage {
    return { id: crypto.randomUUID(), role, text, createdAt: Date.now() };
}

export function taskConversationContextKey(value: unknown) {
    return JSON.stringify(value);
}

export function parseTaskChangePlan(raw: string, allowedTargetIds?: string[]): TaskChangePlan {
    let value: unknown;
    try {
        value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch {
        throw new Error("修改方案暂时无法整理，请继续补充需求后重试；原稿未改动");
    }
    if (!value || typeof value !== "object") throw new Error("修改方案信息不完整，请继续讨论；原稿未改动");
    const plan = value as Record<string, unknown>;
    if (typeof plan.summary !== "string" || !plan.summary.trim() || !Array.isArray(plan.targets) || !plan.targets.length || !Array.isArray(plan.changes) || !plan.changes.length || !Array.isArray(plan.unchanged)) {
        throw new Error("修改方案缺少问题范围或具体调整内容，请继续讨论；原稿未改动");
    }
    const targets = plan.targets.map((item) => {
        const row = item as Record<string, unknown>;
        if (!row || typeof row.id !== "string" || !row.id || typeof row.label !== "string" || !row.label.trim()) throw new Error("修改方案中的对象无法对应当前内容；原稿未改动");
        return { id: row.id, label: row.label.trim() };
    });
    const targetIds = new Set(targets.map((target) => target.id));
    if (targetIds.size !== targets.length || targets.some((target) => allowedTargetIds && !allowedTargetIds.includes(target.id))) throw new Error("修改方案超出当前可修改范围；原稿未改动");
    const changes = plan.changes.map((item) => {
        const row = item as Record<string, unknown>;
        if (!row || typeof row.targetId !== "string" || !targetIds.has(row.targetId) || typeof row.change !== "string" || !row.change.trim() || typeof row.preserve !== "string") throw new Error("修改方案中的具体调整无法核对；原稿未改动");
        return { targetId: row.targetId, change: row.change.trim(), preserve: row.preserve.trim() };
    });
    if (plan.unchanged.some((item) => typeof item !== "string" || !item.trim())) throw new Error("修改方案中的保留范围无效；原稿未改动");
    const evidence = Array.isArray(plan.evidence) ? plan.evidence.map((item) => {
        const row = item as Record<string, unknown>;
        if (!row || typeof row.description !== "string" || !row.description.trim() || (row.timeSeconds !== undefined && (typeof row.timeSeconds !== "number" || !Number.isFinite(row.timeSeconds) || row.timeSeconds < 0))) throw new Error("修改方案中的依据无法核对；原稿未改动");
        return { ...(typeof row.timeSeconds === "number" ? { timeSeconds: row.timeSeconds } : {}), description: row.description.trim() };
    }) : undefined;
    return { summary: plan.summary.trim(), targets, changes, unchanged: plan.unchanged as string[], ...(evidence?.length ? { evidence } : {}) };
}

export function taskConversationPlanText(plan: TaskChangePlan) {
    return [
        `问题理解：${plan.summary}`,
        `影响范围：${plan.targets.map((target) => target.label).join("、")}`,
        ...plan.changes.map((change) => `${plan.targets.find((target) => target.id === change.targetId)?.label || "修改项"}：${change.change}${change.preserve ? `；保留：${change.preserve}` : ""}`),
        `明确不修改：${plan.unchanged.join("；")}`,
        ...(plan.evidence?.length ? [`成片依据：${plan.evidence.map((item) => `${item.timeSeconds === undefined ? "" : `${item.timeSeconds.toFixed(2)}秒：`}${item.description}`).join("；")}`] : []),
    ].join("\n");
}

export function taskConversationTranscript(messages: TaskConversationMessage[]) {
    return messages.map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`).join("\n");
}

export function taskConversationDiffRows(before: string, after: string) {
    const rows: { before: string; after: string; changed: boolean }[] = [];
    const changes = diffLines(before, after);
    for (let i = 0; i < changes.length; i++) {
        const part = changes[i];
        if (!part.added && !part.removed) {
            rows.push({ before: part.value, after: part.value, changed: false });
            continue;
        }
        let left = "", right = "";
        while (i < changes.length && (changes[i].added || changes[i].removed)) {
            if (changes[i].removed) left += changes[i].value;
            else right += changes[i].value;
            i++;
        }
        i--;
        rows.push({ before: left, after: right, changed: true });
    }
    return rows;
}
