import { Button, Tooltip, Typography } from "antd";
import { LoaderCircle, Sparkles, Square, Undo2 } from "lucide-react";

import type { PromptEnhancementState } from "@/hooks/use-prompt-enhancement";

export function PromptEnhancementButton({ state, disabled, undoOnly }: { state: PromptEnhancementState; disabled?: boolean; undoOnly?: boolean }) {
    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {state.running && <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在增强…</span>}
            {!undoOnly && <Tooltip title={state.running ? "停止增强" : "增强提示词"} styles={{ root: { pointerEvents: "none" } }}>
                <Button type="text" shape="circle" aria-label={state.running ? "停止增强" : "增强提示词"} disabled={disabled && !state.running} style={{ color: "inherit" }}
                    icon={state.running ? <Square className="size-4" /> : <Sparkles className="size-4" />}
                    onClick={() => state.running ? state.stop() : void state.start()} />
            </Tooltip>}
            {state.canUndo && <Tooltip title="撤回提示词增强" styles={{ root: { pointerEvents: "none" } }}><Button type="text" shape="circle" aria-label="撤回提示词增强" style={{ color: "inherit" }} icon={<Undo2 className="size-4" />} onClick={state.undo} /></Tooltip>}
            {state.error && <Typography.Text type="danger" role="alert" className="max-w-48 text-xs">{state.error}</Typography.Text>}
        </div>
    );
}
