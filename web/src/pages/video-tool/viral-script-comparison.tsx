import { useMemo, useRef, useState } from "react";
import { Button, Empty, Segmented, Tooltip, theme } from "antd";
import { ArrowDown, ArrowUp } from "lucide-react";
import { diffArrays, diffLines } from "diff";

export function scriptComparisonRows(before: string, after: string) {
    const rows: { before: string; after: string; changed: boolean }[] = [];
    const changes = diffLines(before, after);
    for (let i = 0; i < changes.length; i++) {
        const part = changes[i];
        if (!part.added && !part.removed) {
            rows.push({ before: part.value, after: part.value, changed: false });
            continue;
        }
        let left = "", right = "";
        while (i < changes.length && (changes[i].added || changes[i].removed)) {
            if (changes[i].removed) left += changes[i].value;
            else right += changes[i].value;
            i++;
        }
        i--;
        rows.push({ before: left, after: right, changed: true });
    }
    return rows;
}

export default function ViralScriptComparison({ before, after, beforeLabel, afterLabel }: {
    before: string; after: string; beforeLabel: string; afterLabel: string;
}) {
    const { token } = theme.useToken();
    const [onlyChanges, setOnlyChanges] = useState(false), [active, setActive] = useState(-1);
    const rowElements = useRef(new Map<number, HTMLDivElement>());
    const rows = useMemo(() => {
        const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : null;
        const words = (text: string) => segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
        return scriptComparisonRows(before, after).map((row) => ({
            ...row,
            parts: row.changed ? diffArrays(words(row.before), words(row.after)) : [],
        }));
    }, [before, after]);
    const changed = rows.flatMap((row, index) => row.changed ? [index] : []);
    const goChange = (direction: number) => {
        if (!changed.length) return;
        const index = active < 0 ? direction > 0 ? 0 : changed.length - 1 : (active + direction + changed.length) % changed.length;
        setActive(index);
        rowElements.current.get(changed[index])?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    return <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="viral-script-comparison">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <Segmented aria-label="差异显示范围" value={onlyChanges ? "changes" : "all"} onChange={(value) => setOnlyChanges(value === "changes")} options={[{ value: "all", label: "全部内容" }, { value: "changes", label: "仅看差异" }]} />
            <div className="flex items-center gap-1">
                <span className="mr-1 text-xs" style={{ color: token.colorTextSecondary }}>{active >= 0 ? `${active + 1} / ` : ""}{changed.length} 处文字差异</span>
                <Tooltip title="上一处差异"><Button aria-label="上一处差异" size="small" disabled={!changed.length} icon={<ArrowUp size={14} />} onClick={() => goChange(-1)} /></Tooltip>
                <Tooltip title="下一处差异"><Button aria-label="下一处差异" size="small" disabled={!changed.length} icon={<ArrowDown size={14} />} onClick={() => goChange(1)} /></Tooltip>
            </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded border" style={{ borderColor: token.colorBorderSecondary }} data-testid="viral-comparison-scroll">
            <div className="sticky top-0 z-10 hidden grid-cols-2 border-b text-sm font-medium md:grid" style={{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }}>
                <h3 className="min-w-0 break-words px-4 py-3">{beforeLabel}</h3>
                <h3 className="min-w-0 break-words border-l px-4 py-3" style={{ borderColor: token.colorBorderSecondary }}>{afterLabel}</h3>
            </div>
            {!rows.length || (onlyChanges && !changed.length) ? <div className="p-8"><Empty description={before || after ? "两份文本一致" : "暂无可对照内容"} /></div> : rows.map((row, index) => {
                if (onlyChanges && !row.changed) return null;
                return <div key={index} ref={(element) => { if (element) rowElements.current.set(index, element); else rowElements.current.delete(index); }}
                    className="grid scroll-mt-14 grid-cols-1 border-b last:border-b-0 md:grid-cols-2"
                    style={{ borderColor: token.colorBorderSecondary, outline: changed[active] === index ? `1px solid ${token.colorPrimary}` : undefined, outlineOffset: -1 }}
                    data-testid={row.changed ? "viral-changed-row" : "viral-unchanged-row"}>
                    {(["before", "after"] as const).map((side) => {
                        const left = side === "before", color = left ? token.colorError : token.colorSuccess;
                        return <section key={side} className={`min-w-0 p-3 sm:p-4 ${left ? "" : "border-t md:border-l md:border-t-0"}`} aria-label={left ? beforeLabel : afterLabel}
                            style={{ borderColor: token.colorBorderSecondary, background: row.changed ? left ? token.colorErrorBg : token.colorSuccessBg : undefined }}>
                            <div className="mb-2 text-xs font-medium md:hidden">{left ? beforeLabel : afterLabel}</div>
                            <div className="flex items-start gap-2 text-sm leading-7">
                                <span className="w-3 shrink-0 select-none text-center" aria-hidden="true" style={{ color: row.changed ? color : token.colorTextQuaternary }}>{row.changed ? left ? "-" : "+" : "="}</span>
                                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-side={side}>
                                    {row.changed ? row.parts.filter((part) => left ? !part.added : !part.removed).map((part, partIndex) =>
                                        <span key={partIndex} data-change={part.added ? "added" : part.removed ? "removed" : "same"} style={part.added || part.removed ? {
                                            color: left ? token.colorErrorText : token.colorSuccessText,
                                            background: left ? token.colorErrorBgHover : token.colorSuccessBgHover,
                                            textDecoration: left ? "line-through" : "underline",
                                            textUnderlineOffset: 3,
                                        } : undefined}>{part.value.join("")}</span>
                                    ) : row[side]}
                                    {!row[side] && <span style={{ color: token.colorTextSecondary }}>无对应文字</span>}
                                </div>
                            </div>
                        </section>;
                    })}
                </div>;
            })}
        </div>
        <p className="shrink-0 text-xs" style={{ color: token.colorTextSecondary }}>相同文字不标色；左侧红色为原有文字，右侧绿色为改编文字。文字差异不代表语义遗漏或成片效果。</p>
    </div>;
}
