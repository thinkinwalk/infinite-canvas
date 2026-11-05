import { Button, Empty, Input, Tag, theme } from "antd";
import { Check, FileClock, MessageSquare, Send, Sparkles, Undo2, X } from "lucide-react";
import { diffArrays } from "diff";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { TaskConversationAdapter, TaskConversationQuote } from "@/types/task-conversation";
import { taskConversationDiffRows, taskConversationPlanText, taskConversationQuoteError } from "@/lib/task-conversation";

export type ConversationAction = "message" | "plan" | "candidate";

export type TaskConversationWorkspaceProps = {
    adapter: TaskConversationAdapter;
    muted: CSSProperties;
    border: CSSProperties;
};

export function TaskConversationContextHeader({ context, muted, right, compact = false }: { context: Partial<TaskConversationAdapter["context"]>; muted: CSSProperties; right?: ReactNode; compact?: boolean }) {
    return <div className="space-y-3">
        <header className="flex shrink-0 items-start justify-between gap-3">
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <MessageSquare size={17} aria-hidden />
                    <h2 className="m-0 text-base font-semibold">{context.taskTitle || "通用任务对话"}</h2>
                </div>
                <p className="mt-1 text-xs" style={muted}>{compact ? [context.business, context.subject, context.description].filter(Boolean).join(" · ") : `${context.business || "当前业务"} · ${context.description || "围绕当前任务讨论"}`}</p>
            </div>
            {right}
        </header>
    </div>;
}

const phaseLabels = { discussion: "讨论需求", proposal: "确认方案", candidate: "预览候选" } as const;

