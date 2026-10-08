import { App, Typography } from "antd";
import { publicServiceText, REPLICATE_MODEL_NAMES, type ReplicateQuote } from "@/services/api/replicate";

export function useReplicateConfirmation() {
    const { modal } = App.useApp();
    return (quote: ReplicateQuote, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (!quote.available) {
                reject(new Error(publicServiceText(quote.reason || "平台服务暂不可用")));
                return;
            }
            if (signal?.aborted) {
                reject(new DOMException("已取消", "AbortError"));
                return;
            }
            const finish = (accepted: boolean) => {
                signal?.removeEventListener("abort", abort);
                if (accepted) resolve();
                else reject(new DOMException("已取消本次制作，未创建收费任务", "AbortError"));
            };
            const dialog = modal.confirm({
                title: `确认${REPLICATE_MODEL_NAMES[quote.operation]}`,
                content: (
                    <div className="space-y-3">
                        <div>处理服务：{REPLICATE_MODEL_NAMES[quote.operation]}</div>
                        <div>{publicServiceText(quote.description || "")}</div>
                        {quote.inputSummary && <div>{publicServiceText(quote.inputSummary)}</div>}
                        {quote.submissionBlocked && <Typography.Text type="warning">{publicServiceText(quote.submissionBlocked)}</Typography.Text>}
                        {!!quote.durationSeconds && <div>素材 / 输出时长：{quote.durationSeconds.toFixed(2)} 秒</div>}
                        <div>
                            <Typography.Text type={quote.usedDefaultDuration ? "warning" : "secondary"}>{publicServiceText(quote.calculation || quote.billingDescription || "")}</Typography.Text>
                        </div>
                        <div className="text-lg font-semibold">
                            本次消耗：{quote.credits.toLocaleString()} 算力点
                        </div>
                        <div className="text-xs">
                            <Typography.Text type="secondary">取消不扣点；确认后创建任务，明确失败后自动返还算力点。</Typography.Text>
                        </div>
                    </div>
                ),
                okText: "确认制作",
                okButtonProps: { disabled: Boolean(quote.submissionBlocked) },
                cancelText: "取消",
                onOk: () => finish(true),
                onCancel: () => finish(false),
            });
            const abort = () => {
                dialog.destroy();
                finish(false);
            };
            signal?.addEventListener("abort", abort, { once: true });
        });
}
