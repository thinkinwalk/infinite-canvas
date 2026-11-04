import { Button, Input } from "antd";
import { Send, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { TaskConversation } from "@/types/video-workbench";
import { taskConversationPlanText } from "./task-conversation";

export function TaskConversationPanel({
    conversation,
    input,
    onInput,
    onSend,
    onPlan,
    onConfirm,
    onApply,
    onDiscard,
    locked,
    busy,
    context,
    muted,
    border,
    children,
}: {
    conversation?: TaskConversation;
    input: string;
    onInput: (value: string) => void;
    onSend: () => void;
    onPlan: () => void;
    onConfirm: () => void;
    onApply?: () => void;
    onDiscard?: () => void;
    locked: boolean;
    busy: boolean;
    context: string;
    muted: CSSProperties;
    border: CSSProperties;
    children?: ReactNode;
}) {
    const phase = conversation?.phase || "discussion";
    return (
        <section className="space-y-3 border-t pt-4" style={border} aria-label="多轮对话改编">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm font-medium">对话改编</strong>
                <span className="text-xs" style={muted}>{phase === "proposal" ? "修改方案待确认" : phase === "candidate" ? "修改候选已生成" : "讨论中，正式内容尚未修改"}</span>
            </div>
            <p className="text-xs" style={muted}>{context}</p>
            <div className="max-h-72 min-h-16 space-y-3 overflow-y-auto" role="log" aria-label="改编对话记录" aria-live="polite">
                {!conversation?.messages.length && <p className="text-sm" style={muted}>先描述你发现的问题或想调整的方向。这里会先讨论并确认方案，不会直接修改正式内容。</p>}
                {conversation?.messages.map((message) => (
                    <div key={message.id} className="space-y-1 text-sm [overflow-wrap:anywhere]">
                        <span className="text-xs" style={muted}>{message.role === "user" ? "你" : "助手"}</span>
                        <p className="whitespace-pre-wrap">{message.text}</p>
                    </div>
                ))}
            </div>
            {conversation?.plan && (
                <div className="space-y-2 border-l-2 pl-3" style={{ borderColor: "var(--ant-color-primary)" }} aria-label="修改方案">
                    <strong className="text-sm">修改方案</strong>
                    <p className="whitespace-pre-wrap text-sm">{taskConversationPlanText(conversation.plan)}</p>
                </div>
            )}
            {children}
            <Input.TextArea
                aria-label="本轮对话内容"
                value={input}
                disabled={locked}
                autoSize={{ minRows: 2, maxRows: 6 }}
                placeholder={phase === "candidate" ? "继续讨论候选怎么调整" : "补充问题、偏好或需要保留的内容"}
                onChange={(event) => onInput(event.target.value)}
                onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); onSend(); } }}
            />
            <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Send size={14} />} loading={busy} disabled={locked || !input.trim()} onClick={onSend}>
                    {conversation?.messages.length ? "继续讨论" : "开始讨论"}
                </Button>
                {phase === "proposal" ? (
                    <Button type="primary" icon={<Sparkles size={14} />} loading={busy} disabled={locked || Boolean(input.trim())} onClick={onConfirm}>确认方案并生成修改预览</Button>
                ) : phase === "candidate" ? (
                    <>
                        {onApply && <Button type="primary" loading={busy} disabled={locked} onClick={onApply}>应用修改</Button>}
                        {onDiscard && <Button loading={busy} disabled={locked} onClick={onDiscard}>不应用修改</Button>}
                    </>
                ) : (
                    <Button icon={<Sparkles size={14} />} loading={busy} disabled={locked || !conversation?.messages.some((message) => message.role === "user")} onClick={onPlan}>整理修改方案</Button>
                )}
            </div>
        </section>
    );
}
