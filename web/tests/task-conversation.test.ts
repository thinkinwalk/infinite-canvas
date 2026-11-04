import { expect, test } from "bun:test";
import { parseTaskChangePlan, taskConversationPlanText, taskConversationTranscript } from "../src/pages/video-tool/task-conversation";

test("a confirmed plan keeps its targets, changes, preserved content and video evidence", () => {
    const plan = parseTaskChangePlan(JSON.stringify({
        summary: "开头没有突出招牌菜",
        targets: [{ id: "shot-1", label: "镜头 1" }],
        changes: [{ targetId: "shot-1", change: "改为商品近景", preserve: "保留 4 秒时长和原台词" }],
        unchanged: ["镜头 2"],
        evidence: [{ timeSeconds: 1.25, description: "成片开头未出现商品" }],
    }), ["shot-1", "shot-2"]);

    expect(taskConversationPlanText(plan)).toContain("成片依据：1.25秒：成片开头未出现商品");
    expect(plan.targets).toEqual([{ id: "shot-1", label: "镜头 1" }]);
    expect(plan.changes[0]?.preserve).toBe("保留 4 秒时长和原台词");
    expect(() => parseTaskChangePlan(JSON.stringify(plan), ["shot-2"])).toThrow("超出当前可修改范围");
});

test("invalid, duplicate or incomplete plans cannot become confirmable proposals", () => {
    const valid = {
        summary: "缩短开场",
        targets: [{ id: "shot-1", label: "镜头 1" }],
        changes: [{ targetId: "shot-1", change: "缩短台词", preserve: "保留画面" }],
        unchanged: ["其他镜头"],
    };
    expect(() => parseTaskChangePlan("不是JSON", ["shot-1"])).toThrow("原稿未改动");
    expect(() => parseTaskChangePlan(JSON.stringify({ ...valid, targets: [...valid.targets, ...valid.targets] }), ["shot-1"])).toThrow("超出当前可修改范围");
    expect(() => parseTaskChangePlan(JSON.stringify({ ...valid, changes: [] }), ["shot-1"])).toThrow("缺少问题范围或具体调整内容");
    expect(() => parseTaskChangePlan(JSON.stringify({ ...valid, changes: [{ ...valid.changes[0], targetId: "shot-2" }] }), ["shot-1"])).toThrow("无法核对");
});

test("dialogue history remains ordered and distinguishes user feedback from assistant replies", () => {
    const messages = [
        { id: "1", role: "user" as const, text: "只调整开头", createdAt: 1 },
        { id: "2", role: "assistant" as const, text: "保留哪些内容？", createdAt: 2 },
        { id: "3", role: "user" as const, text: "保留原时长", createdAt: 3 },
    ];
    expect(taskConversationTranscript(messages)).toBe("用户：只调整开头\n助手：保留哪些内容？\n用户：保留原时长");
});
