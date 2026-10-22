import { useState } from "react";
import { Button, Input, Tooltip, Typography } from "antd";
import { Check, LoaderCircle, Maximize2, Minimize2, RefreshCw, Sparkles, Square, Undo2, X } from "lucide-react";

import { ModelPicker } from "@/components/model-picker";
import type { PromptEnhancementState } from "@/hooks/use-prompt-enhancement";
import { useConfigStore } from "@/stores/use-config-store";

export function PromptEnhancementButton({ state, disabled, undoOnly }: { state: PromptEnhancementState; disabled?: boolean; undoOnly?: boolean }) {
    return (
        <div className="inline-flex shrink-0 items-center">
            {!undoOnly && <Tooltip title={state.running ? "停止增强" : "增强提示词"} styles={{ root: { pointerEvents: "none" } }}>
                <Button type="text" shape="circle" aria-label={state.running ? "停止增强" : "增强提示词"} disabled={disabled && !state.running} style={{ color: "inherit" }}
                    icon={state.running ? <Square className="size-4" /> : <Sparkles className="size-4" />}
                    onClick={() => state.running ? state.stop() : void state.start()} />
            </Tooltip>}
            {state.canUndo && <Tooltip title="撤销增强" styles={{ root: { pointerEvents: "none" } }}><Button type="text" shape="circle" aria-label="撤销增强" style={{ color: "inherit" }} icon={<Undo2 className="size-4" />} onClick={state.undo} /></Tooltip>}
        </div>
    );
}

export function PromptEnhancementPreview({ state }: { state: PromptEnhancementState }) {
    const [expanded, setExpanded] = useState(false);
    const openConfigDialog = useConfigStore((store) => store.openConfigDialog);
    if (!state.preview) return null;
    return (
        <div data-canvas-no-zoom className="mt-2 min-w-0 space-y-2 border-t border-border pt-2" onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span role="status" className="flex items-center gap-1.5 text-xs">
                    {state.running && <LoaderCircle className="size-3.5 animate-spin" />}
                    {state.running ? "正在增强…" : "增强预览"}
                </span>
                <div className="flex min-w-0 items-center gap-1">
                    <Tooltip title="增强用文字模型" styles={{ root: { pointerEvents: "none" } }}><div className="min-w-0"><ModelPicker config={state.config} value={state.model} onChange={state.setModel} capability="text" className="!min-w-0 max-w-[190px]" onMissingConfig={() => openConfigDialog(true, "channels")} /></div></Tooltip>
                    <Tooltip title={expanded ? "收起预览" : "展开预览"} styles={{ root: { pointerEvents: "none" } }}><Button type="text" size="small" aria-label={expanded ? "收起预览" : "展开预览"} icon={expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />} onClick={() => setExpanded(!expanded)} /></Tooltip>
                </div>
            </div>
            {(state.preview.text || state.preview.complete) && <Input.TextArea aria-label="增强提示词预览" readOnly={!state.canEdit} value={state.preview.text} onChange={(event) => state.editPreview(event.target.value)} autoSize={{ minRows: 2, maxRows: expanded ? 14 : 6 }} className="thin-scrollbar" />}
            {state.stale ? <Typography.Text type="warning" role="alert">输入或上下文已变化，请重新增强。</Typography.Text> : state.preview.error && <Typography.Text type="danger" role="alert">{state.preview.error}</Typography.Text>}
            <div className="flex flex-wrap items-center justify-end gap-1">
                {state.running
                    ? <Button size="small" type="text" icon={<Square className="size-3.5" />} onClick={state.stop}>停止</Button>
                    : <Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} onClick={() => void state.start()}>重新增强</Button>}
                <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={state.cancel}>取消</Button>
                <Button size="small" type="primary" icon={<Check className="size-3.5" />} disabled={!state.canApply} onClick={state.apply}>应用</Button>
            </div>
        </div>
    );
}
