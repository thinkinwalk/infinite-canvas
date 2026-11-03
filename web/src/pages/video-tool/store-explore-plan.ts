import type { StoreExploreInput, StoreShot, VideoDraft } from "@/types/video-workbench";
import type { AiConfig } from "@/stores/use-config-store";

export function storeSuggestedPurpose(name: string) {
    if (/门头|招牌|门面|front/i.test(name)) return "门头";
    if (/环境|室内|大厅|interior/i.test(name)) return "环境";
    if (/商品|产品|菜品|饮品|product/i.test(name)) return "商品";
    if (/服务|制作|过程|service/i.test(name)) return "服务";
    return "未分类";
}

export const storeKeyframeKey = (d: VideoDraft) => JSON.stringify([d.media.filter((m) => m.kind === "image").map((m) => [m.id, m.storageKey, m.role, m.storePurpose, m.storePerson]), d.script, d.storeFacts, d.instructions]);

export function storeFreeScriptError(script: string, seconds: number, ratio: string) {
    const duration = script.match(/(?:总时长|全片时长|视频时长)\s*[：:]?\s*(\d+(?:\.\d+)?)\s*秒/);
    if (duration && Number(duration[1]) !== seconds) return `自由脚本明确写为 ${duration[1]} 秒，与当前 ${seconds} 秒不同，请修改正文或规格`;
    const aspect = script.match(/(?:画幅|画面比例|视频比例)\s*[：:]?\s*(\d+)\s*[:：]\s*(\d+)/);
    if (aspect && ratio !== "auto" && `${aspect[1]}:${aspect[2]}` !== ratio) return "自由脚本画幅与当前设置不同，请修改正文或规格";
    return "";
}

export const storePlanKey = (d: VideoDraft) => JSON.stringify([d.script, d.storeShots || [], d.storeFacts, d.instructions, d.analysis, d.storeSettings, d.media.filter((m) => m.kind === "image" || m.role === "voice").map((m) => [m.id, m.storageKey || m.url, m.role, m.storePurpose, m.storePerson])]);
export const storeSpeechKey = (d: Pick<VideoDraft, "narration" | "voice">, model: string) => JSON.stringify([d.narration.trim(), d.voice, model]);
export const storeSubtitleSource = (d: VideoDraft) => (d.storeAudioMode === "narration" ? d.speech?.storageKey || d.speech?.url || "" : d.storeAudioMode === "mute" ? "" : d.video?.storageKey || d.video?.url || "");

export function storePlanError(shots: StoreShot[], mediaIds: string[], duration: number) {
    if (!shots.length) return "";
    let end = 0;
    const ids = new Set<string>();
    for (const [i, shot] of shots.entries()) {
        if (!shot.id || ids.has(shot.id)) return "镜头编号重复或缺失";
        ids.add(shot.id);
        if (!Number.isFinite(shot.start) || !Number.isFinite(shot.end) || Math.abs(shot.start - end) > 0.001 || shot.end <= shot.start) return `镜头 ${i + 1} 的时间应连续且结束晚于开始`;
        if (!shot.visual.trim()) return `请填写镜头 ${i + 1} 的画面`;
        if (shot.materialIds.some((id) => !mediaIds.includes(id))) return `镜头 ${i + 1} 引用了已移除的素材，请重新选择`;
        end = shot.end;
    }
    return Math.abs(end - duration) > 0.001 ? `方案共 ${end} 秒，与当前 ${duration} 秒不一致，请调整镜头时间或重新编写` : "";
}

