import { Button, Empty, Input, Modal, Switch, theme } from "antd";
import { Check, ChevronDown, MessageSquare, Maximize2, Send, Sparkles, Undo2, X } from "lucide-react";
import { diffArrays } from "diff";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { TaskChangePlan, TaskConversationAdapter, TaskConversationQuote } from "@/types/task-conversation";
import { taskConversationDiffRows, taskConversationPlanText, taskConversationQuoteError } from "@/lib/task-conversation";

export type ConversationAction = "message" | "plan" | "candidate";

export type TaskConversationWorkspaceProps = {
    adapter: TaskConversationAdapter;
    muted: CSSProperties;
    border: CSSProperties;
};

export function TaskConversationContextHeader({ context, muted, right, compact = false }: { context: Partial<TaskConversationAdapter["context"]>; muted: CSSProperties; right?: ReactNode; compact?: boolean }) {
    const subtitle = compact
        ? [context.business, context.subject, context.description].filter(Boolean).join(" · ")
        : context.subject || context.business;
    return <div className="space-y-3">
        <header className="flex shrink-0 items-start justify-between gap-3">
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <MessageSquare size={17} aria-hidden />
                    <h2 className="m-0 text-base font-semibold">{context.taskTitle || "任务对话"}</h2>
                </div>
                {subtitle && <p className="mt-1 truncate text-xs" title={subtitle} style={muted}>{subtitle}</p>}
                {!compact && <p className="mt-1 text-xs" style={muted}>正式内容仅在采用候选后更新</p>}
            </div>
            {right}
        </header>
    </div>;
}

const phaseLabels = { discussion: "讨论", proposal: "方案", candidate: "候选" } as const;

