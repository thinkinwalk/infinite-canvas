import { App } from "antd";

import { quoteTextModel } from "@/services/api/video";
import { modelMatchesCapability, modelOptionLabel, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function useTextModelConfirmation() {
    const { modal } = App.useApp();
    return async (config: AiConfig, signal: AbortSignal, action = "提示词增强") => {
        signal.throwIfAborted();
        const store = useConfigStore.getState();
        if (!config.textModel || !modelMatchesCapability(config, config.textModel, "text") || !store.isAiConfigReady(config, config.textModel)) {
            if (config.channelMode === "local") store.openConfigDialog(true, "channels");
            throw new Error(config.channelMode === "remote" ? "平台暂无可用的文字模型，请联系管理员配置。" : "请先配置可用的文字模型及渠道。");
        }
        if (config.channelMode !== "remote") return undefined;
        if (!useUserStore.getState().token) throw new Error("请先登录，再使用文字模型。");
        const quote = await quoteTextModel(config, config.textModel, signal);
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
            const finish = (accepted: boolean) => {
                signal.removeEventListener("abort", abort);
                if (accepted && !signal.aborted) resolve();
                else reject(new DOMException("已取消", "AbortError"));
            };
            const dialog = modal.confirm({
                title: `确认${action}费用`,
                content: `${modelOptionLabel(config, config.textModel)}：本次 ${quote.credits} 算力点，与图片、视频生成分开计费。`,
                okText: `确认${action}`,
                cancelText: "取消",
                onOk: () => finish(true),
                onCancel: () => finish(false),
            });
            const abort = () => { dialog.destroy(); finish(false); };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
        });
        signal.throwIfAborted();
        return quote.credits;
    };
}
