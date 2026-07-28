"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Empty, Input, Modal, Space, Table, Tabs, Tag, Typography, type TableProps } from "antd";
import dayjs from "dayjs";

import { fetchUserCreditLogs, redeemCode, type CreditLog } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

type CreditCenterModalProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const logTypeLabels: Record<string, { label: string; color?: string }> = {
    admin_adjust: { label: "后台调整", color: "blue" },
    ai_consume: { label: "模型消费", color: "red" },
    ai_refund: { label: "失败返还", color: "green" },
    redeem_topup: { label: "兑换充值", color: "cyan" },
};

const numberFormatter = new Intl.NumberFormat("zh-CN");

export function CreditCenterModal({ open, onOpenChange }: CreditCenterModalProps) {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const setSession = useUserStore((state) => state.setSession);
    const [code, setCode] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    const logsQuery = useQuery({
        queryKey: ["credit-center", "logs", token, page, pageSize],
        queryFn: () => fetchUserCreditLogs(token, { page, pageSize }),
        enabled: open && Boolean(token),
    });

    const redeemMutation = useMutation({
        mutationFn: () => redeemCode(token, code),
        onSuccess: async (result) => {
            setSession(token, result.user);
            setCode("");
            await queryClient.invalidateQueries({ queryKey: ["credit-center", "logs"] });
            message.success(`兑换成功，到账 ${numberFormatter.format(result.credits)} 点`);
        },
        onError: (error) => message.error(error instanceof Error ? error.message : "兑换失败"),
    });

    const columns = useMemo<TableProps<CreditLog>["columns"]>(
        () => [
            {
                title: "时间",
                dataIndex: "createdAt",
                width: 180,
                render: (_, item) => <Typography.Text type="secondary">{item.createdAt ? dayjs(item.createdAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Typography.Text>,
            },
            {
                title: "类型",
                dataIndex: "type",
                width: 110,
                render: (_, item) => {
                    const type = logTypeLabels[item.type] || { label: item.type || "-" };
                    return <Tag color={type.color}>{type.label}</Tag>;
                },
            },
            {
                title: "变动",
                dataIndex: "amount",
                width: 100,
                align: "right",
                render: (_, item) => (
                    <Typography.Text type={item.amount >= 0 ? "success" : "danger"} className="tabular-nums">
                        {item.amount > 0 ? "+" : ""}
                        {numberFormatter.format(item.amount)}
                    </Typography.Text>
                ),
            },
            {
                title: "余额",
                dataIndex: "balance",
                width: 100,
                align: "right",
                render: (_, item) => <span className="tabular-nums">{numberFormatter.format(item.balance)}</span>,
            },
            {
                title: "说明",
                dataIndex: "remark",
                ellipsis: true,
                render: (_, item) => <Typography.Text type="secondary">{item.remark || "-"}</Typography.Text>,
            },
        ],
        [],
    );

    if (!user) return null;

    const logs = logsQuery.data?.items || [];
    const total = logsQuery.data?.total || 0;

    return (
        <Modal title="算力中心" open={open} width={760} footer={null} onCancel={() => onOpenChange(false)} destroyOnHidden>
            <Space direction="vertical" size={14} style={{ width: "100%" }}>
                <div className="flex items-center justify-between rounded-md border border-solid border-slate-200 px-4 py-3 dark:border-slate-700">
                    <Typography.Text type="secondary">当前余额</Typography.Text>
                    <Typography.Text strong className="tabular-nums">
                        {numberFormatter.format(user.credits)} 点
                    </Typography.Text>
                </div>
                <Tabs
                    items={[
                        {
                            key: "logs",
                            label: "使用日志",
                            children: (
                                <Table<CreditLog>
                                    rowKey="id"
                                    size="middle"
                                    columns={columns}
                                    dataSource={logs}
                                    loading={logsQuery.isFetching}
                                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无使用日志" /> }}
                                    pagination={{
                                        current: page,
                                        pageSize,
                                        total,
                                        showSizeChanger: true,
                                        showTotal: (value) => `共 ${value} 条`,
                                        onChange: (nextPage, nextPageSize) => {
                                            if (nextPageSize !== pageSize) {
                                                setPage(1);
                                                setPageSize(nextPageSize);
                                                return;
                                            }
                                            setPage(nextPage);
                                        },
                                    }}
                                />
                            ),
                        },
                        {
                            key: "redeem",
                            label: "兑换码",
                            children: (
                                <Space.Compact style={{ width: "100%" }}>
                                    <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入兑换码" onPressEnter={() => redeemMutation.mutate()} />
                                    <Button type="primary" loading={redeemMutation.isPending} disabled={!code.trim()} onClick={() => redeemMutation.mutate()}>
                                        立即兑换
                                    </Button>
                                </Space.Compact>
                            ),
                        },
                    ]}
                />
            </Space>
        </Modal>
    );
}
