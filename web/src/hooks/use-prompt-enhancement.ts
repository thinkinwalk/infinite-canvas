import { useLayoutEffect, useRef, useState } from "react";

import { requestPromptEnhancement, type PromptEnhancementInput } from "@/services/api/prompt-enhancement";
import { publicServiceText } from "@/services/api/replicate";
import { selectableModelsByCapability, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useTextModelConfirmation } from "./use-text-model-confirmation";

type Options = PromptEnhancementInput & {
    contextKey: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    validate?: (value: string) => string;
};
type Preview = { key: string; text: string; error: string; complete: boolean; stale: boolean };

export function usePromptEnhancement(options: Options) {
    const effectiveConfig = useEffectiveConfig();
    const token = useUserStore((state) => state.token);
    const confirmTextModel = useTextModelConfirmation();
    const [selectedModel, setSelectedModel] = useState("");
    const models = selectableModelsByCapability(effectiveConfig, "text");
    const model = models.includes(selectedModel) ? selectedModel : effectiveConfig.textModel;
    const config = { ...effectiveConfig, textModel: model };
    const [preview, setPreview] = useState<Preview | null>(null);
    const [running, setRunning] = useState(false);
    const [undo, setUndo] = useState<{ original: string; applied: string; scope: string } | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const scope = JSON.stringify([options.contextKey, options.scenario, options.references, options.parameters, effectiveConfig, model, token, Boolean(options.disabled)]);
    const key = JSON.stringify([scope, options.prompt]);
    const latest = useRef({ options, key, scope });
    latest.current = { options, key, scope };

    const stop = () => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setRunning(false);
        setPreview((value) => value && !value.complete ? { ...value, error: "已停止增强，可重新增强。", complete: false } : value);
    };
    useLayoutEffect(() => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setRunning(false);
        setPreview((value) => value && value.key !== key ? { ...value, stale: true } : value);
        setUndo((value) => value && (value.scope !== scope || value.applied !== options.prompt) ? null : value);
    }, [key]);
    useLayoutEffect(() => () => { controllerRef.current?.abort(); }, []);

    const start = async () => {
        const snapshot = latest.current;
        if (controllerRef.current || snapshot.options.disabled || !snapshot.options.prompt.trim()) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        setRunning(true);
        setPreview({ key: snapshot.key, text: "", error: "", complete: false, stale: false });
        const current = () => controllerRef.current === controller && !controller.signal.aborted && latest.current.key === snapshot.key;
        try {
            const inputError = snapshot.options.validate?.(snapshot.options.prompt);
            if (inputError) throw new Error(inputError);
            await confirmTextModel(config, controller.signal);
            if (!current()) return;
            const answer = await requestPromptEnhancement(config, snapshot.options, (text) => {
                if (current()) setPreview({ key: snapshot.key, text, error: "", complete: false, stale: false });
            }, { signal: controller.signal });
            if (!current()) return;
            const error = snapshot.options.validate?.(answer) || "";
            setPreview({ key: snapshot.key, text: answer, error, complete: !error, stale: false });
        } catch (error) {
            if (current()) setPreview((value) => value && {
                ...value, complete: false,
                error: error instanceof Error && error.name === "AbortError" ? "已取消增强。" : publicServiceText(error instanceof Error ? error.message : "增强失败，请重试。"),
            });
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null;
                setRunning(false);
            }
        }
    };
    const canApply = Boolean(preview?.complete && !preview.stale && preview.key === key && !running && !options.disabled);
    return {
        preview, running, config, model, setModel: setSelectedModel,
        stale: Boolean(preview && (preview.stale || preview.key !== key)),
        canApply,
        canUndo: Boolean(undo && undo.applied === options.prompt && undo.scope === scope && !options.disabled && !running),
        start, stop,
        cancel: () => { stop(); setPreview(null); },
        apply: () => {
            if (!canApply || !preview || preview.key !== latest.current.key || latest.current.options.disabled) return;
            const snapshot = latest.current;
            const error = snapshot.options.validate?.(preview.text);
            if (error) { setPreview({ ...preview, error, complete: false }); return; }
            setUndo({ original: snapshot.options.prompt, applied: preview.text, scope: snapshot.scope });
            setPreview(null);
            snapshot.options.onChange(preview.text);
        },
        undo: () => {
            if (!undo || controllerRef.current || undo.scope !== latest.current.scope || undo.applied !== latest.current.options.prompt || latest.current.options.disabled) return;
            latest.current.options.onChange(undo.original);
            setUndo(null);
            setPreview(null);
        },
    };
}

export type PromptEnhancementState = ReturnType<typeof usePromptEnhancement>;
