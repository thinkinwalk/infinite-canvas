"use client";

import { useEffect, useState } from "react";
import { App, Button, Card, Input, Space, Table, Tag } from "antd";
import { Check, RefreshCw, X } from "lucide-react";

import { fetchAdminCases, reviewAdminCase } from "@/services/api/admin";
import type { CaseApp } from "@/services/api/cases";
import { useUserStore } from "@/stores/use-user-store";

export default function AdminCasesPage() {
    const { message, modal } = App.useApp();
    const token = useUserStore((state) => state.token);
    const [items, setItems] = useState<CaseApp[]>([]);
    const [loading, setLoading] = useState(false);
    const [keyword, setKeyword] = useState("");

    const load = async () => {
        if (!token) return;
        setLoading(true);
        try {
            setItems((await fetchAdminCases(token, { keyword, pageSize: 100 })).items);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "获取案例失败");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void load();
    }, [token]);

    const review = (item: CaseApp, status: "published" | "rejected") => {
        if (!token) return;
        const submit = async (note: string) => {
            try {
                await reviewAdminCase(token, item.id, status, note);
                message.success(status === "published" ? "案例已发布" : "案例已驳回");
                await load();
            } catch (error) {
                message.error(error instanceof Error ? error.message : "审核失败");
            }
        };
        if (status === "rejected") {
            modal.confirm({ title: "驳回案例", content: <Input.TextArea id="case-review-note" placeholder="填写审核意见" />, onOk: () => submit((document.getElementById("case-review-note") as HTMLTextAreaElement | null)?.value || "") });
        } else {
            void submit("");
        }
    };

    return <Card title="案例审核" extra={<Space><Input placeholder="搜索案例" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => void load()} /><Button icon={<RefreshCw className="size-4" />} onClick={() => void load()} loading={loading}>刷新</Button></Space>}>
        <Table rowKey="id" loading={loading} dataSource={items} pagination={false} columns={[
            { title: "案例", dataIndex: "title", render: (value: string, item: CaseApp) => <Space direction="vertical" size={0}><span>{value}</span><span className="text-xs text-stone-500">{item.category || "未分类"}</span></Space> },
            { title: "类型", dataIndex: "isOfficial", render: (value: boolean) => <Tag color={value ? "blue" : "default"}>{value ? "官方" : "作者"}</Tag> },
            { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "pending" ? "orange" : value === "published" ? "green" : value === "rejected" ? "red" : "default"}>{value}</Tag> },
            { title: "价格", dataIndex: "priceCredits", render: (value: number) => `${value || 0} 算力点/次` },
            { title: "操作", key: "actions", render: (_: unknown, item: CaseApp) => item.status === "pending" ? <Space><Button type="primary" size="small" icon={<Check className="size-3.5" />} onClick={() => review(item, "published")}>发布</Button><Button danger size="small" icon={<X className="size-3.5" />} onClick={() => review(item, "rejected")}>驳回</Button></Space> : null },
        ]} />
    </Card>;
}