export function TaskConversationWorkspace({ adapter, muted, border }: TaskConversationWorkspaceProps) {
    const { conversation, input, onInput, locked, busy, historySummary, prepareQuote, candidate } = adapter;
    const { token } = theme.useToken();
    const { evidence, evidencePreviews, constraints, description: context } = adapter.context;
    const phase = conversation?.phase || "discussion";
    const comparisonRows = useMemo(() => {
        if (candidate?.currentContent === undefined || candidate.candidateContent === undefined) return [];
        const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
        const words = (text: string) => segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
        return taskConversationDiffRows(candidate.currentContent, candidate.candidateContent).map((row) => ({
            ...row,
            parts: row.changed ? diffArrays(words(row.before), words(row.after)) : [],
        }));
    }, [candidate?.currentContent, candidate?.candidateContent]);
    const [pendingQuote, setPendingQuote] = useState<{ action: ConversationAction; key: string; quote: TaskConversationQuote; changed?: boolean }>();
    const [quoting, setQuoting] = useState(false);
    const [quoteError, setQuoteError] = useState("");
    const actionKey = (action: ConversationAction) => JSON.stringify([action, context, input, conversation?.messages, conversation?.plan]);
    const currentQuote = pendingQuote && pendingQuote.key === actionKey(pendingQuote.action) ? pendingQuote : undefined;
    const execute = (action: ConversationAction, approvedQuote?: TaskConversationQuote) => {
        if (action === "message") void adapter.sendMessage(approvedQuote);
        else if (action === "plan") void adapter.organizePlan(approvedQuote);
        else void adapter.generateCandidate(approvedQuote);
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
                if (quote.credits !== currentQuote.quote.credits || quote.calculation !== currentQuote.quote.calculation || quote.details !== currentQuote.quote.details) setPendingQuote({ action, key: actionKey(action), quote, changed: true });
                else {
                    setPendingQuote(undefined);
                    execute(action, quote);
                }
            } else setPendingQuote({ action, key: actionKey(action), quote });
        } catch (error) {
            setQuoteError(taskConversationQuoteError(error));
        } finally {
            setQuoting(false);
        }
    };
    const actionLabel = currentQuote?.action === "message" ? "本轮讨论" : currentQuote?.action === "plan" ? "整理方案" : "生成候选";
    return (
        <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="通用任务对话工作台">
            <TaskConversationContextHeader context={{ ...adapter.context, description: `${context || "围绕当前任务讨论"} · 只讨论和确认，不会自动覆盖正式内容` }} muted={muted} right={adapter.undo && <Button type="text" size="small" icon={<Undo2 size={15} />} disabled={locked || busy} onClick={adapter.undo}>撤销</Button>} />

            <div className="flex items-center gap-1 overflow-x-auto border-y py-2" style={border} aria-label="对话阶段">
                {(["discussion", "proposal", "candidate"] as const).map((item, index) => <div key={item} className="flex shrink-0 items-center gap-1 text-xs"><Tag color={phase === item ? "blue" : index < (["discussion", "proposal", "candidate"] as const).indexOf(phase) ? "green" : undefined}>{index + 1}. {phaseLabels[item]}</Tag>{index < 2 && <span style={muted}>›</span>}</div>)}
                {phase === "candidate" && <Tag color="gold">待采用</Tag>}
            </div>

            {(evidence || evidencePreviews?.length || constraints?.length) && <div className="space-y-2 border p-3 text-xs" style={border} aria-label="来源与约束">
                <strong>本轮依据与约束</strong>
                {evidence && <p className="m-0 whitespace-pre-wrap" style={muted}>{evidence}</p>}
                {evidencePreviews?.length ? <div className="flex gap-2 overflow-x-auto" aria-label="本轮拟发送的成片取样画面">{evidencePreviews.map((preview) => <figure key={preview.label} className="m-0 w-24 shrink-0"><img src={preview.url} alt={preview.label} className="aspect-video w-full object-contain" /><figcaption className="mt-1 break-words" style={muted}>{preview.label}</figcaption></figure>)}</div> : null}
                {constraints?.map((item) => <p key={item} className="m-0" style={muted}>保留：{item}</p>)}
            </div>}

            <div className="min-h-28 flex-1 space-y-3 overflow-y-auto pr-1" role="log" aria-label="任务对话记录" aria-live="polite">
                {!conversation?.messages.length && <div className="border p-4 text-sm" style={border}><p className="m-0 font-medium">先说清楚你看到的问题</p><p className="mt-1" style={muted}>例如：前三秒重点不明显、人物动作太僵、只改台词不要动镜头。系统会先讨论，再整理方案，最后才生成候选。</p></div>}
                {conversation?.messages.map((message) => <div key={message.id} className={`max-w-[94%] space-y-1 border p-3 text-sm [overflow-wrap:anywhere] ${message.role === "user" ? "ml-auto" : "mr-auto"}`} style={border}><span className="text-xs" style={muted}>{message.role === "user" ? "你" : "助手"}</span><p className="m-0 whitespace-pre-wrap">{message.text}</p></div>)}
            </div>

            {conversation?.plan && <div className="max-h-40 space-y-2 overflow-y-auto border-l-2 pl-3" style={{ borderColor: "var(--ant-color-primary)" }} aria-label="已整理修改方案"><div className="flex items-center justify-between gap-2"><strong className="text-sm">待确认修改方案</strong><Tag color="blue">尚未执行</Tag></div><p className="m-0 whitespace-pre-wrap text-sm">{taskConversationPlanText(conversation.plan)}</p></div>}
            {candidate && <div className="space-y-2 border-l-2 pl-3 text-xs" style={{ borderColor: token.colorPrimary }} aria-label="候选状态">
                <strong>候选状态：{candidate.stale ? "依据已变化，需重新生成" : candidate.status === "pending" ? "待你采用" : candidate.status === "applied" ? "已采用" : "已放弃"}</strong>
                {candidate.summary && <p className="m-0" style={muted}>{candidate.summary}</p>}
                {candidate.stale && <p className="m-0 text-amber-600" role="status">正式方案未被覆盖。请继续讨论并重新生成候选，再核对后采用。</p>}
                {candidate.currentContent !== undefined && candidate.candidateContent !== undefined && <>
                    <div className="flex flex-wrap items-center gap-3" aria-label="候选修改标记"><span style={{ color: token.colorErrorText }}>− 原有内容</span><span style={{ color: token.colorSuccessText }}>+ 改编内容</span><span style={muted}>{comparisonRows.filter((row) => row.changed).length} 处变化</span></div>
                    <div className="max-h-64 overflow-y-auto">
                        {!comparisonRows.length ? <div className="p-4"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可对照内容" /></div> : <>
                            <div className="sticky top-0 z-10 hidden grid-cols-2 border-b text-xs font-medium md:grid" style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}><div className="px-2 py-1.5">当前正式内容</div><div className="border-l px-2 py-1.5" style={{ borderColor: token.colorBorderSecondary }}>待确认候选</div></div>
                            {comparisonRows.map((row, index) => <div key={index} className="grid grid-cols-1 border-b last:border-b-0 md:grid-cols-2" style={border}>
                            {(["before", "after"] as const).map((side) => {
                                const left = side === "before", value = row[side];
                                const visibleParts = row.changed ? row.parts.filter((part) => left ? !part.added : !part.removed) : [];
                                return <section key={side} className={`min-w-0 p-2 ${left ? "" : "border-t md:border-l md:border-t-0"}`} style={{ borderColor: token.colorBorderSecondary, background: row.changed ? left ? token.colorErrorBg : token.colorSuccessBg : undefined }} aria-label={left ? "当前正式内容" : "待确认候选"}>
                                    <div className="mb-1 font-medium md:hidden">{left ? "当前正式内容" : "待确认候选"}</div>
                                    <div className="flex items-start gap-2 whitespace-pre-wrap break-words leading-5 [overflow-wrap:anywhere]">
                                        <span className="w-3 shrink-0 select-none text-center" aria-hidden="true" style={{ color: row.changed ? left ? token.colorError : token.colorSuccess : token.colorTextQuaternary }}>{row.changed ? left ? "−" : "+" : "="}</span>
                                        <span className="min-w-0 flex-1">{row.changed ? visibleParts.map((part, partIndex) => <span key={partIndex} style={part.added || part.removed ? { color: left ? token.colorErrorText : token.colorSuccessText, background: left ? token.colorErrorBgHover : token.colorSuccessBgHover, textDecoration: left ? "line-through" : "underline", textUnderlineOffset: 2 } : undefined}>{part.value.join("")}</span>) : value}{row.changed && !value && <span style={muted}>无对应文字</span>}</span>
                                    </div>
                                </section>;
                            })}
                            </div>)}
                        </>}
                    </div>
                </>}
            </div>}
            {adapter.controls}

            <div className="shrink-0 space-y-2 border-t pt-3" style={border}>
                <Input.TextArea aria-label="任务对话输入" value={input} disabled={locked || busy} autoSize={{ minRows: 3, maxRows: 7 }} placeholder={phase === "candidate" ? "继续说候选哪里需要调整" : "描述问题、修改目标、要保留的内容或成片时间点"} onChange={(event) => onInput(event.target.value)} onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void requestAction("message"); } }} />
                <div className="flex flex-wrap items-center gap-2">
                    <Button icon={<Send size={14} />} loading={busy || quoting} disabled={locked || !input.trim() || quoting} onClick={() => void requestAction("message")}>{conversation?.messages.length ? "继续讨论" : prepareQuote ? "讨论并查看费用" : "开始讨论"}</Button>
                    {phase === "proposal" ? <Button type="primary" icon={<Sparkles size={14} />} loading={busy || quoting} disabled={locked || Boolean(input.trim()) || quoting} onClick={() => void requestAction("candidate")}>确认方案并生成候选</Button> : phase === "candidate" ? <>{adapter.applyCandidate && <Button type="primary" icon={<Check size={14} />} loading={busy} disabled={locked || candidate?.stale} onClick={adapter.applyCandidate}>{candidate?.stale ? "候选已过期" : "采用候选"}</Button>}{adapter.discardCandidate && <Button icon={<X size={14} />} loading={busy} disabled={locked} onClick={adapter.discardCandidate}>放弃候选</Button>}</> : <Button icon={<Sparkles size={14} />} loading={busy || quoting} disabled={locked || !conversation?.messages.some((message) => message.role === "user") || quoting} onClick={() => void requestAction("plan")}>{prepareQuote ? "整理方案 · 查看费用" : "整理修改方案"}</Button>}
                </div>
                {quoteError && <p className="m-0 text-xs text-red-600" role="alert">费用暂时无法核对，本轮尚未发送。{quoteError}</p>}
                {currentQuote && <div className="space-y-2 border p-3 text-sm" aria-label="费用确认"><div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{actionLabel} · {currentQuote.quote.credits.toLocaleString()} 算力点</strong><span className="text-xs" style={muted}>{currentQuote.quote.calculation}</span></div><p className="m-0 text-xs" style={muted}>{currentQuote.quote.details}</p>{currentQuote.changed && <p className="m-0 text-xs text-amber-600">处理范围或费用已变化，请重新核对；当前还没有执行。</p>}<div className="flex gap-2"><Button type="primary" size="small" loading={quoting} disabled={locked} onClick={() => void requestAction(currentQuote.action)}>确认费用并继续</Button><Button size="small" disabled={quoting} onClick={() => setPendingQuote(undefined)}>取消</Button></div></div>}
                {historySummary && <p className="m-0 flex items-center gap-1 text-xs" style={muted}><FileClock size={13} />{historySummary}</p>}
            </div>
        </section>
    );
}
