"use client";

import { DeleteOutlined, EditOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Avatar, Button, Card, Col, DatePicker, Descriptions, Flex, Form, Input, InputNumber, Modal, Row, Select, Space, Tag, Tooltip, Typography, theme } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useMemo, useState } from "react";

import type { AdminCreditLog, AdminCreditLogQuery } from "@/services/api/admin";
import { defaultCreditLogPageSize, useAdminCreditLogs } from "./use-admin-credit-logs";

type CreditLogFormValues = Partial<AdminCreditLog>;
type DateRange = [Dayjs, Dayjs];
type CreditLogDraft = {
    keyword: string;
    type: string;
    model: string;
    range: DateRange;
};
type CreditLogFilters = Required<Pick<AdminCreditLogQuery, "page" | "pageSize">> & Pick<AdminCreditLogQuery, "keyword" | "type" | "model" | "startTime" | "endTime">;

const creditLogTypeLabels: Record<string, string> = {
    admin_adjust: "后台调整",
    ai_consume: "模型消费",
    ai_refund: "失败返还",
    redeem_topup: "兑换充值",
};

const creditLogTypeColors: Record<string, string> = {
    admin_adjust: "blue",
    ai_consume: "orange",
    ai_refund: "green",
    redeem_topup: "cyan",
};

const creditLogTypeOptions = [{ label: "全部类型", value: "" }, ...Object.entries(creditLogTypeLabels).map(([value, label]) => ({ value, label }))];

function defaultDateRange(): DateRange {
    const now = dayjs();
    return [now.startOf("day"), now.add(1, "hour")];
}

function defaultDraft(): CreditLogDraft {
    return { keyword: "", type: "", model: "", range: defaultDateRange() };
}

function draftToFilters(draft: CreditLogDraft, page: number, pageSize: number): CreditLogFilters {
    return {
        keyword: draft.keyword.trim(),
        type: draft.type,
        model: draft.model.trim(),
        startTime: draft.range[0].format(),
        endTime: draft.range[1].format(),
        page,
        pageSize,
    };
}