export function parseStoreShots(raw: string, d: VideoDraft, seconds: number, selectedIds?: string[]) {
    let value: unknown;
    try {
        value = JSON.parse(
            raw
                .trim()
                .replace(/^```(?:json)?\s*/i, "")
                .replace(/\s*```$/, ""),
        );
    } catch {
        throw new Error("模型未返回有效分镜，原稿已保留，请重新编写或手动编辑");
    }
    const list = (value as { shots?: unknown })?.shots;
    if (!Array.isArray(list) || !list.length) throw new Error("模型未返回镜头列表，原稿已保留");
    const allowed = new Set(d.media.filter((m) => m.kind === "image").map((m) => m.id));
    const shots = list.map((s: unknown): StoreShot => {
        if (!s || typeof s !== "object") throw new Error("镜头格式不正确");
        const row = s as Record<string, unknown>;
        if (
            typeof row.id !== "string" ||
            typeof row.start !== "number" ||
            typeof row.end !== "number" ||
            typeof row.visual !== "string" ||
            typeof row.dialogue !== "string" ||
            !Array.isArray(row.materialIds) ||
            row.materialIds.some((id) => typeof id !== "string" || !allowed.has(id))
        )
            throw new Error("镜头字段或素材引用不正确，原稿已保留");
        return { id: row.id, start: row.start, end: row.end, materialIds: [...new Set(row.materialIds as string[])], visual: row.visual, dialogue: row.dialogue, ...(typeof row.referenceNeed === "string" && row.referenceNeed.trim() ? { referenceNeed: row.referenceNeed.trim() } : {}) };
    });
    let merged = shots;
    if (selectedIds) {
        if (!d.storeShots?.length || shots.length !== selectedIds.length || shots.some((s) => !selectedIds.includes(s.id)) || new Set(shots.map((s) => s.id)).size !== shots.length) throw new Error("局部修改超出选定范围，未覆盖原稿");
        if (shots.some((s) => {
            const original = d.storeShots!.find((row) => row.id === s.id)!;
            return s.start !== original.start || s.end !== original.end;
        })) throw new Error("局部修改改变了原时间，未覆盖原稿");
        merged = d.storeShots.map((s) => shots.find((next) => next.id === s.id) || s);
    }
    const error = storePlanError(merged, [...allowed], seconds);
    if (error) throw new Error(error);
    return merged;
}

export function renderStoreShots(shots: StoreShot[], d: Pick<VideoDraft, "media">) {
    return shots.map((s, i) => `${i + 1}. ${s.start}–${s.end}秒\n画面：${s.visual}\n素材：${s.materialIds.map((id) => d.media.find((m) => m.id === id)?.name || "已移除素材").join("、") || "无"}${s.dialogue ? `\n台词：${s.dialogue}` : ""}${s.referenceNeed ? `\n待补素材：${s.referenceNeed}` : ""}`).join("\n\n");
}

export function storeCaptionError(d: VideoDraft, duration: number) {
    if (!d.addSubtitles) return "";
    let end = 0;
    for (const [i, s] of d.subtitles.entries()) {
        if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < end || s.end <= s.start || s.end > duration || !s.text.trim()) return `字幕 ${i + 1} 的时间或文字无效，请检查顺序、重叠和视频时长`;
        end = s.end;
    }
    if (d.addSubtitles && !d.subtitles.length) return "请先识别或添加字幕";
    if (d.storeSubtitleSource !== storeSubtitleSource(d)) return "声音来源已变化，请重新识别字幕或手动核对并确认时间轴";
    return "";
}

export function storeExploreInput(d: VideoDraft, config: AiConfig): StoreExploreInput {
    const {
        media,
        storeFacts,
        instructions,
        analysis,
        script,
        storeFirstFrameId,
        storeLastFrameId,
        storeSettings,
        storeShots,
        storeReferenceIds,
        storeAudioMode,
        narration,
        speech,
        storeSpeechKey: speechKey,
        voice,
        video,
        final,
        storeAdoptedVideoId,
        subtitles,
        storeSubtitleSource: subtitleSource,
        addSubtitles,
        musicVolume,
        subtitleSize,
        subtitleColor,
        storeSubtitleBottom,
    } = d;
    return {
        media,
        storeFacts,
        instructions,
        analysis,
        script,
        storeFirstFrameId,
        storeLastFrameId,
        storeSettings,
        storeShots,
        storeReferenceIds,
        storeAudioMode,
        narration,
        speech,
        storeSpeechKey: speechKey,
        voice,
        video,
        final,
        storeAdoptedVideoId,
        subtitles,
        storeSubtitleSource: subtitleSource,
        addSubtitles,
        musicVolume,
        subtitleSize,
        subtitleColor,
        storeSubtitleBottom,
        channelMode: config.channelMode,
        baseUrl: config.baseUrl,
    };
}
