"use client";

import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { ProTable, type ProColumns } from "@ant-design/pro-components";
import { Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Tag, Tooltip, Typography } from "antd";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";

import type { AdminRedemptionCode, CreateAdminRedemptionCodesRequest } from "@/services/api/admin";
import { isAdminRedemptionCodeExpired, useAdminRedemptionCodes } from "./use-admin-redemption-codes";

type RedemptionCodeFormValues = Omit<CreateAdminRedemptionCodesRequest, "expiresAt"> & {
    expiresAt?: Dayjs;
};

const statusOptions = [
    { label: "全部", value: "" },
    { label: "未使用", value: "enabled" },
    { label: "已禁用", value: "disabled" },
    { label: "已使用", value: "used" },
    { label: "已过期", value: "expired" },
];

function statusTag(item: AdminRedemptionCode) {
    if (isAdminRedemptionCodeExpired(item)) return <Tag color="orange">已过期</Tag>;
    if (item.status === "enabled") return <Tag color="green">未使用</Tag>;
    if (item.status === "disabled") return <Tag>已禁用</Tag>;
    if (item.status === "used") return <Tag color="blue">已使用</Tag>;
    return <Tag>{item.status}</Tag>;
}

function formatTime(value: string) {
    return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "-";
}

export default function AdminRedemptionCodesPage() {
    const { codes, keyword, status, page, pageSize, total, isLoading, searchCodes, changePage, changePageSize, resetFilters, refreshCodes, createCodes, updateStatus, deleteCode, cleanInvalid } = useAdminRedemptionCodes();
    const [form] = Form.useForm<RedemptionCodeFormValues>();
    const [keywordText, setKeywordText] = useState(keyword);
    const [statusText, setStatusText] = useState(status);
    const [creating, setCreating] = useState(false);
    const [createdCodes, setCreatedCodes] = useState<AdminRedemptionCode[]>([]);
    const [deletingCode, setDeletingCode] = useState<AdminRedemptionCode | null>(null);
    const [cleaning, setCleaning] = useState(false);

    useEffect(() => setKeywordText(keyword), [keyword]);
    useEffect(() => setStatusText(status), [status]);

    const generatedText = useMemo(() => createdCodes.map((item) => item.code).join("\n"), [createdCodes]);

    async function submitCreate() {
        const value = await form.validateFields();
        const result = await createCodes({
            name: value.name,
            credits: value.credits,
            count: value.count,
            expiresAt: value.expiresAt?.toDate().toISOString(),
            remark: value.remark,
        });
        setCreatedCodes(result);
        setCreating(false);
        form.resetFields();
    }

    const columns: ProColumns<AdminRedemptionCode>[] = [
        {
            title: "兑换码",
            dataIndex: "code",
            width: 260,
            render: (_, item) => <Typography.Text copyable>{item.code}</Typography.Text>,
        },
        {
            title: "名称",
            dataIndex: "name",
            width: 140,
            ellipsis: true,
        },
        {
            title: "点数",
            dataIndex: "credits",
            width: 90,
            align: "right",
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 96,
            render: (_, item) => statusTag(item),
        },
        {
            title: "使用用户",
            dataIndex: "usedBy",
            width: 220,
            render: (_, item) => (item.usedBy ? <Typography.Text copyable>{item.usedBy}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>),
        },
        {
            title: "使用时间",
            dataIndex: "usedAt",
            width: 180,
            render: (_, item) => <Typography.Text type="secondary">{formatTime(item.usedAt)}</Typography.Text>,
        },
        {
            title: "过期时间",
            dataIndex: "expiresAt",
            width: 180,
            render: (_, item) => <Typography.Text type="secondary">{formatTime(item.expiresAt)}</Typography.Text>,
        },
        {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 180,
            render: (_, item) => <Typography.Text type="secondary">{formatTime(item.createdAt)}</Typography.Text>,
        },
        {
            title: "操作",
            key: "actions",
            width: 148,
            align: "right",
            render: (_, item) => (
                <Space size={4}>
                    {item.status !== "used" ? (
                        <Button type="link" size="small" onClick={() => updateStatus(item.id, item.status === "enabled" ? "disabled" : "enabled")}>
                            {item.status === "enabled" ? "禁用" : "启用"}
                        </Button>
                    ) : null}
                    <Tooltip title="删除">
                        <Button danger type="text" size="small" icon={<DeleteOutlined />} onClick={() => setDeletingCode(item)} />
                    </Tooltip>
                </Space>
            ),
        },
    ];

    return (
        <main style={{ padding: 24 }}>
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card variant="borderless">
                    <Form layout="vertical">
                        <Row gutter={16} align="bottom">
                            <Col flex="360px">
                                <Form.Item label="关键词">
                                    <Input.Search value={keywordText} placeholder="搜索兑换码、名称、用户或备注" allowClear enterButton={<SearchOutlined />} onSearch={() => searchCodes(keywordText, statusText)} onChange={(event) => setKeywordText(event.target.value)} />
                                </Form.Item>
                            </Col>
                            <Col flex="180px">
                                <Form.Item label="状态">
                                    <Select options={statusOptions} value={statusText} onChange={setStatusText} />
                                </Form.Item>
                            </Col>
                            <Col flex="none">
                                <Form.Item>
                                    <Space>
                                        <Button
                                            onClick={() => {
                                                setKeywordText("");
                                                setStatusText("");
                                                resetFilters();
                                            }}
                                        >
                                            重置
                                        </Button>
                                        <Button type="primary" icon={<ReloadOutlined />} onClick={() => searchCodes(keywordText, statusText)}>
                                            查询
                                        </Button>
                                    </Space>
                                </Form.Item>
                            </Col>
                        </Row>
                    </Form>
                </Card>
                <ProTable<AdminRedemptionCode>
                    rowKey="id"
                    columns={columns}
                    dataSource={codes}
                    loading={isLoading}
                    search={false}
                    defaultSize="middle"
                    tableLayout="fixed"
                    cardProps={{ variant: "borderless" }}
                    headerTitle={
                        <Space>
                            <Typography.Text strong>兑换码</Typography.Text>
                            <Tag>{total} 个</Tag>
                        </Space>
                    }
                    options={{ density: true, setting: true, reload: () => void refreshCodes() }}
                    toolBarRender={() => [
                        <Button key="clean" icon={<DeleteOutlined />} onClick={() => setCleaning(true)}>
                            清理无效
                        </Button>,
                        <Button key="add" type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                            生成兑换码
                        </Button>,
                    ]}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 50, 100],
                        showTotal: (value) => `共 ${value} 个`,
                        onChange: (nextPage, nextPageSize) => (nextPageSize !== pageSize ? changePageSize(nextPageSize) : changePage(nextPage)),
                    }}
                />
            </Space>

            <Modal title="生成兑换码" open={creating} width={620} onCancel={() => setCreating(false)} onOk={() => void submitCreate()} okText="生成" cancelText="取消" destroyOnHidden>
                <Form form={form} layout="vertical" requiredMark={false} initialValues={{ count: 1, credits: 100 }}>
                    <Row gutter={14}>
                        <Col span={12}>
                            <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
                                <Input maxLength={20} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="credits" label="点数" rules={[{ required: true, message: "请输入点数" }]}>
                                <InputNumber min={1} precision={0} style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="count" label="数量" rules={[{ required: true, message: "请输入数量" }]}>
                                <InputNumber min={1} max={100} precision={0} style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="expiresAt" label="过期时间">
                                <DatePicker showTime style={{ width: "100%" }} />
                            </Form.Item>
                        </Col>
                        <Col span={24}>
                            <Form.Item name="remark" label="备注">
                                <Input.TextArea rows={3} />
                            </Form.Item>
                        </Col>
                    </Row>
                </Form>
            </Modal>

            <Modal title="生成结果" open={createdCodes.length > 0} footer={null} onCancel={() => setCreatedCodes([])}>
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <Typography.Text type="secondary">共生成 {createdCodes.length} 个兑换码</Typography.Text>
                    <Input.TextArea value={generatedText} rows={Math.min(10, Math.max(4, createdCodes.length))} readOnly />
                    <Typography.Text copyable={{ text: generatedText }}>
                        <CopyOutlined /> 复制全部兑换码
                    </Typography.Text>
                </Space>
            </Modal>

            <Modal
                title="删除兑换码"
                open={Boolean(deletingCode)}
                onCancel={() => setDeletingCode(null)}
                onOk={async () => {
                    if (!deletingCode) return;
                    await deleteCode(deletingCode.id);
                    setDeletingCode(null);
                }}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                确定删除这个兑换码吗？
            </Modal>

            <Modal
                title="清理无效兑换码"
                open={cleaning}
                onCancel={() => setCleaning(false)}
                onOk={async () => {
                    await cleanInvalid();
                    setCleaning(false);
                }}
                okText="清理"
                okButtonProps={{ danger: true }}
                cancelText="取消"
            >
                将删除已使用、已禁用和已过期的兑换码。
            </Modal>
        </main>
    );
}