function readExtra(log: AdminCreditLog): Record<string, unknown> | null {
    if (!log.extra) return null;
    try {
        const value = JSON.parse(log.extra) as unknown;
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function getLogModel(log: AdminCreditLog) {
    const extra = readExtra(log);
    const model = stringValue(extra?.model);
    if (model) return model;
    const match = log.remark?.match(/模型\s*([^\s，,]+)/);
    return match?.[1] || "";
}

function getLogPath(log: AdminCreditLog) {
    return stringValue(readExtra(log)?.path);
}

function formatDate(value?: string) {
    return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "-";
}

export default function AdminCreditLogsPage() {
    const { token: themeToken } = theme.useToken();
    const [draft, setDraft] = useState<CreditLogDraft>(() => defaultDraft());
    const [filters, setFilters] = useState<CreditLogFilters>(() => draftToFilters(defaultDraft(), 1, defaultCreditLogPageSize));
    const { logs, stats, total, isLoading, refreshLogs, saveLog: saveAdminLog, deleteLog } = useAdminCreditLogs(filters);
    const [form] = Form.useForm<CreditLogFormValues>();
    const [editingLog, setEditingLog] = useState<Partial<AdminCreditLog> | null>(null);
    const [deletingLog, setDeletingLog] = useState<AdminCreditLog | null>(null);
    const [detailLog, setDetailLog] = useState<AdminCreditLog | null>(null);

    useEffect(() => {
        if (editingLog) form.setFieldsValue({ type: "admin_adjust", amount: 0, balance: 0, ...editingLog });
    }, [editingLog, form]);

    const saveLog = async () => {
        const value = await form.validateFields();
        await saveAdminLog({ ...editingLog, ...value });
        setEditingLog(null);
    };

    const applyFilters = () => {
        setFilters((current) => draftToFilters(draft, 1, current.pageSize));
    };

    const resetFilters = () => {
        const nextDraft = defaultDraft();
        setDraft(nextDraft);
        setFilters(draftToFilters(nextDraft, 1, defaultCreditLogPageSize));
    };

    const setRangePreset = (preset: "today" | "yesterday" | "week") => {
        const now = dayjs();
        const range: DateRange = preset === "yesterday" ? [now.subtract(1, "day").startOf("day"), now.subtract(1, "day").endOf("day")] : preset === "week" ? [now.subtract(6, "day").startOf("day"), now.add(1, "hour")] : defaultDateRange();
        setDraft((current) => ({ ...current, range }));
    };

    const statItems = useMemo(
        () => [
            { label: "消费点数", value: stats.consume, color: themeToken.colorError },
            { label: "返还/充值", value: stats.refund, color: themeToken.colorSuccess },
            { label: "净变动", value: stats.net, color: stats.net >= 0 ? themeToken.colorSuccess : themeToken.colorError },
            { label: "日志条数", value: stats.count || total, color: themeToken.colorPrimary },
        ],
        [stats.consume, stats.count, stats.net, stats.refund, themeToken.colorError, themeToken.colorPrimary, themeToken.colorSuccess, total],
    );

    const columns: ProColumns<AdminCreditLog>[] = [
        {
            title: "时间",
            dataIndex: "createdAt",
            width: 180,
            render: (_, item) => <Typography.Text type="secondary">{formatDate(item.createdAt)}</Typography.Text>,
        },
        {
            title: "用户",
            dataIndex: "userId",
            width: 280,
            render: (_, item) => {
                const userName = item.user?.displayName || item.user?.username || item.userId;
                const avatarText = (userName || "U").slice(0, 1).toUpperCase();
                return (
                    <Flex align="center" gap={10} style={{ minWidth: 0 }}>
                        <Avatar src={item.user?.avatarUrl || undefined}>{avatarText}</Avatar>
                        <Flex vertical style={{ minWidth: 0 }}>
                            <Typography.Text strong ellipsis>
                                {userName}
                            </Typography.Text>
                            <Typography.Text type="secondary" copyable={{ text: item.userId }} ellipsis>
                                {item.userId}
                            </Typography.Text>
                        </Flex>
                    </Flex>
                );
            },
        },
        {
            title: "类型",
            dataIndex: "type",
            width: 120,
            render: (_, item) => <Tag color={creditLogTypeColors[item.type]}>{creditLogTypeLabels[item.type] || item.type || "-"}</Tag>,
        },
        {
            title: "模型/来源",
            key: "model",
            width: 160,
            ellipsis: true,
            render: (_, item) => {
                const model = getLogModel(item);
                return <Typography.Text type={model ? undefined : "secondary"}>{model || "-"}</Typography.Text>;
            },
        },
        {
            title: "变动",
            dataIndex: "amount",
            width: 100,
            align: "right",
            render: (_, item) => <Typography.Text type={item.amount >= 0 ? "success" : "danger"}>{item.amount}</Typography.Text>,
        },
        {
            title: "余额",
            dataIndex: "balance",
            width: 100,
            align: "right",
        },
        {
            title: "备注",
            dataIndex: "remark",
            ellipsis: true,
            render: (_, item) => <Typography.Text type="secondary">{item.remark || "-"}</Typography.Text>,
        },
        {
            title: "操作",
            key: "actions",
            width: 120,
            align: "right",
            render: (_, item) => (
                <Space size={4}>
                    <Tooltip title="详情">
                        <Button type="text" size="small" icon={<InfoCircleOutlined />} onClick={() => setDetailLog(item)} />
                    </Tooltip>
                    <Tooltip title="编辑">
                        <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditingLog(item)} />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingLog(item)} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <main style={{ padding: 24 }}>
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card variant="borderless">
                    <Flex vertical gap={14}>
                        <Flex wrap gap={12}>
                            {statItems.map((item) => (
                                <div key={item.label} style={{ minWidth: 132, border: `1px solid ${themeToken.colorBorderSecondary}`, borderRadius: 6, padding: "8px 12px", background: themeToken.colorBgContainer }}>
                                    <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                                        {item.label}
                                    </Typography.Text>
                                    <Typography.Text strong style={{ color: item.color, fontSize: 18 }}>
                                        {item.value.toLocaleString("zh-CN")}
                                    </Typography.Text>
                                </div>
                            ))}
                        </Flex>
                        <Form layout="vertical">
                            <Row gutter={12} align="bottom">
                                <Col flex="360px">
                                    <Form.Item label="时间范围">
                                        <Space.Compact style={{ width: "100%" }}>
                                            <DatePicker.RangePicker
                                                showTime
                                                allowClear={false}
                                                value={draft.range}
                                                format="YYYY-MM-DD HH:mm:ss"
                                                onChange={(value) => {
                                                    const [start, end] = value || [];
                                                    if (start && end) setDraft((current) => ({ ...current, range: [start, end] }));
                                                }}
                                                style={{ width: "100%" }}
                                            />
                                        </Space.Compact>
                                    </Form.Item>
                                </Col>
                                <Col flex="none">
                                    <Form.Item label="快捷范围">
                                        <Space>
                                            <Button onClick={() => setRangePreset("today")}>今天</Button>
                                            <Button onClick={() => setRangePreset("yesterday")}>昨天</Button>
                                            <Button onClick={() => setRangePreset("week")}>近 7 天</Button>
                                        </Space>
                                    </Form.Item>
                                </Col>
                                <Col flex="180px">
                                    <Form.Item label="类型">
                                        <Select value={draft.type} options={creditLogTypeOptions} onChange={(value) => setDraft((current) => ({ ...current, type: value }))} />
                                    </Form.Item>
                                </Col>
                                <Col flex="220px">
                                    <Form.Item label="模型">
                                        <Input value={draft.model} placeholder="搜索模型名称" allowClear onPressEnter={applyFilters} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} />
                                    </Form.Item>
                                </Col>
                                <Col flex="320px">
                                    <Form.Item label="关键词">
                                        <Input.Search
                                            value={draft.keyword}
                                            placeholder="搜索用户、用户 ID、备注或关联 ID"
                                            allowClear
                                            enterButton={<SearchOutlined />}
                                            onSearch={applyFilters}
                                            onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))}
                                        />
                                    </Form.Item>
                                </Col>
                                <Col flex="none">
                                    <Form.Item>
                                        <Space>
                                            <Button onClick={resetFilters}>重置</Button>
                                            <Button type="primary" icon={<ReloadOutlined />} onClick={applyFilters}>
                                                查询
                                            </Button>
                                        </Space>
                                    </Form.Item>
                                </Col>
                            </Row>
                        </Form>
                    </Flex>
                </Card>
                <ProTable<AdminCreditLog>
                    rowKey="id"
                    columns={columns}
                    dataSource={logs}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>使用日志</Typography.Text>
                            <Tag>{total} 条</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refreshLogs() }}
                    toolBarRender={() => [
                        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setEditingLog({ type: "admin_adjust", amount: 0, balance: 0 })}>
                            新增
                        </Button>,
                    ]}
                    pagination={{
                        current: filters.page,
                        pageSize: filters.pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 50, 100],
                        showTotal: (value) => `共 ${value} 条`,
                        onChange: (nextPage, nextPageSize) =>
                            setFilters((current) => ({
                                ...current,
                                page: nextPageSize !== current.pageSize ? 1 : nextPage,
                                pageSize: nextPageSize,
                            })),
                    }}
                />
            </Space>

            <Modal title={editingLog?.id ? "编辑日志" : "新增日志"} open={Boolean(editingLog)} width={680} onCancel={() => setEditingLog(null)} onOk={() => void saveLog()} okText="保存" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false}>
                    <Row gutter={14}>
                        <Col span={12}>
                            <Form.Item name="userId" label="用户 ID" rules={[{ required: true, message: "请输入用户 ID" }]}>
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="type" label="类型" rules={[{ required: true, message: "请输入类型" }]}>
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="amount" label="变动数量" rules={[{ required: true, message: "请输入变动数量" }]}>
                                <InputNumber precision={0} style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="balance" label="变动后余额" rules={[{ required: true, message: "请输入变动后余额" }]}>
                                <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="relatedId" label="关联 ID">
                                <Input />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="createdAt" label="创建时间">
                                <Input placeholder="不填则新增时自动生成" />
                            </Form.Item>
                        </Col>
                        <Col span={24}>
                            <Form.Item name="remark" label="备注">
                                <Input.TextArea rows={3} />
                            </Form.Item>
                        </Col>
                        <Col span={24}>
                            <Form.Item name="extra" label="扩展信息">
                                <Input.TextArea rows={3} />
                            </Form.Item>
                        </Col>
                    </Row>
                </Form>
            </Modal>

            <Modal title="日志详情" open={Boolean(detailLog)} width={760} footer={null} onCancel={() => setDetailLog(null)} destroyOnHidden>
                {detailLog ? (
                    <Descriptions
                        bordered
                        size="small"
                        column={1}
                        items={[
                            { key: "user", label: "用户", children: detailLog.user?.displayName || detailLog.user?.username || detailLog.userId },
                            { key: "userId", label: "用户 ID", children: <Typography.Text copyable>{detailLog.userId}</Typography.Text> },
                            { key: "type", label: "类型", children: creditLogTypeLabels[detailLog.type] || detailLog.type || "-" },
                            { key: "model", label: "模型/来源", children: getLogModel(detailLog) || "-" },
                            { key: "path", label: "请求路径", children: getLogPath(detailLog) || "-" },
                            { key: "amount", label: "变动", children: <Typography.Text type={detailLog.amount >= 0 ? "success" : "danger"}>{detailLog.amount}</Typography.Text> },
                            { key: "balance", label: "余额", children: detailLog.balance },
                            { key: "relatedId", label: "关联 ID", children: detailLog.relatedId ? <Typography.Text copyable>{detailLog.relatedId}</Typography.Text> : "-" },
                            { key: "remark", label: "备注", children: detailLog.remark || "-" },
                            { key: "createdAt", label: "创建时间", children: formatDate(detailLog.createdAt) },
                            {
                                key: "extra",
                                label: "扩展信息",
                                children: detailLog.extra ? (
                                    <Typography.Paragraph copyable style={{ margin: 0, maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                                        {detailLog.extra}
                                    </Typography.Paragraph>
                                ) : (
                                    "-"
                                ),
                            },
                        ]}
                    />
                ) : null}
            </Modal>

            <Modal
                title="删除日志"
                open={Boolean(deletingLog)}
                onCancel={() => setDeletingLog(null)}
                onOk={async () => {
                    if (!deletingLog) return;
                    await deleteLog(deletingLog.id);
                    setDeletingLog(null);
                }}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定删除这条使用日志吗？
            </Modal>
        </main>
    );
}