export function TaskConversationWorkspace({ adapter, muted, border }: TaskConversationWorkspaceProps) {
    const { conversation, input, onInput, locked, busy, prepareQuote, candidate } = adapter;
    const { token } = theme.useToken();
    const { evidenceSummary, evidence, evidencePreviews, constraints } = adapter.context;
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
    const [planDraft, setPlanDraft] = useState<TaskChangePlan>();
    const [compareOpen, setCompareOpen] = useState(false);
    const [onlyChanged, setOnlyChanged] = useState(true);
    const changedCount = comparisonRows.filter((row) => row.changed).length;
    const renderComparison = (full: boolean) => {
        const rows = full && onlyChanged ? comparisonRows.filter((row) => row.changed) : comparisonRows;
        return <>
            <div className={`sticky top-0 z-10 hidden grid-cols-2 border-b font-medium ${full ? "text-sm" : "text-xs"}`} style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}><div className="px-3 py-2">当前正式内容</div><div className="border-l px-3 py-2" style={{ borderColor: token.colorBorderSecondary }}>待确认候选</div></div>
            {rows.map((row, index) => <div key={index} className="grid grid-cols-1 border-b last:border-b-0 md:grid-cols-2" style={border}>
                {(["before", "after"] as const).map((side) => {
                    const left = side === "before", value = row[side];
                    const visibleParts = row.changed ? row.parts.filter((part) => left ? !part.added : !part.removed) : [];
                    return <section key={side} className={`min-w-0 ${full ? "p-3 text-sm leading-6" : "p-2 text-xs leading-5"} ${left ? "" : "border-t md:border-l md:border-t-0"}`} style={{ borderColor: token.colorBorderSecondary, background: row.changed ? left ? token.colorErrorBg : token.colorSuccessBg : undefined }} aria-label={left ? "当前正式内容" : "待确认候选"}>
                        <div className="mb-1 font-medium md:hidden">{left ? "当前正式内容" : "待确认候选"}</div>
                        <div className="flex items-start gap-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                            <span className="w-3 shrink-0 select-none text-center" aria-hidden="true" style={{ color: row.changed ? left ? token.colorError : token.colorSuccess : token.colorTextQuaternary }}>{row.changed ? left ? "−" : "+" : "="}</span>
                            <span className="min-w-0 flex-1">{row.changed ? visibleParts.map((part, partIndex) => <span key={partIndex} style={part.added || part.removed ? { color: left ? token.colorErrorText : token.colorSuccessText, background: left ? token.colorErrorBgHover : token.colorSuccessBgHover, textDecoration: left ? "line-through" : "underline", textUnderlineOffset: 2 } : undefined}>{part.value.join("")}</span>) : value}{row.changed && !value && <span style={muted}>无对应文字</span>}</span>
                        </div>
                    </section>;
                })}
            </div>)}
        </>;
    };
    const planText = conversation?.plan ? taskConversationPlanText(conversation.plan) : "";
    useEffect(() => {
        if (!planText) setPlanDraft(undefined);
    }, [planText]);
    const savePlanDraft = () => {
        if (!planDraft?.summary.trim() || !planDraft.changes.every((change) => change.change.trim())) return;
        adapter.updatePlan?.({
            ...planDraft,
            summary: planDraft.summary.trim(),
            changes: planDraft.changes.map((change) => ({ ...change, change: change.change.trim(), preserve: change.preserve.trim() })),
            unchanged: planDraft.unchanged.filter((item) => item.trim()),
        });
        setPlanDraft(undefined);
    };
    const actionKey = (action: ConversationAction) => JSON.stringify([action, adapter.context, input, conversation?.messages, conversation?.plan]);
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
            if (!quote || quote.credits === 0) {
                setPendingQuote(undefined);
                execute(action, quote || undefined);
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
    const hasInput = Boolean(input.trim());
    const hasDiscussion = Boolean(conversation?.messages.some((message) => message.role === "user"));
    const phaseAction = hasInput
        ? <Button type="primary" icon={<Send size={14} />} loading={busy || quoting} disabled={locked || quoting} onClick={() => void requestAction("message")}>{phase === "candidate" ? "继续调整" : conversation?.messages.length ? "继续讨论" : prepareQuote ? "讨论并查看费用" : "开始讨论"}</Button>
        : phase === "discussion"
            ? hasDiscussion
                ? <Button type="primary" icon={<Sparkles size={14} />} loading={busy || quoting} disabled={locked || quoting} onClick={() => void requestAction("plan")}>整理方案</Button>
                : <Button type="primary" icon={<Send size={14} />} disabled>开始讨论</Button>
            : phase === "proposal"
                ? <Button type="primary" icon={<Sparkles size={14} />} loading={busy || quoting} disabled={locked || quoting} onClick={() => void requestAction("candidate")}>确认方案并生成候选</Button>
                : null;
    const candidateActions = phase === "candidate" && !hasInput && <>
        {adapter.applyCandidate && <Button type="primary" icon={<Check size={14} />} loading={busy} disabled={locked || candidate?.stale} onClick={adapter.applyCandidate}>{candidate?.stale ? "候选已过期" : "采用候选"}</Button>}
        {adapter.discardCandidate && <Button icon={<X size={14} />} loading={busy} disabled={locked} onClick={adapter.discardCandidate}>放弃候选</Button>}
    </>;
    return (
        <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label="任务对话工作台">
            <TaskConversationContextHeader context={adapter.context} muted={muted} right={adapter.undo && <Button type="text" size="small" icon={<Undo2 size={15} />} disabled={locked || busy} onClick={adapter.undo}>撤销</Button>} />

            <div className="flex items-center gap-2 text-xs" aria-label={`当前阶段：${phaseLabels[phase]}`}>
                {(["discussion", "proposal", "candidate"] as const).map((item, index) => <div key={item} className="flex shrink-0 items-center gap-2">
                    <span className={phase === item ? "font-semibold" : ""} style={{ color: phase === item ? token.colorPrimary : index < (["discussion", "proposal", "candidate"] as const).indexOf(phase) ? token.colorSuccess : token.colorTextQuaternary }}>{phaseLabels[item]}</span>
                    {index < 2 && <span aria-hidden style={muted}>›</span>}
                </div>)}
            </div>

            {(evidenceSummary || evidence || evidencePreviews?.length || constraints?.length) && <details className="group shrink-0 border-b pb-2 text-xs" style={border} aria-label="本轮依据与保留要求">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 py-1">
                    <span className="min-w-0 truncate" title={evidenceSummary}><strong>本轮依据</strong>{evidenceSummary && <span className="ml-2" style={muted}>{evidenceSummary}</span>}</span>
                    <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="space-y-2 pt-2">
                    {evidence && <p className="m-0 whitespace-pre-wrap" style={muted}>{evidence}</p>}
                    {evidencePreviews?.length ? <div className="flex gap-2 overflow-x-auto" aria-label="本轮拟发送的成片取样画面">{evidencePreviews.map((preview) => <figure key={preview.label} className="m-0 w-24 shrink-0"><img src={preview.url} alt={preview.label} className="aspect-video w-full object-contain" /><figcaption className="mt-1 break-words" style={muted}>{preview.label}</figcaption></figure>)}</div> : null}
                    {constraints?.map((item) => <p key={item} className="m-0" style={muted}>保留：{item}</p>)}
                </div>
            </details>}

            <div className="min-h-28 flex-1 space-y-3 overflow-y-auto pr-1" role="log" aria-label="任务对话记录" aria-live="polite">
                {conversation?.messages.map((message) => <div key={message.id} className={`max-w-[94%] space-y-1 border p-3 text-sm [overflow-wrap:anywhere] ${message.role === "user" ? "ml-auto" : "mr-auto"}`} style={border}><span className="text-xs" style={muted}>{message.role === "user" ? "你" : "助手"}</span><p className="m-0 whitespace-pre-wrap">{message.text}</p></div>)}
            </div>

            {conversation?.plan && <div className="max-h-40 space-y-2 overflow-y-auto border-l-2 pl-3" style={{ borderColor: "var(--ant-color-primary)" }} aria-label="已整理修改方案">
                <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">待确认方案</strong>
                    <Button type="text" size="small" aria-label="放大查看待确认方案" title="放大查看与编辑" icon={<Maximize2 size={14} />} disabled={!adapter.updatePlan} onClick={() => setPlanDraft(structuredClone(conversation.plan!))}>放大</Button>
                </div>
                <p className="m-0 whitespace-pre-wrap text-sm">{planText}</p>
            </div>}
            {candidate && <div className="space-y-2 border-l-2 pl-3 text-xs" style={{ borderColor: token.colorPrimary }} aria-label="候选状态">
                <strong>候选状态：{candidate.stale ? "依据已变化，需重新生成" : candidate.status === "pending" ? "待你采用" : candidate.status === "applied" ? "已采用" : "已放弃"}</strong>
                {candidate.summary && <p className="m-0" style={muted}>{candidate.summary}</p>}
                {candidate.stale && <p className="m-0 text-amber-600" role="status">正式方案未被覆盖。请继续讨论并重新生成候选，再核对后采用。</p>}
                {candidate.currentContent !== undefined && candidate.candidateContent !== undefined && <>
                    <div className="flex flex-wrap items-center gap-3" aria-label="候选修改标记">
                        <span style={{ color: token.colorErrorText }}>− 原有内容</span><span style={{ color: token.colorSuccessText }}>+ 改编内容</span><span style={muted}>{changedCount} 处变化</span>
                        <Button className="ml-auto" type="text" size="small" aria-label="全屏对照正式内容与候选" title="全屏对照" icon={<Maximize2 size={14} />} onClick={() => setCompareOpen(true)} />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                        {!comparisonRows.length ? <div className="p-4"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可对照内容" /></div> : renderComparison(false)}
                    </div>
                </>}
            </div>}
            <Modal
                open={compareOpen}
                title="全屏对照 · 当前正式内容 / 待确认候选"
                width="min(1400px, 96vw)"
                style={{ top: 24 }}
                onCancel={() => setCompareOpen(false)}
                destroyOnHidden
                footer={[
                    adapter.applyCandidate && <Button key="apply" type="primary" loading={busy} disabled={locked || candidate?.stale} onClick={() => { setCompareOpen(false); adapter.applyCandidate?.(); }}>{candidate?.stale ? "候选已过期" : "采用候选"}</Button>,
                    <Button key="close" onClick={() => setCompareOpen(false)}>关闭</Button>,
                ]}
                styles={{ body: { height: "calc(100dvh - 200px)", overflow: "auto", padding: 0 } }}
            >
                <div className="flex flex-wrap items-center gap-4 border-b px-3 py-2 text-xs" style={border}>
                    <span style={{ color: token.colorErrorText }}>− 原有内容</span><span style={{ color: token.colorSuccessText }}>+ 改编内容</span><span style={muted}>共 {changedCount} 处变化</span>
                    <Switch size="small" checked={onlyChanged} onChange={setOnlyChanged} /> <span style={muted}>只看变化</span>
                </div>
                {comparisonRows.length ? renderComparison(true) : <div className="p-8"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可对照内容" /></div>}
            </Modal>
            {adapter.controls}

            <div className="shrink-0 space-y-2 border-t pt-3" style={border}>
                <Input.TextArea aria-label="任务对话输入" value={input} disabled={locked || busy} autoSize={{ minRows: 3, maxRows: 7 }} placeholder={phase === "candidate" ? "说说候选还要怎么调整" : "说说哪里需要调整，或想保留什么…"} onChange={(event) => onInput(event.target.value)} onPressEnter={(event) => { if (!event.shiftKey) { event.preventDefault(); void requestAction("message"); } }} />
                <div className="flex flex-wrap items-center gap-2">
                    {phaseAction}
                    {candidateActions}
                </div>
                {quoteError && <p className="m-0 text-xs text-red-600" role="alert">费用暂时无法核对，本轮尚未发送。{quoteError}</p>}
                {currentQuote && <div className="space-y-2 border p-3 text-sm" aria-label="费用确认"><div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{actionLabel} · {currentQuote.quote.credits.toLocaleString()} 算力点</strong><span className="text-xs" style={muted}>{currentQuote.quote.calculation}</span></div><p className="m-0 text-xs" style={muted}>{currentQuote.quote.details}</p>{currentQuote.changed && <p className="m-0 text-xs text-amber-600">处理范围或费用已变化，请重新核对；当前还没有执行。</p>}<div className="flex gap-2"><Button type="primary" size="small" loading={quoting} disabled={locked} onClick={() => void requestAction(currentQuote.action)}>确认费用并继续</Button><Button size="small" disabled={quoting} onClick={() => setPendingQuote(undefined)}>取消</Button></div></div>}
            </div>

            <Modal
                open={Boolean(planDraft)}
                title="待确认方案"
                width={760}
                okText="保存修改"
                cancelText="取消"
                okButtonProps={{ disabled: locked || !planDraft?.summary.trim() || !planDraft.changes.every((change) => change.change.trim()) }}
                onOk={savePlanDraft}
                onCancel={() => setPlanDraft(undefined)}
                destroyOnHidden
                styles={{ body: { maxHeight: "calc(100dvh - 220px)", overflowY: "auto" } }}
            >
                {planDraft && <div className="space-y-4 text-sm">
                    <label className="block space-y-1"><span className="text-xs" style={muted}>问题理解</span><Input.TextArea aria-label="问题理解" autoSize={{ minRows: 2 }} value={planDraft.summary} onChange={(event) => setPlanDraft({ ...planDraft, summary: event.target.value })} /></label>
                    <div className="space-y-1"><span className="text-xs" style={muted}>影响范围</span><p className="m-0">{planDraft.targets.map((target) => target.label).join("、")}</p></div>
                    {planDraft.changes.map((change, index) => <div key={`${change.targetId}-${index}`} className="space-y-2 border-l-2 pl-3" style={{ borderColor: token.colorPrimary }}>
                        <strong className="text-sm font-medium">{planDraft.targets.find((target) => target.id === change.targetId)?.label || `修改项 ${index + 1}`}</strong>
                        <label className="block space-y-1"><span className="text-xs" style={muted}>调整内容</span><Input.TextArea aria-label={`调整内容${index + 1}`} autoSize={{ minRows: 2 }} value={change.change} onChange={(event) => setPlanDraft({ ...planDraft, changes: planDraft.changes.map((item, i) => i === index ? { ...item, change: event.target.value } : item) })} /></label>
                        <label className="block space-y-1"><span className="text-xs" style={muted}>保留</span><Input.TextArea aria-label={`保留内容${index + 1}`} autoSize={{ minRows: 1 }} value={change.preserve} onChange={(event) => setPlanDraft({ ...planDraft, changes: planDraft.changes.map((item, i) => i === index ? { ...item, preserve: event.target.value } : item) })} /></label>
                    </div>)}
                    <label className="block space-y-1"><span className="text-xs" style={muted}>明确不修改（每行一项）</span><Input.TextArea aria-label="明确不修改" autoSize={{ minRows: 2 }} value={planDraft.unchanged.join("\n")} onChange={(event) => setPlanDraft({ ...planDraft, unchanged: event.target.value.split("\n") })} /></label>
                    {planDraft.evidence?.length ? <div className="space-y-1"><span className="text-xs" style={muted}>成片依据</span>{planDraft.evidence.map((item, index) => <p key={index} className="m-0 text-xs" style={muted}>{item.timeSeconds === undefined ? "" : `${item.timeSeconds.toFixed(2)} 秒：`}{item.description}</p>)}</div> : null}
                    <p className="m-0 text-xs" style={muted}>保存后仍按这份方案生成候选，正式内容要等你采用候选才会更新。</p>
                </div>}
            </Modal>
        </section>
    );
}
