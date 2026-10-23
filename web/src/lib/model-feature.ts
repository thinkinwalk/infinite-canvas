// Function identity is independent of model names and visible labels.
export function modelFeatureForPath(path: string, capability: string, context?: { replacement?: string; replacementModel?: string; maskedEdit?: boolean; speechMode?: string; digitalHumanMode?: string }) {
    if (path.startsWith("/canvas")) return `canvas.${capability}`;
    if (path.startsWith("/image") && !path.startsWith("/image-creation")) return capability === "text" ? "prompt.enhance" : "image.generate";
    if (path.includes("content-replace")) {
        if (capability === "audio") return "replace.transcribe";
        if (context?.maskedEdit) return "replace.masked";
        if (context?.replacement === "person") return context.replacementModel === "headswap" ? "replace.head" : "replace.person";
        return `replace.${context?.replacement || "person"}`;
    }
    for (const tool of ["store-explore", "viral-recreate"]) {
        if (path.includes(tool)) return `${tool}.${capability === "text" ? "script" : capability}`;
    }
    for (const tool of ["digital-human", "photo-talk", "lipsync"]) {
        if (path.includes(tool)) return `${tool}.${capability === "text" ? "script" : capability === "image" ? "cover" : capability === "audio" ? context?.speechMode === "voice_clone" ? "clone" : "speech" : tool === "lipsync" || context?.digitalHumanMode === "video" ? "lipsync" : "photo"}`;
    }
    if (path.includes("/video/upscale")) return "video.upscale";
    if (path.includes("/video/subtitle-remove")) return "video.subtitle-remove";
    if (path.startsWith("/video")) return capability === "text" ? "video.script" : "video.generate";
    return capability === "image" ? "image.generate" : capability === "video" ? "video.generate" : capability === "audio" ? "digital-human.speech" : "prompt.enhance";
}
