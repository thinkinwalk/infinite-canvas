import { useUserStore } from "@/stores/use-user-store";

export type SavedVoice = {
    voice_id: string;
    name: string;
    reference_text: string;
    language: string;
    version: string;
    mime_type: string;
    bytes: number;
    duration_seconds: number;
    created_at: string;
    updated_at: string;
    disabled_at?: string;
};

function authHeaders() {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后保存音色");
    return { Authorization: `Bearer ${token}` };
}

async function readError(response: Response) {
    const payload = await response.json().catch(() => null);
    return typeof payload?.msg === "string" ? payload.msg : typeof payload?.error?.message === "string" ? payload.error.message : `音色接口请求失败（${response.status}）`;
}

export async function saveVoiceReference(input: { name: string; referenceText: string; language: string; file: Blob; filename?: string; signal?: AbortSignal }): Promise<SavedVoice> {
    const form = new FormData();
    form.append("name", input.name);
    form.append("reference_text", input.referenceText);
    form.append("language", input.language);
    form.append("file", input.file, input.filename || "voice-reference.wav");
    const response = await fetch("/api/v1/voices", { method: "POST", headers: authHeaders(), body: form, signal: input.signal });
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json().catch(() => null);
    if (!payload || payload.code !== 0 || !payload.data) throw new Error(payload?.msg || "保存音色失败");
    return payload.data as SavedVoice;
}
