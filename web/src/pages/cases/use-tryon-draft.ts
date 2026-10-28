import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import localforage from "localforage";
import { useUserStore } from "@/stores/use-user-store";
import { readTryonDraft, type TryonDraft, type TryonPose, type TryonResult, type TryonValues } from "./tryon-state";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "tryon_workbench" });

export function useTryonDraft(enabled: boolean, values: TryonValues, setValues: Dispatch<SetStateAction<TryonValues>>, result: TryonResult | null, setResult: Dispatch<SetStateAction<TryonResult | null>>) {
    const userId = useUserStore((state) => state.user?.id);
    const token = useUserStore((state) => state.token);
    const key = token && !userId ? "" : `tryon-v1:${userId || "guest"}`;
    const [loadedKey, setLoadedKey] = useState("");
    const [error, setError] = useState("");
    const [poses, setPoses] = useState<TryonPose[]>([]);
    const [reload, setReload] = useState(0);
    const [saveRetry, setSaveRetry] = useState(0);
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    useEffect(() => {
        let active = true;
        setLoadedKey("");
        if (!enabled || !key) return;
        setError("");
        void queue.current.then(() => storage.getItem<unknown>(key)).then((value) => {
            if (!active) return;
            const draft = readTryonDraft(value);
            setValues(draft.values);
            setResult(draft.result);
            setPoses(draft.poses);
            setLoadedKey(key);
        }).catch((cause) => {
            if (active) setError(cause instanceof Error && cause.message.includes("格式异常") ? cause.message : "本机试衣草稿读取失败，已暂停编辑以保留原数据");
        });
        return () => { active = false; };
    }, [enabled, key, reload, setValues, setResult]);
    useEffect(() => {
        if (!enabled || !key || loadedKey !== key) return;
        let active = true;
        const draft: TryonDraft = { values, result, poses };
        queue.current = queue.current.catch(() => undefined).then(() => storage.setItem(key, draft)).then(() => {
            if (active) setError("");
        }).catch(() => {
            if (active) setError("本机保存失败，请保留当前页面并下载结果后重试");
        });
        return () => { active = false; };
    }, [enabled, key, loadedKey, values, result, poses, saveRetry]);
    const ready = Boolean(key) && loadedKey === key;
    return { ready, error, poses, setPoses, retry: () => ready ? setSaveRetry((value) => value + 1) : setReload((value) => value + 1) };
}
