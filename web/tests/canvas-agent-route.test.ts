import { expect, test } from "bun:test";
import { isCanvasAgentRoute } from "../src/lib/canvas-agent-route";

test("canvas Agent is visible only on canvas routes", () => {
    expect(isCanvasAgentRoute("/canvas")).toBe(true);
    expect(isCanvasAgentRoute("/canvas/project-1")).toBe(true);
    expect(isCanvasAgentRoute("/video/store-explore")).toBe(false);
    expect(isCanvasAgentRoute("/video/viral-recreate")).toBe(false);
});
