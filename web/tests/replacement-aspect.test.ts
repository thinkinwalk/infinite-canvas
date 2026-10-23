import { expect, test } from "bun:test";
import { nearestReplacementAspect, replacementAspectRatios } from "../src/pages/video-tool/replacement-aspect";

test("nonstandard source dimensions recommend a supported canvas without changing orientation", () => {
    const ratios = replacementAspectRatios("768");
    for (const [width, height, expected] of [[544, 960, "9:16"], [1920, 1088, "16:9"], [1080, 1080, "1:1"], [900, 1200, "3:4"], [2100, 900, "21:9"]] as const) {
        expect(nearestReplacementAspect(ratios, width, height)).toBe(expected);
    }
    expect(nearestReplacementAspect(ratios)).toBe("");
});

test("720p recommendations use only the model's two supported ratios", () => {
    expect(replacementAspectRatios("720p")).toEqual(["16:9", "9:16"]);
    expect(nearestReplacementAspect(replacementAspectRatios("720"), 900, 1200)).toBe("9:16");
    expect(replacementAspectRatios("768")).toContain("3:4");
});
