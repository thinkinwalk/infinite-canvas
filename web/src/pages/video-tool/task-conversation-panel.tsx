import { Button, Input } from "antd";
import { Send, Sparkles } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { TaskConversation } from "@/types/video-workbench";
import { taskConversationPlanText, type TaskConversationQuote } from "./task-conversation";

type ConversationAction = "message" | "plan" | "candidate";

export function TaskConversationPanel({
    conversation,
    input,
    onInput,
    onSend,
    onPlan,
    onConfirm,
    onApply,
    onDiscard,
    prepareQuote,
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
    onSend: (approvedQuote?: TaskConversationQuote) => void;
    onPlan: (approvedQuote?: TaskConversationQuote) => void;
    onConfirm: (approvedQuote?: TaskConversationQuote) => void;
    onApply?: () => void;
    onDiscard?: () => void;
    prepareQuote?: (action: ConversationAction) => Promise<TaskConversationQuote | null>;
    locked: boolean;
    busy: boolean;
    context: string;
    muted: CSSProperties;
    border: CSSProperties;
    children?: ReactNode;
}) {
    const phase = conversation?.phase || "discussion";
    const [pendingQuote, setPendingQuote] = useState<{ action: ConversationAction; key: string; quote: TaskConversationQuote; changed?: boolean }>();
    const [quoting, setQuoting] = useState(false);
    const [quoteError, setQuoteError] = useState("");
    const actionKey = (action: ConversationAction) => JSON.stringify([action, context, input, conversation?.messages, conversation?.plan]);
    const currentQuote = pendingQuote && pendingQuote.key === actionKey(pendingQuote.action) ? pendingQuote : undefined;
    const execute = (action: ConversationAction, approvedQuote?: TaskConversationQuote) => {
        if (action === "message") onSend(approvedQuote);
        else if (action === "plan") onPlan(approvedQuote);
        else onConfirm(approvedQuote);
    };
    const requestAction = async (action: ConversationAction) => {
        if (locked || busy || quoting) return;
        setQuoteError("");
        if (!prepareQuote) return execute(action);
        setQuoting(true);
        try {
            const quote = await prepareQuote(action);
            if (!quote) {
                setPendingQuote(undefined);
                execute(action);
            } else if (currentQuote?.action === action) {
                if (quote.credits !== currentQuote.quote.credits || quote.calculation !== currentQuote.quote.calculation || quote.details !== currentQuote.quote.details) {
                    setPendingQuote({ action, key: actionKey(action), quote, changed: true });
                } else {
                    setPendingQuote(undefined);
                    execute(action, quote);
                }
            } else {
                setPendingQuote({ action, key: actionKey(action), quote });
            }
        } catch (error) {
            setQuoteError(error instanceof Error ? error.message : "暂时无法读取本次费用");
        } finally {
            setQuoting(false);
        }
    };
    const actionLabel = currentQuote?.action === "message" ? "本轮对话" : currentQuote?.action === "plan" ? "整理修改方案" : "生成修改候选";
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
                onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void requestAction("message"); } }}
            />
            <div className="flex flex-wrap items-center gap-2">
                <Button icon={<Send size={14} />} loading={busy || quoting} disabled={locked || !input.trim() || quoting} onClick={() => void requestAction("message")}>
                    {prepareQuote ? "开始讨论 · 查看费用" : conversation?.messages.length ? "继续讨论" : "开始讨论"}
                </Button>
                {phase === "proposal" ? (
                    <Button type="primary" icon={<Sparkles size={14} />} loading={busy || quoting} disabled={locked || Boolean(input.trim()) || quoting} onClick={() => void requestAction("candidate")}>{prepareQuote ? "生成候选 · 查看费用" : "确认方案并生成修改预览"}</Button>
                ) : phase === "candidate" ? (
                    <>
                        {onApply && <Button type="primary" loading={busy} disabled={locked} onClick={onApply}>应用修改</Button>}
                        {onDiscard && <Button loading={busy} disabled={locked} onClick={onDiscard}>不应用修改</Button>}
                    </>
                ) : (
                    <Button icon={<Sparkles size={14} />} loading={busy || quoting} disabled={locked || !conversation?.messages.some((message) => message.role === "user") || quoting} onClick={() => void requestAction("plan")}>{prepareQuote ? "整理方案 · 查看费用" : "整理修改方案"}</Button>
                )}
            </div>
            {quoteError && <p className="text-xs text-red-600" role="alert">{quoteError}</p>}
            {currentQuote && (
                <div className="space-y-2 border p-3 text-sm" aria-label="文案费用确认">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <strong>{actionLabel} · {currentQuote.quote.credits.toLocaleString()} 算力点</strong>
                        <span className="text-xs" style={muted}>{currentQuote.quote.calculation}</span>
                    </div>
                    <p className="m-0 text-xs" style={muted}>{currentQuote.quote.details}</p>
                    {currentQuote.changed && <p className="m-0 text-xs text-amber-600">费用或处理范围已变化，请核对后再次确认；当前还没有发送请求。</p>}
                    <div className="flex gap-2">
                        <Button type="primary" size="small" loading={quoting} disabled={locked} onClick={() => void requestAction(currentQuote.action)}>确认费用并继续</Button>
                        <Button size="small" disabled={quoting} onClick={() => setPendingQuote(undefined)}>取消</Button>
                    </div>
                </div>
            )}
        </section>
    );
}
