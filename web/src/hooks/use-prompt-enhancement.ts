import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { promptEnhancementConfigKey, requestPromptEnhancement, resolvePromptEnhancementModel, validatePromptEnhancement, type PromptEnhancementInput } from "@/services/api/prompt-enhancement";
import { publicServiceText } from "@/services/api/replicate";
import { modelOptionLabel, modelOptionName, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { useTextModelConfirmation } from "./use-text-model-confirmation";

type Options = PromptEnhancementInput & {
    contextKey: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    validate?: (value: string) => string;
};

export function usePromptEnhancement(options: Options) {
    const effective = useEffectiveConfig("prompt.enhance");
    const selectionKey = effective.channelMode === "local" ? "local:prompt.enhance" : "prompt.enhance";
    const selection = useConfigStore((state) => state.featureModels[selectionKey] || "");
    const hasCatalog = useConfigStore((state) => Boolean(state.publicSettings));
    const { config, models, selectedModel, selectionUnavailable } = useMemo(() => resolvePromptEnhancementModel(effective, selection), [effective, selection]);
    const [modelNotice, setModelNotice] = useState("");
    const modelLabel = config.textModel ? modelOptionLabel(config, config.textModel) : "";
    const unavailableReason = !config.textModel ? config.channelMode === "remote"
        ? "平台暂无可用的增强模型，请联系管理员配置。" : "暂无可用的增强模型，请先配置文字模型及渠道。" : "";
    const token = useUserStore((state) => state.token);
    const group = useUserStore((state) => state.user?.group);
    const confirmTextModel = useTextModelConfirmation();
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");
    const [undo, setUndo] = useState<{ original: string; scope: string } | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const scope = JSON.stringify([options.contextKey, options.scenario, options.references, promptEnhancementConfigKey(config), config.managed?.revision, token, group, Boolean(options.disabled)]);
    const key = JSON.stringify([scope, options.prompt]);
    const latest = useRef({ options, key, scope, config });
    latest.current = { options, key, scope, config };

    useEffect(() => {
        if (!selectionUnavailable || effective.channelMode === "remote" && !hasCatalog) return;
        useConfigStore.setState((state) => {
            if (state.featureModels[selectionKey] !== selection) return state;
            const featureModels = { ...state.featureModels };
            delete featureModels[selectionKey];
            return { featureModels };
        });
        setModelNotice("此前选择的增强模型已不可用，已恢复跟随默认模型。");
    }, [selectionUnavailable, selectionKey, selection, effective.channelMode, hasCatalog]);

    const selectModel = (value: string) => {
        if (controllerRef.current || latest.current.options.disabled || value && !models.includes(value)) return;
        useConfigStore.setState((state) => {
            const featureModels = { ...state.featureModels };
            if (value) featureModels[selectionKey] = value;
            else delete featureModels[selectionKey];
            return { featureModels };
        });
        setModelNotice("");
        setError("");
    };
    const cancel = () => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setRunning(false);
        setError("");
    };
    const stop = () => {
        cancel();
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
        config, modelLabel, modelNotice, unavailableReason, selectedModel,
        defaultLabel: config.channelMode === "remote" ? "跟随平台默认" : "跟随渠道默认",
        modelOptions: models.map((value) => {
            const binding = config.channelMode === "remote" ? config.managed?.bindings.find((item) => item.modelId === modelOptionName(value) && item.available) : undefined;
            return { value, label: modelOptionLabel(config, value), default: Boolean(binding?.default) };
        }),
        selectModel,
        configure: () => useConfigStore.getState().openConfigDialog(false, "channels"),
        canConfigure: config.channelMode === "local",
        modelSelectionDisabled: running || Boolean(options.disabled),
        canUndo: Boolean(undo && undo.scope === scope && !options.disabled && !running),
        start, stop, cancel,
        undo: () => {
            if (!undo || controllerRef.current || undo.scope !== latest.current.scope || latest.current.options.disabled) return;
            latest.current.options.onChange(undo.original);
            setUndo(null);
            setError("");
        },
    };
}

export type PromptEnhancementState = ReturnType<typeof usePromptEnhancement>;
