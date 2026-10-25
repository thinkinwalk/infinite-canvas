import { useLayoutEffect, useRef, useState } from "react";

import { promptEnhancementConfigKey, requestPromptEnhancement, validatePromptEnhancement, type PromptEnhancementInput } from "@/services/api/prompt-enhancement";
import { publicServiceText } from "@/services/api/replicate";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useTextModelConfirmation } from "./use-text-model-confirmation";

type Options = PromptEnhancementInput & {
    contextKey: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    validate?: (value: string) => string;
};

export function usePromptEnhancement(options: Options) {
    const config = useEffectiveConfig("prompt.enhance");
    const token = useUserStore((state) => state.token);
    const confirmTextModel = useTextModelConfirmation();
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const [undo, setUndo] = useState<{ original: string; scope: string } | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const scope = JSON.stringify([options.contextKey, options.scenario, options.references, promptEnhancementConfigKey(config), token, Boolean(options.disabled)]);
    const key = JSON.stringify([scope, options.prompt]);
    const latest = useRef({ options, key, scope, config });
    latest.current = { options, key, scope, config };

    const stop = () => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setRunning(false);
        setError("已停止增强，可重新增强。");
    };
    useLayoutEffect(() => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setRunning(false);
        setError("");
        setUndo((value) => value && value.scope !== scope ? null : value);
    }, [key]);
    useLayoutEffect(() => () => { controllerRef.current?.abort(); }, []);

    const start = async () => {
        const snapshot = latest.current;
        if (controllerRef.current || snapshot.options.disabled || !snapshot.options.prompt.trim()) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        setRunning(true);
        setError("");
        const current = () => controllerRef.current === controller && !controller.signal.aborted && latest.current.key === snapshot.key;
        try {
            const inputError = snapshot.options.validate?.(snapshot.options.prompt);
            if (inputError) throw new Error(inputError);
            await confirmTextModel(snapshot.config, controller.signal);
            if (!current()) return;
            const answer = await requestPromptEnhancement(snapshot.config, snapshot.options, () => {}, { signal: controller.signal });
            if (!current()) return;
            const validationError = validatePromptEnhancement(snapshot.options, answer) || snapshot.options.validate?.(answer) || "";
            if (validationError) throw new Error(validationError);
            setUndo({ original: snapshot.options.prompt, scope: snapshot.scope });
            snapshot.options.onChange(answer);
        } catch (cause) {
            if (current()) setError(cause instanceof Error && cause.name === "AbortError" ? "已取消增强。" : publicServiceText(cause instanceof Error ? cause.message : "增强失败，请重试。"));
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null;
                setRunning(false);
            }
        }
    };
    return {
        running, error,
        canUndo: Boolean(undo && undo.scope === scope && !options.disabled && !running),
        start, stop,
        undo: () => {
            if (!undo || controllerRef.current || undo.scope !== latest.current.scope || latest.current.options.disabled) return;
            latest.current.options.onChange(undo.original);
            setUndo(null);
            setError("");
        },
    };
}

export type PromptEnhancementState = ReturnType<typeof usePromptEnhancement>;
