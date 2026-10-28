import { useEffect, useState } from "react";
import { Button, Dropdown, Tooltip, Typography } from "antd";
import { Check, ChevronDown, Info, LoaderCircle, Sparkles, Square, Undo2 } from "lucide-react";

import type { PromptEnhancementState } from "@/hooks/use-prompt-enhancement";
import { quoteTextModel } from "@/services/api/video";
import { useUserStore } from "@/stores/use-user-store";

export function PromptEnhancementButton({ state, disabled, undoOnly }: { state: PromptEnhancementState; disabled?: boolean; undoOnly?: boolean }) {
    const token = useUserStore((store) => store.token);
    const group = useUserStore((store) => store.user?.group);
    const [open, setOpen] = useState(false);
    const [quotes, setQuotes] = useState<{ config: typeof state.config; token: string; group?: string; values: Record<string, number | null> }>();
    const showMenu = state.modelOptions.length > 1 || !state.modelOptions.length && state.canConfigure;
    const menuOpen = open && showMenu && !undoOnly && !state.modelSelectionDisabled;
    useEffect(() => {
        if (state.modelSelectionDisabled || !showMenu) setOpen(false);
    }, [state.modelSelectionDisabled, showMenu]);
    useEffect(() => {
        if (!menuOpen || state.config.channelMode !== "remote" || !token) return;
        const controller = new AbortController();
        const config = state.config;
        setQuotes({ config, token, group, values: {} });
        void Promise.all(state.modelOptions.map(async (item) => {
            let credits: number | null = null;
            try { credits = (await quoteTextModel(config, item.value, controller.signal)).credits; }
            catch { /* A failed quote must not hide a selectable model. */ }
            if (!controller.signal.aborted) setQuotes((current) => current?.config === config && current.token === token && current.group === group
                ? { ...current, values: { ...current.values, [item.value]: credits } } : current);
        }));
        return () => controller.abort();
    }, [menuOpen, state.config, token, group]);
    const priceLabel = (value: string) => {
        if (state.config.channelMode === "local") return "渠道计费";
        if (!token) return "登录后查看费用";
        const credits = quotes?.config === state.config && quotes.token === token && quotes.group === group ? quotes.values[value] : undefined;
        return credits === undefined ? "读取报价…" : credits === null ? "报价暂不可用" : credits === 0 ? "免费" : `${credits} 点/次`;
    };
    const title = state.running ? "停止增强" : state.unavailableReason || `增强提示词 · ${state.modelLabel}`;
    const menuItems = [
        { key: "", label: state.defaultLabel, icon: !state.selectedModel ? <Check className="size-3.5" /> : <span className="size-3.5" /> },
        ...state.modelOptions.map((item) => ({
            key: item.value,
            label: <span className="flex min-w-0 items-center justify-between gap-3"><span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{item.label}{item.default ? " · 默认" : ""}</span><span className="shrink-0 text-xs text-muted-foreground">{priceLabel(item.value)}</span></span>,
            icon: state.selectedModel === item.value ? <Check className="size-3.5" /> : <span className="size-3.5" />,
        })),
        ...(state.canConfigure ? [{ key: "__configure__", label: "配置文字模型与渠道" }] : []),
    ];
    return (
        <div className="inline-flex max-w-full flex-wrap items-center gap-1">
            {state.running && <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在增强…</span>}
            {!undoOnly && <Tooltip title={title} styles={{ root: { pointerEvents: "none" } }}>
                <span className="inline-flex"><Button type="text" shape="circle" aria-label={state.running ? "停止增强" : "增强提示词"} disabled={Boolean(disabled || state.unavailableReason) && !state.running} style={{ color: "inherit" }}
                    icon={state.running ? <Square className="size-4" /> : <Sparkles className="size-4" />}
                    onClick={() => state.running ? state.stop() : void state.start()} /></span>
            </Tooltip>}
            {!undoOnly && showMenu && <Dropdown trigger={["click"]} disabled={state.modelSelectionDisabled} placement="bottomRight"
                open={menuOpen} onOpenChange={setOpen}
                styles={{ root: { maxWidth: "min(360px, calc(100vw - 24px))" } }}
                menu={{ items: menuItems, selectable: true, selectedKeys: [state.selectedModel || ""], onClick: ({ key }) => { setOpen(false); if (key === "__configure__") state.configure(); else state.selectModel(key); } }}>
                <Button type="text" shape="circle" aria-label="选择增强模型" title={`增强模型 · ${state.modelLabel || "未配置"}`} disabled={state.modelSelectionDisabled} style={{ color: "inherit" }} icon={<ChevronDown className="size-3.5" />} />
            </Dropdown>}
            {state.canUndo && <Tooltip title="撤回提示词增强" styles={{ root: { pointerEvents: "none" } }}><Button type="text" shape="circle" aria-label="撤回提示词增强" style={{ color: "inherit" }} icon={<Undo2 className="size-4" />} onClick={state.undo} /></Tooltip>}
            {state.error && <Typography.Text type="danger" role="alert" className="max-w-48 text-xs">{state.error}</Typography.Text>}
            {!undoOnly && state.unavailableReason && <Typography.Text type="secondary" role="status" className="max-w-48 text-xs">{state.unavailableReason}</Typography.Text>}
            {!undoOnly && state.modelNotice && <Tooltip title={state.modelNotice}><span role="status" aria-label={state.modelNotice}><Info className="size-3.5 text-muted-foreground" /></span></Tooltip>}
        </div>
    );
}
