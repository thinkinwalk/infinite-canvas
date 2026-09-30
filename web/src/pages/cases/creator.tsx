import { useEffect, useState } from "react";
import { App, Button, Card, Empty, Tag } from "antd";
import { ArrowLeft, Send } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { AssetsHeader } from "@/pages/assets/assets-header";
import { fetchOwnedCases, submitCase, type CaseApp } from "@/services/api/cases";
import { useUserStore } from "@/stores/use-user-store";

export default function CreatorCasesPage() {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const navigate = useNavigate();
    const [items, setItems] = useState<CaseApp[]>([]);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        if (!token) {
            setItems([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            setItems((await fetchOwnedCases(token, { pageSize: 100 })).items);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "获取案例草稿失败");
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void load();
    }, [token]);

    const submit = async (item: CaseApp) => {
        if (!token) return;
        try {
            await submitCase(token, item.id);
            message.success("已提交审核");
            await load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "提交审核失败");
        }
    };

    return <main className="h-full overflow-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 text-stone-950 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)] dark:text-stone-100">
        <AssetsHeader active="cases" />
        <div className="mx-auto mt-8 flex w-full max-w-6xl flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
                <h2 className="text-lg font-semibold">我的案例</h2>
                <Button icon={<ArrowLeft className="size-4" />} onClick={() => navigate("/cases")}>案例市场</Button>
            </div>
            {!token ? <Empty description="请先登录查看我的案例" className="py-20" /> : loading ? <div className="py-20 text-center text-sm text-stone-500">加载中...</div> : items.length ? <div className="grid gap-4 md:grid-cols-2">{items.map((item) => <Card key={item.id} title={item.title} extra={<Tag color={item.status === "published" ? "green" : item.status === "pending" ? "orange" : item.status === "rejected" ? "red" : "default"}>{item.status}</Tag>}>
                <p className="min-h-10 text-sm text-stone-500">{item.description || "暂无说明"}</p>
                <div className="mt-4 flex items-center justify-between"><span className="text-xs text-stone-500">{item.priceCredits > 0 ? `${item.priceCredits} 算力点/次` : "免费"}</span>{item.status === "draft" || item.status === "rejected" ? <Button type="primary" size="small" icon={<Send className="size-3.5" />} onClick={() => void submit(item)}>提交审核</Button> : null}</div>
            </Card>)}</div> : <Empty description="还没有案例草稿，请先在画布菜单中选择“封装为案例”" />}
        </div>
    </main>;
}

